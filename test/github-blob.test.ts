import { afterEach, describe, expect, it, vi } from "vitest";
import { readMarkdownBlobAtSha } from "../src/github";
import type { VaultConfig } from "../src/types";

const vault: VaultConfig = {
  name: "vault",
  owner: "owner",
  repo: "vault",
  fullName: "owner/vault",
};
const sha = "a".repeat(40);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("exact Markdown blob reads", () => {
  it("reads the requested immutable Git blob and normalizes the visible path", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(graphQlBlob({
      oid: sha,
      byteSize: 9,
      isBinary: false,
      text: "# Exacto",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(readMarkdownBlobAtSha("token", vault, "/Notes\\Exact.md", sha)).resolves.toEqual({
      path: "Notes/Exact.md",
      sha,
      content: "# Exacto",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string };
    expect(body.query).toContain(`object(oid: "${sha}")`);
  });

  it.each([
    [{ oid: "b".repeat(40), byteSize: 1, isBinary: false, text: "x" }, "unsupported blob"],
    [{ oid: sha, byteSize: 1, isBinary: true, text: null }, "unsupported blob"],
    [{ oid: sha, byteSize: 512_001, isBinary: false, text: "x" }, "exceeds the 512000-byte read limit"],
  ])("rejects mismatched, binary, or oversized blobs", async (blob, message) => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(graphQlBlob(blob)) as unknown as typeof fetch;
    await expect(readMarkdownBlobAtSha("token", vault, "Note.md", sha)).rejects.toThrow(message);
  });

  it("rejects invalid paths and SHAs before contacting GitHub", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(readMarkdownBlobAtSha("token", vault, "../Note.md", sha)).rejects.toThrow("visible Markdown");
    await expect(readMarkdownBlobAtSha("token", vault, "Note.md", "short")).rejects.toThrow("40-character");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function graphQlBlob(blob: { oid: string; byteSize: number; isBinary: boolean; text: string | null }): Response {
  return Response.json({ data: { repository: { blob0: blob } } });
}
