import { describe, expect, it } from "vitest";
import { readScope, selectGrantedScopes, writeScope } from "../src/authPolicy";
import { consumeConsentState, storeConsentState } from "../src/consentState";
import { allowedGitHubUserId, vaultAccess } from "../src/config";
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
    const key = `oauth-consent-state:${consentId}`;
    const stored = new Map<string, string>();
    const kv = {
      get: async (stateKey: string) => stored.get(stateKey) ?? null,
      delete: async (stateKey: string) => { stored.delete(stateKey); },
      put: async (stateKey: string, value: string) => { stored.set(stateKey, value); },
    } as unknown as KVNamespace;
    await storeConsentState(kv, consentId, {
      oauthRequest: { clientId: "codex-client" },
      grantedScopes: [readScope, writeScope],
      githubUserId: "759695",
    }, 600);

    const first = await consumeConsentState<Record<string, unknown>>(kv, consentId);

    expect(first.status).toBe("valid");
    expect(stored.has(key)).toBe(false);

    const replay = await consumeConsentState<Record<string, unknown>>(kv, consentId);

    expect(replay.status).toBe("expired");
  });

  it("keeps overlapping consent flows independent", async () => {
    const firstId = "2b5d922f-1433-4ec7-9947-38db96d5b04d";
    const secondId = "4ac5e8be-f3e2-47e5-8ac9-ac3ea4f31730";
    const stored = new Map<string, string>();
    const kv = {
      get: async (stateKey: string) => stored.get(stateKey) ?? null,
      delete: async (stateKey: string) => { stored.delete(stateKey); },
      put: async (stateKey: string, value: string) => { stored.set(stateKey, value); },
    } as unknown as KVNamespace;
    await storeConsentState(kv, firstId, { client: "Codex A" }, 600);
    await storeConsentState(kv, secondId, { client: "Codex B" }, 600);

    const second = await consumeConsentState<{ client: string }>(kv, secondId);
    const first = await consumeConsentState<{ client: string }>(kv, firstId);

    expect(second).toEqual({ status: "valid", value: { client: "Codex B" } });
    expect(first).toEqual({ status: "valid", value: { client: "Codex A" } });
  });

  it("rejects malformed consent tokens without reading storage", async () => {
    let reads = 0;
    const kv = {
      get: async () => { reads += 1; return null; },
      delete: async () => undefined,
    } as unknown as KVNamespace;

    expect(await consumeConsentState(kv, "not-a-token")).toEqual({ status: "invalid" });
    expect(reads).toBe(0);
  });
});
