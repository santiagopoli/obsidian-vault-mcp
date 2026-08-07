import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import eventRuntimeMigration from "../migrations/0001_event_runtime.sql?raw";
import automationJobsMigration from "../migrations/0002_automation_jobs.sql?raw";
import { processVaultEventMessage } from "../src/eventQueue";
import type { AutomationJobQueueMessage, Env } from "../src/types";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const storyBeforeSha = "1".repeat(40);
const storyHeadSha = "2".repeat(40);
const originalFetch = globalThis.fetch;

describe("vault event queue", () => {
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
    await db.prepare(`
      INSERT INTO vault_states (repository_id, vault, revision, updated_at)
      VALUES ('42', 'owner/vault', ?, '2026-08-07T00:00:00.000Z')
    `).bind(revisionA).run();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  });

  it("reconciles checkpoint to HEAD so a delayed webhook cannot skip a relevant change", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/vault")) {
        return Response.json({ id: 42, default_branch: "main" });
      }
      if (url.includes(`/git/trees/${revisionA}`)) {
        return Response.json({ sha: revisionA, truncated: false, tree: [
          { path: "Story/Chapter.md", type: "blob", sha: storyBeforeSha, size: 10 },
        ] });
      }
      if (url.includes("/git/trees/main")) {
        return Response.json({ sha: revisionC, truncated: false, tree: [
          { path: "Other.md", type: "blob", sha: "3".repeat(40), size: 10 },
          { path: "Story/Chapter.md", type: "blob", sha: storyHeadSha, size: 20 },
        ] });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;
    const sent: AutomationJobQueueMessage[] = [];
    const env = environment(db, sent);

    await processVaultEventMessage(env, {
      kind: "vault-event",
      deliveryId: "delayed-a-to-b",
      repositoryId: "42",
      vault: "owner/vault",
      previousRevision: revisionA,
      afterRevision: revisionB,
    });

    const state = await db.prepare("SELECT revision FROM vault_states WHERE repository_id = '42'")
      .first<{ revision: string }>();
    const jobs = await db.prepare(`
      SELECT source_revision AS sourceRevision, source_sha AS sourceSha,
        source_path AS sourcePath, output_path AS outputPath
      FROM automation_jobs
    `).all<{ sourceRevision: string; sourceSha: string; sourcePath: string; outputPath: string }>();
    expect(state?.revision).toBe(revisionC);
    expect(jobs.results).toEqual([{
      sourceRevision: revisionC,
      sourceSha: storyHeadSha,
      sourcePath: "Story/Chapter.md",
      outputPath: "_Automations/Summaries/Story/Chapter.summary.md",
    }]);
    expect(sent).toEqual([{ kind: "automation", runId: expect.stringContaining("automation-job:v1:summarize-story:") }]);

    await processVaultEventMessage(env, {
      kind: "vault-event",
      deliveryId: "later-b-to-c",
      repositoryId: "42",
      vault: "owner/vault",
      previousRevision: revisionB,
      afterRevision: revisionC,
    });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM automation_jobs").first<{ count: number }>())?.count).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

function environment(db: D1Database, sent: AutomationJobQueueMessage[]): Env {
  return {
    GITHUB_REPOSITORIES: "owner/vault",
    GITHUB_VAULT_TOKEN: "github-token",
    GITHUB_WEBHOOK_HOOK_ID: "1",
    AUTOMATIONS_YAML: `
version: 1
automations:
  - id: summarize-story
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
      model: { provider: openai, name: gpt-5.6-sol }
      input: { include_frontmatter: false, max_characters: 50000 }
      output: { directory: _Automations/Summaries, mode: managed, max_characters: 6000 }
`,
    EVENT_DB: db,
    AUTOMATIONS_QUEUE: { send: async (message: AutomationJobQueueMessage) => { sent.push(message); } },
  } as unknown as Env;
}

async function applyMigration(db: D1Database, source: string): Promise<void> {
  for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
}
