import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMarkdownDocuments, searchMarkdownFiles } from "../src/github";
import type { VaultConfig } from "../src/types";

const vault: VaultConfig = {
  name: "vault",
  owner: "owner",
  repo: "vault",
  fullName: "owner/vault",
};
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("snapshot Markdown search", () => {
  it("finds body text without using GitHub's code-search index", async () => {
    const fetchMock = snapshotFetch([
      { path: "Canon/Places/Quilmes.md", sha: "a", content: "# Quilmes\n\nMateo vuelve a su ciudad." },
      { path: "Characters/Luz.md", sha: "b", content: "# Luz\n\nViaja a Barcelona." },
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await searchMarkdownFiles("token", vault, "MATEO ciudad", undefined, 20, 0);

    expect(result).toEqual({
      total: 1,
      incomplete: false,
      matches: [{
        path: "Canon/Places/Quilmes.md",
        sha: "a",
        htmlUrl: "https://github.com/owner/vault/blob/cccccccccccccccccccccccccccccccccccccccc/Canon/Places/Quilmes.md",
        excerpt: "# Quilmes Mateo vuelve a su ciudad.",
      }],
    });
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("/search/code"))).toBe(true);
  });

  it("normalizes accents, ranks paths first, and paginates after ranking", async () => {
    globalThis.fetch = snapshotFetch([
      { path: "Notes/Travel.md", sha: "b", content: "Viaje hacia Cordoba." },
      { path: "Places/Córdoba.md", sha: "a", content: "Una ciudad argentina." },
    ]) as unknown as typeof fetch;

    const result = await searchMarkdownDocuments("token", vault, ["cordoba"], undefined, 1, 1);

    expect(result.total).toBe(2);
    expect(result.matches.map(({ path }) => path)).toEqual(["Notes/Travel.md"]);
    expect(result.revision).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });
});

function snapshotFetch(documents: Array<{ path: string; sha: string; content: string }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 1, default_branch: "main" });
    if (url.includes("/git/trees/main")) return Response.json({
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      truncated: false,
      tree: documents.map((document) => ({ path: document.path, type: "blob", sha: document.sha, size: document.content.length })),
    });
    if (url.endsWith("/graphql")) return Response.json({
      data: { repository: Object.fromEntries(documents.map((document, index) => [`blob${index}`, {
        oid: document.sha,
        byteSize: document.content.length,
        isBinary: false,
        text: document.content,
      }])) },
    });
    throw new Error(`Unexpected request: ${url}`);
  });
}
