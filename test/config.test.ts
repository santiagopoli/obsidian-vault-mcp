import { describe, expect, it } from "vitest";
import { configuredVaults, resolveVault } from "../src/config";
import { decodeBase64Utf8, encodeBase64Utf8, normalizeNotePath } from "../src/github";
import type { Env } from "../src/types";

const env = {
  GITHUB_REPOSITORIES: "example-user/notes, example-user/novel",
} as Env;

describe("vault configuration", () => {
  it("parses an explicit repository allowlist", () => {
    expect(configuredVaults(env).map((vault) => vault.name)).toEqual(["notes", "novel"]);
  });

  it("resolves by short or full name", () => {
    expect(resolveVault(env, "notes").fullName).toBe("example-user/notes");
    expect(resolveVault(env, "example-user/novel").name).toBe("novel");
  });

  it("rejects repositories outside the allowlist", () => {
    expect(() => resolveVault(env, "someone/else")).toThrow("Unknown vault");
  });

  it("requires exact owner/repository when short vault names collide", () => {
    const ambiguous = { GITHUB_REPOSITORIES: "first/shared,second/shared" } as Env;
    expect(() => resolveVault(ambiguous, "shared")).toThrow("ambiguous");
    expect(resolveVault(ambiguous, "second/shared").fullName).toBe("second/shared");
  });

  it("rejects duplicate repositories", () => {
    const duplicate = { GITHUB_REPOSITORIES: "example/notes,example/notes" } as Env;
    expect(() => configuredVaults(duplicate)).toThrow("duplicates");
  });
});

describe("note paths", () => {
  it("normalizes visible Markdown paths", () => {
    expect(normalizeNotePath("/Drafts\\Chapter 1.md")).toBe("Drafts/Chapter 1.md");
  });

  it.each(["../secret.md", ".obsidian/config.md", "image.png", "folder//note.md"])(
    "rejects unsafe path %s",
    (path) => expect(() => normalizeNotePath(path)).toThrow(),
  );
});

describe("note content encoding", () => {
  it("round-trips Unicode Markdown", () => {
    const content = "# Capítulo\n\nEl pingüino soñó con café. ☕";
    expect(decodeBase64Utf8(encodeBase64Utf8(content))).toBe(content);
  });
});
