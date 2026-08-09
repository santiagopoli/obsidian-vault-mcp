import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import webPortalMigration from "../migrations/0003_web_portal.sql?raw";
import webChatLeasesMigration from "../migrations/0004_web_chat_leases.sql?raw";
import vaultSyncMigration from "../migrations/0005_vault_sync.sql?raw";
import { WebApiHandler } from "../src/webApi";
import { createWebSession } from "../src/webSession";
import type { Env } from "../src/types";

const originalFetch = globalThis.fetch;

describe("web API authorization", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-07-15",
      d1Databases: ["EVENT_DB"],
    });
    db = await runtime.getD1Database("EVENT_DB");
    for (const statement of `${webPortalMigration}\n${webChatLeasesMigration}\n${vaultSyncMigration}`.split(";").map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    env = {
      EVENT_DB: db,
      ALLOWED_GITHUB_USER_ID: "123456",
      GITHUB_REPOSITORIES: "owner/vault",
      GITHUB_VAULT_TOKEN: "github-token",
      VAULT_ACCESS: "read",
      WEB_CHAT_ENABLED: "true",
      OPENAI_API_KEY: "openai-key",
    } as Env;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  });

  it("returns a private unauthenticated session response without touching GitHub", async () => {
    const response = await WebApiHandler.request("/session", {}, env);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ authenticated: false, login_url: "/web/login" });
  });

  it("returns the server allowlist and configured default to an authenticated browser", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    env.OPENAI_CHAT_MODEL = "gpt-5.6-terra";

    const response = await WebApiHandler.request("/session", { headers: { Cookie: cookie } }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      chat_enabled: true,
      chat: {
        enabled: true,
        provider: "openai",
        models: [
          { id: "gpt-5.6-sol", label: "Sol", description: "Highest capability" },
          { id: "gpt-5.6-terra", label: "Terra", description: "Balanced intelligence and cost" },
          { id: "gpt-5.6-luna", label: "Luna", description: "Fast and efficient" },
        ],
        reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
        default_model: "gpt-5.6-terra",
        default_reasoning_effort: "medium",
      },
    }));
  });

  it("rejects cross-origin and missing-CSRF chat before vault lookup", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    const crossOrigin = await WebApiHandler.request("https://vault.example/vaults/123/chat", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://attacker.example",
        "X-CSRF-Token": created.session.csrfSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: "hello" }),
    }, env);
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: "origin_rejected" });

    const missingCsrf = await WebApiHandler.request("https://vault.example/vaults/123/chat", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://vault.example", "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello" }),
    }, env);
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toEqual({ error: "csrf_rejected" });
  });

  it("rejects an incomplete folder scope before quota, GitHub, or model work", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await WebApiHandler.request("https://vault.example/vaults/123/chat", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://vault.example", "X-CSRF-Token": created.session.csrfSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello", scope: "folder", history: [], model: "gpt-5.6-sol", reasoning_effort: "medium" }),
    }, env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_chat_request" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM web_chat_usage").first()).toEqual({ count: 0 });
  });

  it("runs the selected model and reasoning level and returns aggregate agent metadata", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    let openAiBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
      if (url.includes("/repos/owner/vault/git/trees/main")) return Response.json({
        sha: "c".repeat(40),
        truncated: false,
        tree: [{ path: "Canon/Luz.md", type: "blob", sha: "a".repeat(40), size: 20 }],
      });
      if (url === "https://api.openai.com/v1/responses") {
        openAiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ answer: "Necesito investigar el vault.", citation_paths: [] }) }] }],
          usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52, output_tokens_details: { reasoning_tokens: 5 } },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const response = await WebApiHandler.request("https://vault.example/vaults/123/chat", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://vault.example",
        "X-CSRF-Token": created.session.csrfSecret,
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        question: "Resume la historia",
        scope: "vault",
        history: [],
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
      }),
    }, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(openAiBody).toEqual(expect.objectContaining({ model: "gpt-5.6-luna", reasoning: { effort: "xhigh", context: "current_turn" }, store: false }));
    expect(events.map(({ type }) => type)).toEqual(["status", "model_request", "usage", "result"]);
    expect(events.at(-1)).toEqual({
      type: "result",
      reply: expect.objectContaining({
        trace: [],
        usage: expect.objectContaining({ totalTokens: 52, reasoningTokens: 5, requests: 1 }),
        agent: { model: "gpt-5.6-luna", reasoning_effort: "xhigh", tool_calls: 0, model_requests: 1 },
      }),
    });
  });

  it("allows only one in-flight agent turn for the owner", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    let resolveModel!: (response: Response) => void;
    const pendingModel = new Promise<Response>((resolve) => { resolveModel = resolve; });
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
      if (url.includes("/repos/owner/vault/git/trees/main")) return Response.json({ sha: "c".repeat(40), truncated: false, tree: [] });
      if (url === "https://api.openai.com/v1/responses") return pendingModel;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const request = () => WebApiHandler.request("https://vault.example/vaults/123/chat", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://vault.example", "X-CSRF-Token": created.session.csrfSecret, "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ question: "hello", scope: "vault", history: [], model: "gpt-5.6-sol", reasoning_effort: "low" }),
    }, env);

    const leaseStart = Math.floor(Date.now() / 1_000);
    const first = await request();
    const lease = await db.prepare("SELECT expires_at FROM web_chat_leases WHERE github_user_id = '123456'").first<{ expires_at: number }>();
    const second = await request();

    expect(lease?.expires_at).toBeGreaterThanOrEqual(leaseStart + 300);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "chat_already_running" });
    resolveModel(Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ answer: "Done", citation_paths: [] }) }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    expect((await first.text()).trim().split("\n").map((line) => JSON.parse(line).type).at(-1)).toBe("result");
  });

  it("returns the same not-found result for an unregistered repository ID", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
      throw new Error("unexpected request");
    }) as typeof fetch;

    const response = await WebApiHandler.request("https://vault.example/vaults/999/notes", {
      headers: { Cookie: cookie },
    }, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "vault_not_found" });
  });

  it("keeps graph metadata owner-only without contacting GitHub for anonymous requests", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await WebApiHandler.request("https://vault.example/vaults/123/graph", {}, env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the exact vault graph and finds deterministic shortest paths", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    const revision = "e".repeat(40);
    const documents = [
      { path: "Home.md", sha: "a".repeat(40), content: "---\ntitle: Story Home\ntags: [index]\n---\n[[People/Ada]] [[Missing]]" },
      { path: "People/Ada.md", sha: "b".repeat(40), content: "# Ada\n[[Scenes/End]]" },
      { path: "Scenes/End.md", sha: "c".repeat(40), content: "# End" },
      { path: "Solo.md", sha: "d".repeat(40), content: "[[Solo]]" },
    ];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
      if (url.includes("/repos/owner/vault/git/trees/main")) return Response.json({
        sha: revision,
        truncated: false,
        tree: documents.map(({ path, sha, content }) => ({ path, sha, type: "blob", size: content.length })),
      });
      if (url === "https://api.github.com/graphql") return Response.json({
        data: {
          repository: Object.fromEntries(documents.map((document, index) => [`blob${index}`, {
            oid: document.sha,
            byteSize: document.content.length,
            isBinary: false,
            text: document.content,
          }])),
        },
      });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const graphResponse = await WebApiHandler.request("https://vault.example/vaults/123/graph", {
      headers: { Cookie: cookie },
    }, env);
    expect(graphResponse.status).toBe(200);
    expect(await graphResponse.json()).toEqual({
      revision,
      stats: { nodes: 4, edges: 3, orphans: 1, unresolved: 1 },
      truncated: false,
      nodes: [
        { path: "Home.md", title: "Story Home", tags: ["index"], outgoing_count: 1, backlink_count: 0, orphan: false },
        { path: "People/Ada.md", title: "Ada", tags: [], outgoing_count: 1, backlink_count: 1, orphan: false },
        { path: "Scenes/End.md", title: "End", tags: [], outgoing_count: 0, backlink_count: 1, orphan: false },
        { path: "Solo.md", title: "Solo", tags: [], outgoing_count: 1, backlink_count: 1, orphan: true },
      ],
      edges: [
        { source: "Home.md", target: "People/Ada.md", kind: "wikilink", embedded: false },
        { source: "People/Ada.md", target: "Scenes/End.md", kind: "wikilink", embedded: false },
        { source: "Solo.md", target: "Solo.md", kind: "wikilink", embedded: false },
      ],
      unresolved_count: 1,
    });

    const pathResponse = await WebApiHandler.request(
      "https://vault.example/vaults/123/graph/path?from=Home.md&to=Scenes%2FEnd.md&direction=outgoing&max_depth=4",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(pathResponse.status).toBe(200);
    expect(await pathResponse.json()).toEqual({
      revision,
      found: true,
      path: ["Home.md", "People/Ada.md", "Scenes/End.md"],
      distance: 2,
      direction: "outgoing",
      max_depth: 4,
    });
  });

  it("validates graph path queries and hides unknown graph notes", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    globalThis.fetch = graphFetch([{ path: "Home.md", sha: "a".repeat(40), content: "" }]);

    const invalid = await WebApiHandler.request(
      "https://vault.example/vaults/123/graph/path?from=Home.md&to=Missing.md&direction=sideways",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_graph_direction" });

    const missing = await WebApiHandler.request(
      "https://vault.example/vaults/123/graph/path?from=Home.md&to=Missing.md",
      { headers: { Cookie: cookie } },
      env,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "graph_note_not_found" });
  });

  it("starts Google sync only with the owner session, same-origin CSRF, and narrow Drive scope", async () => {
    const created = await createWebSession(db, "123456", "owner");
    const cookie = created.cookie.split(";", 1)[0] ?? "";
    env.GOOGLE_CLIENT_ID = "google-client";
    env.GOOGLE_CLIENT_SECRET = "google-secret";
    env.SYNC_CREDENTIALS_KEY = "A".repeat(43);
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
      throw new Error(`unexpected request: ${String(input)}`);
    }) as typeof fetch;

    const rejected = await WebApiHandler.request("https://vault.example/vaults/123/sync/google/start", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://attacker.example", "X-CSRF-Token": created.session.csrfSecret },
    }, env);
    expect(rejected.status).toBe(403);

    const response = await WebApiHandler.request("https://vault.example/vaults/123/sync/google/start", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://vault.example", "X-CSRF-Token": created.session.csrfSecret },
    }, env);
    expect(response.status).toBe(200);
    const authorizationUrl = new URL((await response.json<{ authorization_url: string }>()).authorization_url);
    expect(authorizationUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM vault_sync_oauth_states").first()).toEqual({ count: 1 });

    const callback = await WebApiHandler.request(`https://vault.example/sync/google/callback?error=access_denied&state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}`, {
      headers: { Cookie: cookie },
    }, env);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?sync=denied&sync_vault=123");
  });
});

function graphFetch(documents: Array<{ path: string; sha: string; content: string }>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 123, default_branch: "main" });
    if (url.includes("/repos/owner/vault/git/trees/main")) return Response.json({
      sha: "f".repeat(40),
      truncated: false,
      tree: documents.map(({ path, sha, content }) => ({ path, sha, type: "blob", size: content.length })),
    });
    if (url === "https://api.github.com/graphql") return Response.json({
      data: {
        repository: Object.fromEntries(documents.map((document, index) => [`blob${index}`, {
          oid: document.sha,
          byteSize: document.content.length,
          isBinary: false,
          text: document.content,
        }])),
      },
    });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}
