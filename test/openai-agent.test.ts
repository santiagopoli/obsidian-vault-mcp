import { describe, expect, it, vi } from "vitest";
import { runVaultAgent, VaultAgentProviderError } from "../src/openaiAgent";
import type { VaultAgentToolbox } from "../src/vaultAgentTools";

describe("OpenAI vault agent", () => {
  it("replays reasoning and tool calls, validates citations, and sums every request", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const execute = vi.fn().mockResolvedValue({
      output: JSON.stringify({ notes: [{ path: "Canon/Luz.md", sha: "a".repeat(40), content: "Luz viaja." }] }),
      trace: { id: "step_1", step: 1, tool: "read_notes", status: "completed", input: { paths: ["Canon/Luz.md"] }, summary: "Read 1 note", notes: [{ path: "Canon/Luz.md", sha: "a".repeat(40) }] },
    });
    const toolbox = {
      tree: { revision: "b".repeat(40), files: [] },
      availableTools: () => [{ type: "function", name: "read_notes", parameters: {}, strict: true }],
      canExecute: (name: string) => name === "read_notes",
      execute,
      evidence: () => new Map([["Canon/Luz.md", { path: "Canon/Luz.md", sha: "a".repeat(40) }]]),
    } as unknown as VaultAgentToolbox;
    const responses = [
      Response.json({
        status: "completed",
        output: [
          { type: "reasoning", encrypted_content: "opaque-reasoning" },
          { type: "function_call", call_id: "call_1", name: "read_notes", arguments: JSON.stringify({ paths: ["Canon/Luz.md"] }) },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 12 } },
      }),
      Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ answer: "Luz viaja.", citation_paths: ["Canon/Luz.md", "Invented.md"] }) }] }],
        usage: { input_tokens: 140, output_tokens: 30, total_tokens: 170, output_tokens_details: { reasoning_tokens: 8 } },
      }, { headers: { "x-request-id": "req_agent" } }),
    ];

    const result = await runVaultAgent({
      apiKey: "secret-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      question: "¿Qué hace Luz?",
      history: [],
      scope: "vault",
      safetyIdentifier: "safe-user",
      toolbox,
    }, vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift() ?? Response.error();
    }) as typeof fetch);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(expect.objectContaining({
      model: "gpt-5.6-terra",
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", context: "current_turn" },
      parallel_tool_calls: false,
      truncation: "disabled",
    }));
    expect(JSON.stringify(requests[0]?.text)).not.toContain("uniqueItems");
    expect(JSON.stringify(requests[1]?.input)).toContain("opaque-reasoning");
    expect(requests[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]));
    expect(execute).toHaveBeenCalledWith("read_notes", JSON.stringify({ paths: ["Canon/Luz.md"] }), 1);
    expect(result.citations).toEqual([{ path: "Canon/Luz.md", sha: "a".repeat(40) }]);
    expect(result.trace).toHaveLength(1);
    expect(result.usage).toEqual({ requests: 2, inputTokens: 240, outputTokens: 50, totalTokens: 290, cachedInputTokens: 10, cacheWriteTokens: 5, reasoningTokens: 20 });
    expect(result.requestId).toBe("req_agent");
  });

  it("classifies incomplete output separately from malformed output", async () => {
    const toolbox = {
      tree: { revision: "b".repeat(40), files: [] },
      availableTools: () => [],
      evidence: () => new Map(),
    } as unknown as VaultAgentToolbox;
    const promise = runVaultAgent({
      apiKey: "key", model: "gpt-5.6-sol", reasoningEffort: "max", question: "Hard task", history: [], scope: "vault", safetyIdentifier: "safe", toolbox,
    }, async () => Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 } }));
    await expect(promise).rejects.toMatchObject({ code: "model_output_limit", status: 502 });
  });

  it("enforces a cumulative output-token ceiling across model rounds", async () => {
    const toolbox = {
      tree: { revision: "b".repeat(40), files: [] },
      availableTools: () => [{ type: "function", name: "list_notes", parameters: {}, strict: true }],
      canExecute: () => true,
      execute: vi.fn().mockResolvedValue({ output: "{}", trace: { id: "step", step: 1, tool: "list_notes", status: "completed", input: {}, summary: "Listed notes", notes: [] } }),
      evidence: () => new Map(),
    } as unknown as VaultAgentToolbox;
    let requests = 0;
    const promise = runVaultAgent({
      apiKey: "key", model: "gpt-5.6-sol", reasoningEffort: "max", question: "Deep research", history: [], scope: "vault", safetyIdentifier: "safe", toolbox,
    }, vi.fn(async () => {
      requests += 1;
      return Response.json({
        status: "completed",
        output: [{ type: "function_call", call_id: `call_${requests}`, name: "list_notes", arguments: JSON.stringify({ prefix: null, limit: 10, offset: 0 }) }],
        usage: { input_tokens: 100, output_tokens: 12_000, total_tokens: 12_100 },
      });
    }) as typeof fetch);

    await expect(promise).rejects.toMatchObject({ code: "agent_token_limit", status: 422 });
    expect(requests).toBe(2);
  });

  it("classifies invalid JSON and network failures as safe provider errors", async () => {
    const toolbox = { tree: { revision: "b".repeat(40), files: [] }, availableTools: () => [], evidence: () => new Map() } as unknown as VaultAgentToolbox;
    const input = { apiKey: "key", model: "gpt-5.6-sol" as const, reasoningEffort: "low" as const, question: "Question", history: [], scope: "vault" as const, safetyIdentifier: "safe", toolbox };

    await expect(runVaultAgent(input, async () => new Response("not-json", { status: 200 }))).rejects.toMatchObject({ code: "model_response_invalid", status: 502 });
    await expect(runVaultAgent(input, async () => { throw new TypeError("network detail"); })).rejects.toMatchObject({ code: "model_unavailable", status: 503 });
  });

  it("stops before executing model-requested tools when the turn is cancelled", async () => {
    const controller = new AbortController();
    const execute = vi.fn();
    const toolbox = {
      tree: { revision: "b".repeat(40), files: [] },
      availableTools: () => [{ type: "function", name: "list_notes", parameters: {}, strict: true }],
      canExecute: () => true,
      execute,
      evidence: () => new Map(),
    } as unknown as VaultAgentToolbox;
    const promise = runVaultAgent({
      apiKey: "key", model: "gpt-5.6-sol", reasoningEffort: "low", question: "Question", history: [], scope: "vault", safetyIdentifier: "safe", toolbox, signal: controller.signal,
      onProgress: (event) => { if (event.type === "usage") controller.abort(); },
    }, async () => Response.json({
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "list_notes", arguments: JSON.stringify({ prefix: null, limit: 10, offset: 0 }) }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }));

    await expect(promise).rejects.toMatchObject({ code: "agent_cancelled", status: 408 });
    expect(execute).not.toHaveBeenCalled();
  });
});
