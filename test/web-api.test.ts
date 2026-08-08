import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import webPortalMigration from "../migrations/0003_web_portal.sql?raw";
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
    for (const statement of webPortalMigration.split(";").map((sql) => sql.trim()).filter(Boolean)) {
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
});
