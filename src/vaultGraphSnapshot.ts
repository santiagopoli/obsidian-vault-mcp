import { buildVaultGraph, type VaultGraph } from "./graph";
import { getMarkdownTree, readMarkdownTree } from "./github";
import type { Env, VaultConfig } from "./types";

const graphCacheVersion = "v2";

export async function loadVaultGraph(
  env: Env,
  vault: VaultConfig,
  signal?: AbortSignal,
): Promise<{ revision: string; graph: VaultGraph }> {
  const tree = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault, undefined, signal);
  signal?.throwIfAborted();
  const cacheKey = new Request(`https://obsidian-vault-graph.invalid/${graphCacheVersion}/${vault.fullName}/${tree.revision}`);
  const graphCache = typeof caches === "undefined" ? undefined : await caches.open("obsidian-vault-graph");
  const cached = await graphCache?.match(cacheKey);
  if (cached) return { revision: tree.revision, graph: await cached.json<VaultGraph>() };

  const documents = await readMarkdownTree(env.GITHUB_VAULT_TOKEN, vault, tree, signal);
  signal?.throwIfAborted();
  const graph = buildVaultGraph(documents);
  await graphCache?.put(cacheKey, new Response(JSON.stringify(graph), {
    headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
  }));
  return { revision: tree.revision, graph };
}
