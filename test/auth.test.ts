import { describe, expect, it } from "vitest";
import { readScope, selectGrantedScopes, writeScope } from "../src/authPolicy";
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
