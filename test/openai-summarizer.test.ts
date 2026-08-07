import { describe, expect, it } from "vitest";
import { AutomationProviderError, summarizeWithOpenAI } from "../src/automations/openaiSummarizer";

const request = {
  apiKey: "test-key",
  model: "gpt-test",
  content: "# Hero\n\nA careful source note.",
  maxCharacters: 1_000,
  automationId: "summarize-canon",
  eventId: "event-1",
};

describe("OpenAI automation summarizer", () => {
  it("uses a stored-disabled structured response without exposing the key in the body", async () => {
    let captured: RequestInit | undefined;
    const result = await summarizeWithOpenAI(request, async (_input, init) => {
      captured = init;
      return Response.json(completed({ summary: "A faithful summary." }), {
        headers: { "x-request-id": "req_123" },
      });
    });

    expect(result).toEqual({
      summary: "A faithful summary.",
      requestId: "req_123",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const body = JSON.parse(String(captured?.body));
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.metadata.automation_id).toBe("summarize-canon");
    expect(body.metadata.event_id_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(captured?.body)).not.toContain("event-1");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "note_summary", strict: true });
    expect(String(captured?.body)).not.toContain("test-key");
    expect((captured?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it.each([
    [401, "model_auth_failed", false],
    [404, "model_not_found", false],
    [429, "model_rate_limited", true],
    [500, "model_unavailable", true],
    [400, "model_request_invalid", false],
  ] as const)("classifies HTTP %s", async (status, code, retryable) => {
    await expect(summarizeWithOpenAI(request, async () => new Response("", { status })))
      .rejects.toMatchObject({ code, retryable });
  });

  it("rejects incomplete, malformed, empty, and oversized output", async () => {
    const invalid = [
      { status: "incomplete", output: [] },
      completedText("not json"),
      completed({ summary: "" }),
      completed({ summary: "x".repeat(1_001) }),
    ];
    for (const payload of invalid) {
      await expect(summarizeWithOpenAI(request, async () => Response.json(payload)))
        .rejects.toBeInstanceOf(AutomationProviderError);
    }
  });

  it("does not require or log a response body for provider errors", async () => {
    await expect(summarizeWithOpenAI({ ...request, apiKey: "" }, async () => {
      throw new Error("must not call");
    })).rejects.toMatchObject({ code: "model_auth_failed", retryable: false });
  });
});

function completed(value: unknown) {
  return completedText(JSON.stringify(value));
}

function completedText(text: string) {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
