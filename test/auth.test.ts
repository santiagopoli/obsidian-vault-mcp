import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import webPortalMigration from "../migrations/0003_web_portal.sql?raw";
import { readScope, selectGrantedScopes, writeScope } from "../src/authPolicy";
import { consumeConsentState, storeConsentState } from "../src/consentState";
import { allowedGitHubUserId, vaultAccess } from "../src/config";
import { isLoopbackRedirect, loopbackHandoffPage } from "../src/loopbackRedirect";
import type { Env } from "../src/types";

describe("OAuth scopes", () => {
  it("defaults a read-only instance to read access", () => {
    expect(selectGrantedScopes([], "read")).toEqual([readScope]);
  });

  it("defaults a writable instance to explicit read and write access", () => {
    expect(selectGrantedScopes([], "write")).toEqual([readScope, writeScope]);
  });

  it("never grants write access from a read-only instance", () => {
    expect(selectGrantedScopes([readScope, writeScope], "read")).toEqual([readScope]);
  });

  it("rejects unknown scopes", () => {
    expect(() => selectGrantedScopes(["admin"], "write")).toThrow("Unsupported OAuth scope");
  });
});

describe("owner authorization configuration", () => {
  it("uses an immutable numeric GitHub user ID", () => {
    expect(allowedGitHubUserId({ ALLOWED_GITHUB_USER_ID: "12345678" } as Env)).toBe("12345678");
    expect(() => allowedGitHubUserId({ ALLOWED_GITHUB_USER_ID: "example-user" } as Env)).toThrow("numeric GitHub user ID");
  });

  it("accepts only explicit read or write modes", () => {
    expect(vaultAccess({ VAULT_ACCESS: "read" } as Env)).toBe("read");
    expect(vaultAccess({ VAULT_ACCESS: "write" } as Env)).toBe("write");
    expect(() => vaultAccess({ VAULT_ACCESS: "admin" } as unknown as Env)).toThrow("VAULT_ACCESS");
  });
});

describe("OAuth consent", () => {
  it("prevents replay after consuming a valid token without browser state", async () => {
    const consentId = "7b805566-b0f1-4ff3-93f7-5bf80f3e78e2";
    const { db, runtime } = await consentDatabase();
    await storeConsentState(db, consentId, {
      oauthRequest: { clientId: "codex-client" },
      grantedScopes: [readScope, writeScope],
      githubUserId: "12345678",
    }, 600);

    const first = await consumeConsentState<Record<string, unknown>>(db, consentId);

    expect(first.status).toBe("valid");
    const replay = await consumeConsentState<Record<string, unknown>>(db, consentId);

    expect(replay.status).toBe("expired");
    await runtime.dispose();
  });

  it("keeps overlapping consent flows independent", async () => {
    const firstId = "2b5d922f-1433-4ec7-9947-38db96d5b04d";
    const secondId = "4ac5e8be-f3e2-47e5-8ac9-ac3ea4f31730";
    const { db, runtime } = await consentDatabase();
    await storeConsentState(db, firstId, { client: "Codex A" }, 600);
    await storeConsentState(db, secondId, { client: "Codex B" }, 600);

    const second = await consumeConsentState<{ client: string }>(db, secondId);
    const first = await consumeConsentState<{ client: string }>(db, firstId);

    expect(second).toEqual({ status: "valid", value: { client: "Codex B" } });
    expect(first).toEqual({ status: "valid", value: { client: "Codex A" } });
    await runtime.dispose();
  });

  it("rejects malformed consent tokens without reading storage", async () => {
    const { db, runtime } = await consentDatabase();

    expect(await consumeConsentState(db, "not-a-token")).toEqual({ status: "invalid" });
    await runtime.dispose();
  });

  it("atomically permits only one concurrent consent submission", async () => {
    const { db, runtime } = await consentDatabase();
    const consentId = "9e88634e-f4a1-45c0-9467-d4fb474ec364";
    await storeConsentState(db, consentId, { client: "Codex" }, 600);
    const contenders = await Promise.all([
      consumeConsentState(db, consentId),
      consumeConsentState(db, consentId),
    ]);
    expect(contenders.filter((result) => result.status === "valid")).toHaveLength(1);
    await runtime.dispose();
  });
});

async function consentDatabase(): Promise<{ runtime: Miniflare; db: D1Database }> {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-07-15",
    d1Databases: ["EVENT_DB"],
  });
  const db = await runtime.getD1Database("EVENT_DB");
  for (const statement of webPortalMigration.split(";").map((sql) => sql.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  return { runtime, db };
}

describe("OAuth loopback handoff", () => {
  it("recognizes local callbacks without trusting lookalike hosts", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:56904/callback?code=secret")).toBe(true);
    expect(isLoopbackRedirect("http://127.23.45.67/callback")).toBe(true);
    expect(isLoopbackRedirect("http://localhost:56904/callback")).toBe(true);
    expect(isLoopbackRedirect("http://[::1]:56904/callback")).toBe(true);
    expect(isLoopbackRedirect("https://localhost.attacker.example/callback")).toBe(false);
    expect(isLoopbackRedirect("https://127.0.0.1.attacker.example/callback")).toBe(false);
    expect(isLoopbackRedirect("ftp://localhost/callback")).toBe(false);
  });

  it("renders a safe explicit handoff link", () => {
    const page = loopbackHandoffPage("http://127.0.0.1:56904/callback?code=one&state=two");

    expect(page).toContain("Access granted");
    expect(page).toContain("Finish in Codex");
    expect(page).toContain("code=one&amp;state=two");
    expect(page).toContain('target="_blank" rel="noopener noreferrer"');
  });
});
