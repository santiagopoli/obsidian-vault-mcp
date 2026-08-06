import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64Utf8, encodeBase64Utf8, writeMarkdownFile } from "../src/github";
import type { VaultConfig } from "../src/types";

const vault: VaultConfig = {
  name: "example-vault",
  owner: "example-user",
  repo: "example-vault",
  fullName: "example-user/example-vault",
};

const existingSha = "a".repeat(40);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("note writes", () => {
  it("creates a missing note without a GitHub SHA", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({
        content: { path: "Drafts/New.md", sha: "b".repeat(40), html_url: "https://github.com/note" },
        commit: { sha: "c".repeat(40) },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await writeMarkdownFile("token", vault, "Drafts/New.md", "# Nueva");

    expect(result.created).toBe(true);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { content: string; sha?: string };
    expect(request.method).toBe("PUT");
    expect(body.sha).toBeUndefined();
    expect(decodeBase64Utf8(body.content)).toBe("# Nueva");
  });

  it("refuses to overwrite an existing note without its current SHA", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(existingFile("# Original")) as unknown as typeof fetch;

    await expect(writeMarkdownFile("token", vault, "Drafts/Existing.md", "# Reemplazo"))
      .rejects.toThrow("pass its sha as expected_sha");
  });

  it("refuses an update when the note changed after it was read", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(existingFile("# Original")) as unknown as typeof fetch;

    await expect(writeMarkdownFile("token", vault, "Drafts/Existing.md", "# Reemplazo", "d".repeat(40)))
      .rejects.toThrow("changed since it was read");
  });

  it("updates with the current SHA and preserves Unicode content", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(existingFile("# Original"))
      .mockResolvedValueOnce(jsonResponse({
        content: { path: "Drafts/Existing.md", sha: "b".repeat(40), html_url: "https://github.com/note" },
        commit: { sha: "c".repeat(40) },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await writeMarkdownFile(
      "token",
      vault,
      "Drafts/Existing.md",
      "# Revisión\n\nCafé ☕",
      existingSha,
    );

    expect(result.created).toBe(false);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { content: string; sha: string };
    expect(body.sha).toBe(existingSha);
    expect(decodeBase64Utf8(body.content)).toBe("# Revisión\n\nCafé ☕");
  });

  it("does not create a commit when content is unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(existingFile("# Igual"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await writeMarkdownFile("token", vault, "Drafts/Existing.md", "# Igual", existingSha);

    expect(result.commitSha).toBe("unchanged");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function existingFile(content: string): Response {
  return jsonResponse({
    content: encodeBase64Utf8(content),
    encoding: "base64",
    html_url: "https://github.com/note",
    sha: existingSha,
    size: new TextEncoder().encode(content).byteLength,
    type: "file",
  });
}

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}
