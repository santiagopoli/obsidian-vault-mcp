import { afterEach, describe, expect, it, vi } from "vitest";
import { getMarkdownTree, readMarkdownTree } from "../src/github";
import type { VaultConfig } from "../src/types";

const vault: VaultConfig = {
  name: "example-vault",
  owner: "example-user",
  repo: "example-vault",
  fullName: "example-user/example-vault",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("graph snapshot reads", () => {
  it("filters visible Markdown files and exposes the immutable tree revision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ default_branch: "main" }))
      .mockResolvedValueOnce(Response.json({
        sha: "tree-revision",
        truncated: false,
        tree: [
          { path: "Notes/B.md", type: "blob", sha: "b", size: 10 },
          { path: ".obsidian/config.md", type: "blob", sha: "hidden", size: 10 },
          { path: "image.png", type: "blob", sha: "image", size: 10 },
          { path: "Notes/A.md", type: "blob", sha: "a", size: 10 },
        ],
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getMarkdownTree("token", vault);

    expect(result.revision).toBe("tree-revision");
    expect(result.files.map(({ path }) => path)).toEqual(["Notes/A.md", "Notes/B.md"]);
  });

  it("reads notes by immutable blob SHA in one GraphQL batch", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      data: {
        repository: {
          blob0: { oid: "a", byteSize: 11, isBinary: false, text: "# A\n\n[[B]]" },
          blob1: { oid: "b", byteSize: 3, isBinary: false, text: "# B" },
        },
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const documents = await readMarkdownTree("token", vault, {
      revision: "tree-revision",
      files: [
        { path: "A.md", type: "blob", sha: "a", size: 10 },
        { path: "B.md", type: "blob", sha: "b", size: 3 },
      ],
    });

    expect(documents).toEqual([
      { path: "A.md", sha: "a", content: "# A\n\n[[B]]" },
      { path: "B.md", sha: "b", content: "# B" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0]).endsWith("/graphql")).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string };
    expect(body.query).toContain('blob0: object(oid: "a")');
    expect(body.query).toContain('blob1: object(oid: "b")');
  });
});
