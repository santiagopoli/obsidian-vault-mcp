import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import webPortalMigration from "../migrations/0003_web_portal.sql?raw";
import webChatLeasesMigration from "../migrations/0004_web_chat_leases.sql?raw";
import vaultSyncMigration from "../migrations/0005_vault_sync.sql?raw";
import {
  consumeWebAuthState,
  cleanupWebPortalState,
  createWebAuthState,
  createWebSession,
  readWebSession,
  revokeWebSession,
  secureEquals,
} from "../src/webSession";

describe("web portal sessions", () => {
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
    for (const statement of `${webPortalMigration}\n${webChatLeasesMigration}\n${vaultSyncMigration}`.split(";").map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  });

  afterEach(async () => runtime.dispose());

  it("atomically consumes OAuth state exactly once under contention", async () => {
    const created = await createWebAuthState(db);
    const results = await Promise.all([
      consumeWebAuthState(db, created.state),
      consumeWebAuthState(db, created.state),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(created.cookie).toContain("__Host-obsidian_web_state=");
    expect(created.cookie).toContain("HttpOnly; Secure; SameSite=Lax");
  });

  it("stores only the session hash and revokes the browser cookie", async () => {
    const created = await createWebSession(db, "123456", "vault-owner");
    const cookie = created.cookie.split(";", 1)[0];
    const rawToken = cookie?.split("=")[1];
    const stored = await db.prepare("SELECT session_hash FROM web_sessions").first<{ session_hash: string }>();

    expect(stored?.session_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.session_hash).not.toBe(rawToken);
    await expect(readWebSession(db, cookie)).resolves.toMatchObject({
      githubUserId: "123456",
      githubLogin: "vault-owner",
    });
    await revokeWebSession(db, cookie);
    await expect(readWebSession(db, cookie)).resolves.toBeUndefined();
  });

  it("compares CSRF material without accepting length mismatches", () => {
    expect(secureEquals("same", "same")).toBe(true);
    expect(secureEquals("same", "different")).toBe(false);
    expect(secureEquals("same", "samf")).toBe(false);
  });

  it("prunes expired ephemeral state and old quota counters", async () => {
    await db.batch([
      db.prepare("INSERT INTO web_auth_states (state_hash, expires_at) VALUES ('expired', 1)"),
      db.prepare("INSERT INTO web_sessions (session_hash, github_user_id, github_login, csrf_secret, created_at, expires_at) VALUES ('expired', '1', 'owner', 'csrf', 1, 1)"),
      db.prepare("INSERT INTO web_chat_usage (github_user_id, usage_day, request_count) VALUES ('1', '2020-01-01', 1)"),
      db.prepare("INSERT INTO web_chat_leases (github_user_id, lease_id, expires_at) VALUES ('1', 'expired', 1)"),
    ]);
    await cleanupWebPortalState(db, new Date("2026-08-08T00:00:00Z"));
    expect(await db.prepare("SELECT COUNT(*) AS count FROM web_auth_states").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM web_sessions").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM web_chat_usage").first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM web_chat_leases").first<{ count: number }>()).toEqual({ count: 0 });
  });
});
