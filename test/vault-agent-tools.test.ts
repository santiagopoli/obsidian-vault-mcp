import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultAgentToolbox } from "../src/vaultAgentTools";
import type { Env, VaultConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const vault: VaultConfig = { name: "vault", owner: "owner", repo: "vault", fullName: "owner/vault" };
const env = { GITHUB_VAULT_TOKEN: "token" } as Env;

afterEach(() => { globalThis.fetch = originalFetch; });

describe("vault agent tools", () => {
  it("rejects incomplete note and folder scopes before reading GitHub", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(VaultAgentToolbox.create(env, vault, "note")).rejects.toThrow("active note");
    await expect(VaultAgentToolbox.create(env, vault, "folder")).rejects.toThrow("path prefix");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start snapshot preparation after cancellation", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await expect(VaultAgentToolbox.create(env, vault, "vault", undefined, undefined, controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins one revision and enforces note scope on every tool call", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const toolbox = await VaultAgentToolbox.create(env, vault, "note", "Canon/Luz.md");

    expect(toolbox.tree.revision).toBe("c".repeat(40));
    expect(toolbox.availableTools().map(({ name }) => name)).toEqual(["read_notes", "get_note_links"]);
    const rejected = await toolbox.execute("read_notes", JSON.stringify({ paths: ["Private/Other.md"] }), 1);
    expect(rejected.trace.status).toBe("failed");
    expect(rejected.output).not.toContain("Other body");

    const accepted = await toolbox.execute("read_notes", JSON.stringify({ paths: ["Canon/Luz.md"] }), 2);
    expect(accepted.trace).toEqual(expect.objectContaining({
      tool: "read_notes",
      status: "completed",
      notes: [{ path: "Canon/Luz.md", sha: "a".repeat(40) }],
    }));
    expect(JSON.stringify(accepted.trace)).not.toContain("Luz body");
    expect(accepted.output).toContain("Luz body");
    expect(toolbox.evidence().get("Canon/Luz.md")).toEqual({ path: "Canon/Luz.md", sha: "a".repeat(40) });
  });

  it("accepts only exact mentioned paths inside the already-enforced scope", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const vaultToolbox = await VaultAgentToolbox.create(env, vault, "vault");
    expect(vaultToolbox.requireMentionedPaths(["Canon/Luz.md", "Private/Other.md"])).toEqual([
      { path: "Canon/Luz.md", sha: "a".repeat(40) },
      { path: "Private/Other.md", sha: "b".repeat(40) },
    ]);
    expect(() => vaultToolbox.requireMentionedPaths(["canon/luz.md"])).toThrow("not present");
    expect(() => vaultToolbox.requireMentionedPaths(["Missing.md"])).toThrow("not present");

    const noteToolbox = await VaultAgentToolbox.create(env, vault, "note", "Canon/Luz.md");
    expect(() => noteToolbox.requireMentionedPaths(["Canon/Luz.md"])).not.toThrow();
    expect(() => noteToolbox.requireMentionedPaths(["Private/Other.md"])).toThrow("outside");
  });

  it("searches only within an enforced folder and returns trace metadata", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const toolbox = await VaultAgentToolbox.create(env, vault, "folder", undefined, "Canon");
    const result = await toolbox.execute("search_notes", JSON.stringify({ query: "Luz", prefix: null, limit: 10 }), 1);

    expect(result.trace.status).toBe("completed");
    expect(result.trace.notes).toEqual([{ path: "Canon/Luz.md", sha: "a".repeat(40) }]);
    expect(result.output).toContain("Canon/Luz.md");
    expect(result.output).not.toContain("Private/Other.md");
  });

  it("does not retain partial citation evidence when a multi-note read fails", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const toolbox = await VaultAgentToolbox.create(env, vault, "vault");

    const result = await toolbox.execute("read_notes", JSON.stringify({ paths: ["Canon/Luz.md", "Missing.md"] }), 1);

    expect(result.trace.status).toBe("failed");
    expect(toolbox.evidence()).toEqual(new Map());
    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/git/blobs/"), expect.anything());
  });

  it("aborts an in-flight note read without committing evidence", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const controller = new AbortController();
    const toolbox = await VaultAgentToolbox.create(env, vault, "vault", undefined, undefined, controller.signal);
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

    const read = toolbox.execute("read_notes", JSON.stringify({ paths: ["Canon/Luz.md"] }), 1);
    controller.abort();

    await expect(read).rejects.toThrow();
    expect(toolbox.evidence()).toEqual(new Map());
  });

  it("lets the agent inspect neighbors and explain the shortest graph trail", async () => {
    globalThis.fetch = snapshotFetch() as unknown as typeof fetch;
    const toolbox = await VaultAgentToolbox.create(env, vault, "vault");

    const neighbors = await toolbox.execute("get_graph_neighbors", JSON.stringify({
      path: "Canon/Luz.md",
      direction: "both",
      limit: 10,
    }), 1);
    const trail = await toolbox.execute("find_graph_path", JSON.stringify({
      from_path: "Canon/Luz.md",
      to_path: "Private/Other.md",
      direction: "both",
      max_depth: 4,
    }), 2);

    expect(neighbors.trace).toMatchObject({ tool: "get_graph_neighbors", status: "completed" });
    expect(neighbors.output).toContain("Private/Other.md");
    expect(trail.trace).toMatchObject({ tool: "find_graph_path", status: "completed" });
    expect(JSON.parse(trail.output).path).toEqual(["Canon/Luz.md", "Private/Other.md"]);
  });
});

function snapshotFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/repos/owner/vault")) return Response.json({ id: 1, default_branch: "main" });
    if (url.includes("/git/trees/main")) return Response.json({
      sha: "c".repeat(40),
      truncated: false,
      tree: [
        { path: "Canon/Luz.md", type: "blob", sha: "a".repeat(40), size: 20 },
        { path: "Private/Other.md", type: "blob", sha: "b".repeat(40), size: 20 },
      ],
    });
    if (url.endsWith("/graphql")) return Response.json({
      data: { repository: {
        blob0: { oid: "a".repeat(40), byteSize: 20, isBinary: false, text: "# Luz\n\nLuz body. [[Private/Other]]" },
        blob1: { oid: "b".repeat(40), byteSize: 20, isBinary: false, text: "# Other\n\nOther body." },
      } },
    });
    throw new Error(`Unexpected request: ${url}`);
  });
}
