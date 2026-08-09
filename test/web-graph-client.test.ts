import { afterEach, describe, expect, it, vi } from "vitest";
import { getVaultGraph, type VaultGraph } from "../web/src/api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("web graph client", () => {
  it("reuses a cached graph and deduplicates concurrent requests", async () => {
    const graph = createGraph("revision-1");
    globalThis.fetch = vi.fn(async () => Response.json(graph)) as typeof fetch;

    const [first, second] = await Promise.all([
      getVaultGraph("deduplicated-vault"),
      getVaultGraph("deduplicated-vault"),
    ]);
    const cached = await getVaultGraph("deduplicated-vault");

    expect(first).toEqual(graph);
    expect(second).toEqual(graph);
    expect(cached).toEqual(graph);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("keeps an explicit refresh authoritative when an older request finishes later", async () => {
    const initial = deferred<Response>();
    const refresh = deferred<Response>();
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise) as typeof fetch;

    const initialRequest = getVaultGraph("refreshed-vault");
    const refreshRequest = getVaultGraph("refreshed-vault", undefined, true);
    initial.resolve(Response.json(createGraph("stale-revision")));
    await expect(initialRequest).resolves.toMatchObject({ revision: "stale-revision" });

    const sharedRefreshRequest = getVaultGraph("refreshed-vault");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    refresh.resolve(Response.json(createGraph("fresh-revision")));

    await expect(refreshRequest).resolves.toMatchObject({ revision: "fresh-revision" });
    await expect(sharedRefreshRequest).resolves.toMatchObject({ revision: "fresh-revision" });
    await expect(getVaultGraph("refreshed-vault")).resolves.toMatchObject({ revision: "fresh-revision" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

function createGraph(revision: string): VaultGraph {
  return {
    revision,
    stats: { nodes: 0, edges: 0, orphans: 0, unresolved: 0 },
    nodes: [],
    edges: [],
    truncated: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
