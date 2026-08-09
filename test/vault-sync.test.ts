import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import automationJobsMigration from "../migrations/0002_automation_jobs.sql?raw";
import vaultSyncMigration from "../migrations/0005_vault_sync.sql?raw";
import { decryptCredential, encryptCredential } from "../src/credentialCipher";
import { googleAuthorizationUrl } from "../src/googleDrive";
import { processAutomationJobMessage } from "../src/automationWorker";
import { consumeSyncOAuthState, createSyncOAuthState, getSyncDestination, saveGoogleDriveDestination } from "../src/syncStore";
import { credentialContext, enqueueSyncSnapshot } from "../src/vaultSync";
import type { Env } from "../src/types";

const originalFetch = globalThis.fetch;
const revision = "a".repeat(40);

describe("vault sync callbacks", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    runtime = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-07-15",
      d1Databases: ["EVENT_DB"],
    });
    db = await runtime.getD1Database("EVENT_DB");
    await applyMigration(db, automationJobsMigration);
    await applyMigration(db, vaultSyncMigration);
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
  });

  it("encrypts refresh tokens with vault-bound authenticated context", async () => {
    const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const encrypted = await encryptCredential(key, "refresh-secret", "owner:42");

    expect(encrypted).not.toContain("refresh-secret");
    expect(await decryptCredential(key, encrypted, "owner:42")).toBe("refresh-secret");
    await expect(decryptCredential(key, encrypted, "owner:99")).rejects.toThrow("sync_credential_invalid");
  });

  it("requests offline per-file Drive access and a one-time state", () => {
    const url = new URL(googleAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "https://vault.example/api/sync/google/callback",
      state: "state-token",
    }));

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("binds OAuth state to one GitHub session and consumes it exactly once", async () => {
    const state = await createSyncOAuthState(db, "owner-1", "42");

    expect(await consumeSyncOAuthState(db, state, "attacker")).toBeUndefined();
    expect(await consumeSyncOAuthState(db, state, "owner-1")).toEqual({ repositoryId: "42" });
    expect(await consumeSyncOAuthState(db, state, "owner-1")).toBeUndefined();
  });

  it("streams an exact GitHub revision into a new Drive snapshot and records success", async () => {
    const archiveBytes = new Uint8Array(5 * 1024 * 1024 + 1);
    archiveBytes.set([80, 75, 3, 4]);
    const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const encryptedRefreshToken = await encryptCredential(key, "refresh-secret", credentialContext("123", "42"));
    const destination = await saveGoogleDriveDestination(db, {
      githubUserId: "123",
      repositoryId: "42",
      vault: "owner/vault",
      encryptedRefreshToken,
    });
    await enqueueSyncSnapshot(environment(db, key), destination, revision, `manual:${crypto.randomUUID()}`);
    const job = await db.prepare("SELECT run_id AS runId FROM automation_jobs").first<{ runId: string }>();
    if (!job) throw new Error("job missing");

    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-token" });
      if (url === "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true") return Response.json({ id: "folder-1" });
      if (url === `https://api.github.com/repos/owner/vault/zipball/${revision}`) {
        return new Response(archiveBytes, { headers: { "Content-Type": "application/zip", "Content-Length": String(archiveBytes.byteLength) } });
      }
      if (url === "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&supportsAllDrives=true") {
        expect(method).toBe("POST");
        return new Response(null, { status: 200, headers: { Location: "https://upload.example/session-1" } });
      }
      if (url === "https://upload.example/session-1") {
        expect(method).toBe("PUT");
        expect((await new Response(init?.body).arrayBuffer()).byteLength).toBe(archiveBytes.byteLength);
        return Response.json({ id: "archive-1" });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await processAutomationJobMessage(environment(db, key), { kind: "automation", runId: job.runId });

    const stored = await getSyncDestination(db, destination.destinationId);
    expect(stored).toEqual(expect.objectContaining({
      status: "active",
      rootFolderId: "folder-1",
      archiveFileId: "archive-1",
      lastSyncedRevision: revision,
    }));
    expect(requests.map(({ url }) => url)).toContain(`https://api.github.com/repos/owner/vault/zipball/${revision}`);
    expect(await db.prepare("SELECT status FROM automation_jobs WHERE run_id = ?").bind(job.runId).first()).toEqual({ status: "succeeded" });
  });

  it("cleans a pending older snapshot before uploading a newer revision", async () => {
    const previousRevision = "b".repeat(40);
    const nextRevision = "c".repeat(40);
    const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const destination = await connectedDestination(db, key);
    await db.prepare(`UPDATE vault_sync_destinations SET root_folder_id = 'folder-1', archive_file_id = 'archive-current',
      cleanup_file_id = 'archive-pending-cleanup', last_synced_revision = ? WHERE destination_id = ?`)
      .bind(previousRevision, destination.destinationId).run();
    const refreshed = await getSyncDestination(db, destination.destinationId);
    if (!refreshed) throw new Error("destination missing");
    await enqueueSyncSnapshot(environment(db, key), refreshed, nextRevision, `manual:${crypto.randomUUID()}`);
    const job = await latestJob(db);

    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-token" });
      if (url === "https://www.googleapis.com/drive/v3/files/archive-pending-cleanup?supportsAllDrives=true") return Response.json({});
      if (url === `https://api.github.com/repos/owner/vault/zipball/${nextRevision}`) {
        return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "Content-Length": "4" } });
      }
      if (url === "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&supportsAllDrives=true") {
        return new Response(null, { status: 200, headers: { Location: "https://upload.example/new-revision" } });
      }
      if (url === "https://upload.example/new-revision") return Response.json({ id: "archive-new" });
      if (url === "https://www.googleapis.com/drive/v3/files/archive-current?supportsAllDrives=true") return Response.json({});
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await processAutomationJobMessage(environment(db, key), { kind: "automation", runId: job.runId });

    expect(requests.indexOf("https://www.googleapis.com/drive/v3/files/archive-pending-cleanup?supportsAllDrives=true"))
      .toBeLessThan(requests.indexOf(`https://api.github.com/repos/owner/vault/zipball/${nextRevision}`));
    const stored = await getSyncDestination(db, destination.destinationId);
    expect(stored).toEqual(expect.objectContaining({
      archiveFileId: "archive-new",
      lastSyncedRevision: nextRevision,
    }));
    expect(stored?.cleanupFileId).toBeUndefined();
  });

  it("keeps pending cleanup durable and does not upload a newer revision when cleanup fails", async () => {
    const previousRevision = "d".repeat(40);
    const nextRevision = "e".repeat(40);
    const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const destination = await connectedDestination(db, key);
    await db.prepare(`UPDATE vault_sync_destinations SET root_folder_id = 'folder-1', archive_file_id = 'archive-current',
      cleanup_file_id = 'archive-pending-cleanup', last_synced_revision = ? WHERE destination_id = ?`)
      .bind(previousRevision, destination.destinationId).run();
    const refreshed = await getSyncDestination(db, destination.destinationId);
    if (!refreshed) throw new Error("destination missing");
    await enqueueSyncSnapshot(environment(db, key), refreshed, nextRevision, `manual:${crypto.randomUUID()}`);
    const job = await latestJob(db);

    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-token" });
      if (url === "https://www.googleapis.com/drive/v3/files/archive-pending-cleanup?supportsAllDrives=true") {
        return Response.json({ error: { message: "temporary" } }, { status: 503 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await processAutomationJobMessage(environment(db, key), { kind: "automation", runId: job.runId });

    expect(requests).not.toContain(`https://api.github.com/repos/owner/vault/zipball/${nextRevision}`);
    expect(await getSyncDestination(db, destination.destinationId)).toEqual(expect.objectContaining({
      archiveFileId: "archive-current",
      lastSyncedRevision: previousRevision,
      cleanupFileId: "archive-pending-cleanup",
      lastErrorCode: "google_drive_cleanup_failed",
    }));
    expect(await db.prepare("SELECT status FROM automation_jobs WHERE run_id = ?").bind(job.runId).first())
      .toEqual({ status: "failed_retryable" });
  });
});

async function connectedDestination(db: D1Database, key: string) {
  const encryptedRefreshToken = await encryptCredential(key, "refresh-secret", credentialContext("123", "42"));
  return saveGoogleDriveDestination(db, {
    githubUserId: "123",
    repositoryId: "42",
    vault: "owner/vault",
    encryptedRefreshToken,
  });
}

async function latestJob(db: D1Database): Promise<{ runId: string }> {
  const job = await db.prepare("SELECT run_id AS runId FROM automation_jobs ORDER BY job_sequence DESC LIMIT 1").first<{ runId: string }>();
  if (!job) throw new Error("job missing");
  return job;
}

function environment(db: D1Database, key: string): Env {
  return {
    EVENT_DB: db,
    GITHUB_REPOSITORIES: "owner/vault",
    GITHUB_VAULT_TOKEN: "github-token",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    SYNC_CREDENTIALS_KEY: key,
    AUTOMATIONS_QUEUE: { send: async () => undefined } as unknown as Queue<never>,
  } as Env;
}

async function applyMigration(db: D1Database, source: string): Promise<void> {
  for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
