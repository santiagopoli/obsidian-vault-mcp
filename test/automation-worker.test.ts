import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import eventRuntimeMigration from "../migrations/0001_event_runtime.sql?raw";
import automationJobsMigration from "../migrations/0002_automation_jobs.sql?raw";
import { enqueueAutomationJob } from "../src/automationStore";
import { processAutomationJobMessage } from "../src/automationWorker";
import { automationConfigHash } from "../src/automations/configHash";
import { parseAutomationConfig } from "../src/automations/config";
import type { Env } from "../src/types";

const sourceSha = "b".repeat(40);
const sourceRevision = "a".repeat(40);
const originalFetch = globalThis.fetch;
const automationsYaml = `
version: 1
automations:
  - id: summarize-story
    enabled: true
    scopes: [vault:read, vault:write]
    match:
      vaults: [owner/vault]
      events: [note.created, note.updated]
      paths:
        include: ["Story/**/*.md"]
        exclude: ["_Automations/**"]
    loop: { allow_automation_origin: false, max_depth: 0 }
    target:
      kind: internal
      handler: summarize-note
      model: { provider: openai, name: test-model }
      input: { include_frontmatter: false, max_characters: 50000 }
      output: { directory: _Automations/Summaries, mode: managed, max_characters: 6000 }
`;

describe("automation worker", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-07-15",
      d1Databases: ["EVENT_DB"],
    });
    db = await runtime.getD1Database("EVENT_DB");
    await applyMigration(db, eventRuntimeMigration);
    await applyMigration(db, automationJobsMigration);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  });

  it("reads the exact source, calls the model without storage, and writes only the managed output", async () => {
    const automation = parseAutomationConfig(automationsYaml).automations[0]!;
    const enqueued = await enqueueAutomationJob(db, {
      automationId: automation.id,
      handler: automation.target.handler,
      configHash: await automationConfigHash(automation),
      eventId: "event-1",
      repositoryId: "42",
      vault: "owner/vault",
      sourcePath: "Story/Chapter.md",
      sourceRevision,
      sourceSha,
      outputPath: "_Automations/Summaries/Story/Chapter.summary.md",
    });
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (url.endsWith("/graphql")) {
        return Response.json({ data: { repository: { blob0: {
          oid: sourceSha,
          byteSize: 52,
          isBinary: false,
          text: "---\nprivate: metadata\n---\nThe canonical story text.",
        } } } });
      }
      if (url === "https://api.openai.com/v1/responses") {
        return Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "A faithful summary." }) }] }],
        });
      }
      if (method === "GET") return new Response("not found", { status: 404 });
      if (method === "PUT") {
        return Response.json({
          content: { path: "_Automations/Summaries/Story/Chapter.summary.md", sha: "c".repeat(40), html_url: "https://example.invalid/note" },
          commit: { sha: "d".repeat(40) },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    await processAutomationJobMessage(environment(db), { kind: "automation", runId: enqueued.job.runId });

    const stored = await db.prepare("SELECT status, error_code AS errorCode FROM automation_jobs WHERE run_id = ?")
      .bind(enqueued.job.runId).first<{ status: string; errorCode: string | null }>();
    expect(stored).toEqual({ status: "succeeded", errorCode: null });
    const modelRequest = JSON.parse(requests.find(({ url }) => url === "https://api.openai.com/v1/responses")?.body ?? "null") as Record<string, unknown>;
    expect(modelRequest).toEqual(expect.objectContaining({ store: false, input: "The canonical story text." }));
    const writeRequest = JSON.parse(requests.find(({ method }) => method === "PUT")?.body ?? "null") as { content: string };
    const written = new TextDecoder().decode(Uint8Array.from(atob(writeRequest.content), (character) => character.charCodeAt(0)));
    expect(written).toContain("obsidian-vault-mcp-managed");
    expect(written).toContain("A faithful summary.");
    expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  it("stops retrying after the bounded attempt budget", async () => {
    const automation = parseAutomationConfig(automationsYaml).automations[0]!;
    const enqueued = await enqueueAutomationJob(db, {
      automationId: automation.id,
      handler: automation.target.handler,
      configHash: await automationConfigHash(automation),
      eventId: "event-retry",
      repositoryId: "42",
      vault: "owner/vault",
      sourcePath: "Story/Retry.md",
      sourceRevision,
      sourceSha,
      outputPath: "_Automations/Summaries/Story/Retry.summary.md",
    });
    await db.prepare("UPDATE automation_jobs SET attempts = 5 WHERE run_id = ?").bind(enqueued.job.runId).run();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        return Response.json({ data: { repository: { blob0: {
          oid: sourceSha,
          byteSize: 12,
          isBinary: false,
          text: "Retry source",
        } } } });
      }
      if (url === "https://api.openai.com/v1/responses") return new Response("", { status: 429 });
      if ((init?.method ?? "GET") === "GET") return new Response("not found", { status: 404 });
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    await processAutomationJobMessage(environment(db), { kind: "automation", runId: enqueued.job.runId });

    const stored = await db.prepare("SELECT status, attempts, error_code AS errorCode, outbox_pending AS outboxPending FROM automation_jobs WHERE run_id = ?")
      .bind(enqueued.job.runId).first<{ status: string; attempts: number; errorCode: string; outboxPending: number }>();
    expect(stored).toEqual({
      status: "failed_terminal",
      attempts: 6,
      errorCode: "retry_exhausted:model_rate_limited",
      outboxPending: 0,
    });
  });
});

function environment(db: D1Database): Env {
  return {
    ALLOWED_GITHUB_USER_ID: "1",
    GITHUB_REPOSITORIES: "owner/vault",
    VAULT_ACCESS: "write",
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_VAULT_TOKEN: "github-token",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_WEBHOOK_HOOK_ID: "1",
    GITHUB_WEBHOOK_REPOSITORY_ID: "42",
    GITHUB_WEBHOOK_DEFAULT_BRANCH: "main",
    GITHUB_WEBHOOK_VAULT: "owner/vault",
    OPENAI_API_KEY: "openai-secret",
    AUTOMATIONS_YAML: automationsYaml,
    EVENT_DB: db,
    AUTOMATIONS_QUEUE: { send: async () => undefined } as unknown as Queue<never>,
  } as unknown as Env;
}

async function applyMigration(db: D1Database, source: string): Promise<void> {
  for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
