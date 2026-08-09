import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../web/src/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("web chat stream client", () => {
  it("retains partial usage and tool activity when the stream disconnects", async () => {
    const encoder = new TextEncoder();
    const usage = { requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 10, cacheWriteTokens: 0, reasoningTokens: 8 };
    const trace = { id: "step_1", step: 1, tool: "read_notes" as const, status: "completed" as const, input: { paths: ["Canon/Luz.md"] }, summary: "Read 1 note", notes: [{ path: "Canon/Luz.md", sha: "a".repeat(40) }] };
    const chunks = [
      `${JSON.stringify({ type: "usage", usage })}\n`,
      `${JSON.stringify({ type: "tool", trace })}\n`,
    ];
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(encoder.encode(chunk));
        else controller.error(new Error("connection reset"));
      },
    }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } })) as typeof fetch;

    const promise = chat("123", "csrf", {
      question: "Question",
      scope: "vault",
      history: [],
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
    });

    await expect(promise).rejects.toMatchObject({
      code: "agent_stream_interrupted",
      usage,
      trace: [trace],
    });
  });
});
