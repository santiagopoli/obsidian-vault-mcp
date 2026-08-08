import { describe, expect, it } from "vitest";
import { configuredVaults, resolveVault, webChatEnabled } from "../src/config";
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

describe("web chat configuration", () => {
  it("follows the secret by default and permits an explicit off switch", () => {
    expect(webChatEnabled({ OPENAI_API_KEY: "secret" } as Env)).toBe(true);
    expect(webChatEnabled({} as Env)).toBe(false);
    expect(webChatEnabled({ OPENAI_API_KEY: "secret", WEB_CHAT_ENABLED: "false" } as Env)).toBe(false);
    expect(webChatEnabled({ WEB_CHAT_ENABLED: "true" } as Env)).toBe(true);
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
