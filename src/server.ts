import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { configuredVaults, resolveVault, vaultAccess } from "./config";
import { readScope, writeScope } from "./authPolicy";
import { getMarkdownTree, listMarkdownFiles, readMarkdownFile, readMarkdownTree, searchMarkdownFiles, writeMarkdownFile } from "./github";
import { buildVaultGraph, findShortestPath, noteByPath } from "./graph";
import { parseAutomationConfig } from "./automations/config";
import { listAutomationRuns, listVaultEvents } from "./eventStore";
import type { VaultGraph } from "./graph";
import type { AuthProps, Env, VaultConfig } from "./types";

const responseFormat = z.enum(["markdown", "json"]).default("markdown");

export function createServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-vault-mcp-server",
    version: "0.4.0",
  });

  server.registerTool(
    "obsidian_list_vaults",
    {
      title: "List Obsidian vaults",
      description: "List the private GitHub repositories explicitly allowed as Obsidian vaults.",
      inputSchema: { response_format: responseFormat },
      annotations: readOnlyAnnotations,
    },
    async ({ response_format }) => toolResult(() => {
      const vaults = configuredVaults(authorizedEnv()).map(({ name, fullName }) => ({ name, repository: fullName }));
      return {
        structured: { vaults },
        markdown: vaults.map((vault) => `- **${vault.name}** — \`${vault.repository}\``).join("\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_list_notes",
    {
      title: "List Obsidian notes",
      description: "List visible Markdown note paths in an allowed Obsidian vault, optionally below a folder prefix.",
      inputSchema: {
        vault: z.string().min(1).max(200).describe("Vault name or owner/repository value"),
        prefix: z.string().max(500).optional().describe("Optional folder path inside the vault"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, prefix, limit, offset, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const files = await listMarkdownFiles(workerEnv.GITHUB_VAULT_TOKEN, resolveVault(workerEnv, vault), prefix);
      const notes = files.slice(offset, offset + limit).map(({ path, size, sha }) => ({ path, size: size ?? 0, sha }));
      const hasMore = offset + notes.length < files.length;
      const structured = {
        total: files.length,
        count: notes.length,
        offset,
        notes,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + notes.length } : {}),
      };
      return {
        structured,
        markdown: [`Found ${files.length} notes (showing ${notes.length}).`, "", ...notes.map((note) => `- \`${note.path}\``)].join("\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_list_events",
    {
      title: "List Obsidian vault events",
      description: "List metadata-only note change events derived from canonical GitHub revisions. Returns paths and SHAs, never note contents.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        event_type: z.enum(["note.created", "note.updated", "note.deleted"]).optional(),
        path_prefix: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, event_type, path_prefix, limit, offset, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const resolvedVault = resolveVault(workerEnv, vault);
      const events = await listVaultEvents(workerEnv.EVENT_DB, resolvedVault.fullName, {
        eventType: event_type,
        pathPrefix: path_prefix ? normalizeGraphPrefix(path_prefix) : undefined,
        limit,
        offset,
      });
      const structured = {
        vault: resolvedVault.fullName,
        count: events.length,
        offset,
        events,
        has_more: events.length === limit,
        ...(events.length === limit ? { next_offset: offset + events.length } : {}),
      };
      return {
        structured,
        markdown: events.length === 0
          ? "No vault events have been recorded yet."
          : events.map((event) => `- ${event.eventType} \`${event.path}\` at \`${event.afterRevision}\``).join("\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_list_automations",
    {
      title: "List Obsidian automations",
      description: "List configured vault automations, their filters, scopes, loop policy, and internal handler. Never exposes secrets.",
      inputSchema: { response_format: responseFormat },
      annotations: readOnlyAnnotations,
    },
    async ({ response_format }) => toolResult(() => {
      const workerEnv = authorizedEnv();
      const config = parseAutomationConfig(workerEnv.AUTOMATIONS_YAML ?? "version: 1\nautomations: []\n");
      const automations = config.automations.map((automation) => ({
        id: automation.id,
        enabled: automation.enabled,
        scopes: automation.scopes,
        match: automation.match,
        loop: automation.loop,
        target: automation.target,
      }));
      return {
        structured: { version: config.version, automations },
        markdown: automations.length === 0
          ? "No automations are configured."
          : automations.map((automation) => `- **${automation.id}** — ${automation.enabled ? "enabled" : "disabled"}; \`${automation.target.handler}\``).join("\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_list_automation_runs",
    {
      title: "List Obsidian automation runs",
      description: "List metadata-only automation execution history for one allowed vault.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, limit, offset, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const resolvedVault = resolveVault(workerEnv, vault);
      const runs = await listAutomationRuns(workerEnv.EVENT_DB, resolvedVault.fullName, limit, offset);
      const structured = {
        vault: resolvedVault.fullName,
        count: runs.length,
        offset,
        runs,
        has_more: runs.length === limit,
        ...(runs.length === limit ? { next_offset: offset + runs.length } : {}),
      };
      return {
        structured,
        markdown: runs.length === 0
          ? "No automation runs have been recorded."
          : runs.map((run) => `- **${run.automationId}** — ${run.status} for \`${run.path}\` (${run.attempts} attempt${run.attempts === 1 ? "" : "s"})`).join("\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read an Obsidian note",
      description: "Read one visible Markdown note from an allowed Obsidian vault. This tool never modifies the vault.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        path: z.string().min(1).max(500).describe("Exact Markdown path returned by list or search"),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, path, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const file = await readMarkdownFile(workerEnv.GITHUB_VAULT_TOKEN, resolveVault(workerEnv, vault), path);
      return {
        structured: { vault, path, sha: file.sha, html_url: file.htmlUrl, content: file.content },
        markdown: `# ${path}\n\nSHA: \`${file.sha}\`\n\n${file.content}`,
        responseFormat: response_format,
      };
    }),
  );

  if (vaultAccess(env as unknown as Env) === "write") {
    server.registerTool(
      "obsidian_write_note",
      {
        title: "Write an Obsidian note",
        description: "Create a Markdown note or replace one using the exact SHA returned by obsidian_read_note. Refuses blind or stale overwrites and cannot delete notes.",
        inputSchema: {
          vault: z.string().min(1).max(200),
          path: z.string().min(1).max(500),
          content: z.string().max(512_000).describe("Complete UTF-8 Markdown contents for the note"),
          expected_sha: z.string().regex(/^[0-9a-f]{40}$/).optional().describe("Required current SHA when updating; omit only when creating"),
          response_format: responseFormat,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ vault, path, content, expected_sha, response_format }) => toolResult(async () => {
        const workerEnv = authorizedEnv(writeScope);
        const result = await writeMarkdownFile(
          workerEnv.GITHUB_VAULT_TOKEN,
          resolveVault(workerEnv, vault),
          path,
          content,
          expected_sha,
        );
        const structured = {
          vault,
          path: result.path,
          created: result.created,
          content_sha: result.contentSha,
          commit_sha: result.commitSha,
          html_url: result.htmlUrl,
        };
        return {
          structured,
          markdown: result.commitSha === "unchanged"
            ? `Note \`${result.path}\` already had the requested contents.`
            : `${result.created ? "Created" : "Updated"} \`${result.path}\` in commit \`${result.commitSha}\`.`,
          responseFormat: response_format,
        };
      }),
    );
  }

  server.registerTool(
    "obsidian_search_notes",
    {
      title: "Search Obsidian notes",
      description: "Search the contents of Markdown notes in one allowed vault using GitHub code search, returning paths and excerpts.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        query: z.string().min(2).max(200),
        path_prefix: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(20).default(10),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, query, path_prefix, limit, offset, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const result = await searchMarkdownFiles(
        workerEnv.GITHUB_VAULT_TOKEN,
        resolveVault(workerEnv, vault),
        query,
        path_prefix,
        limit,
        offset,
      );
      const hasMore = offset + result.matches.length < result.total;
      const structured = {
        total: result.total,
        count: result.matches.length,
        offset,
        matches: result.matches,
        incomplete: result.incomplete,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + result.matches.length } : {}),
      };
      return {
        structured,
        markdown: result.matches.length === 0
          ? `No notes matched '${query}'.`
          : result.matches.map((match) => `## \`${match.path}\`\n\n${match.excerpt}`).join("\n\n"),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_get_note_links",
    {
      title: "Get Obsidian note links",
      description: "Get resolved outgoing links, embeds, backlinks, and unresolved or ambiguous references for one note in the GitHub-backed Obsidian graph.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        path: z.string().min(1).max(500).describe("Exact Markdown note path"),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, path, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const resolvedVault = resolveVault(workerEnv, vault);
      const snapshot = await loadVaultGraph(workerEnv, resolvedVault);
      const note = noteByPath(snapshot.graph, path);
      if (!note) throw new Error(`Graph note '${path}' was not found; use obsidian_get_graph to discover exact paths`);
      const outgoing = snapshot.graph.edges
        .filter((edge) => edge.source === note.path)
        .map((edge) => ({
          source_path: edge.source,
          target_text: edge.targetText,
          resolved_path: edge.target,
          status: "resolved" as const,
          kind: edge.kind,
          embedded: edge.embedded,
          ...(edge.subpath ? { subpath: edge.subpath } : {}),
          ...(edge.displayText ? { display_text: edge.displayText } : {}),
        }));
      const incoming = snapshot.graph.edges
        .filter((edge) => edge.target === note.path)
        .map((edge) => ({
          source_path: edge.source,
          target_text: edge.targetText,
          resolved_path: note.path,
          status: "resolved" as const,
          kind: edge.kind,
          embedded: edge.embedded,
          ...(edge.subpath ? { subpath: edge.subpath } : {}),
          ...(edge.displayText ? { display_text: edge.displayText } : {}),
        }));
      const unresolved = snapshot.graph.unresolved
        .filter((link) => link.source === note.path)
        .map((link) => ({
          source_path: link.source,
          target_text: link.target,
          resolved_path: null,
          status: link.status,
          kind: link.kind,
          embedded: link.embedded,
          ...(link.candidates ? { candidates: link.candidates } : {}),
          ...(link.subpath ? { subpath: link.subpath } : {}),
          ...(link.displayText ? { display_text: link.displayText } : {}),
        }));
      const structured = {
        vault: resolvedVault.fullName,
        revision: snapshot.revision,
        note: {
          path: note.path,
          sha: note.sha,
          title: note.title,
          aliases: note.aliases,
          tags: note.tags,
        },
        outgoing,
        incoming,
        unresolved,
      };
      return {
        structured,
        markdown: formatNoteLinks(note.path, outgoing, incoming, unresolved),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_get_graph",
    {
      title: "Get Obsidian graph",
      description: "Inspect a deterministic, paginated graph derived from Obsidian wikilinks, embeds, and local Markdown links. Returns nodes first, then edges, then optional unresolved references.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        path_prefix: z.string().max(500).optional().describe("Optional visible folder prefix"),
        include_unresolved: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, path_prefix, include_unresolved, limit, offset, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const resolvedVault = resolveVault(workerEnv, vault);
      const snapshot = await loadVaultGraph(workerEnv, resolvedVault);
      const prefix = normalizeGraphPrefix(path_prefix);
      const notes = snapshot.graph.notes.filter((note) => !prefix || note.path === prefix || note.path.startsWith(`${prefix}/`));
      const selected = new Set(notes.map(({ path }) => path));
      const nodes = notes.map((note) => ({
        type: "node" as const,
        path: note.path,
        sha: note.sha,
        title: note.title,
        aliases: note.aliases,
        tags: note.tags,
        incoming_count: note.backlinks.length,
        outgoing_count: note.outgoing.length,
        orphan: isOrphan(snapshot.graph, note.path),
      }));
      const edges = snapshot.graph.edges
        .filter((edge) => selected.has(edge.source) || selected.has(edge.target))
        .map((edge) => ({
          type: "edge" as const,
          source_path: edge.source,
          target_path: edge.target,
          kind: edge.kind,
          embedded: edge.embedded,
          ...(edge.subpath ? { subpath: edge.subpath } : {}),
        }));
      const missing = include_unresolved
        ? snapshot.graph.unresolved.filter((link) => selected.has(link.source)).map((link) => ({
          type: "unresolved" as const,
          source_path: link.source,
          target_text: link.target,
          status: link.status,
          kind: link.kind,
          embedded: link.embedded,
          ...(link.candidates ? { candidates: link.candidates } : {}),
          ...(link.subpath ? { subpath: link.subpath } : {}),
        }))
        : [];
      const allItems = [...nodes, ...edges, ...missing];
      const items = allItems.slice(offset, offset + limit);
      const hasMore = offset + items.length < allItems.length;
      const structured = {
        vault: resolvedVault.fullName,
        revision: snapshot.revision,
        stats: {
          nodes: notes.length,
          edges: edges.length,
          orphans: notes.filter((note) => isOrphan(snapshot.graph, note.path)).length,
          unresolved: snapshot.graph.unresolved.filter((link) => selected.has(link.source)).length,
        },
        total: allItems.length,
        count: items.length,
        offset,
        items,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + items.length } : {}),
      };
      return {
        structured,
        markdown: formatGraphPage(structured),
        responseFormat: response_format,
      };
    }),
  );

  server.registerTool(
    "obsidian_find_path",
    {
      title: "Find path through Obsidian graph",
      description: "Find the shortest deterministic path between two notes through outgoing links, backlinks, or both directions without downloading the complete graph.",
      inputSchema: {
        vault: z.string().min(1).max(200),
        from_path: z.string().min(1).max(500),
        to_path: z.string().min(1).max(500),
        direction: z.enum(["outgoing", "backlinks", "both"]).default("both"),
        max_depth: z.number().int().min(1).max(12).default(6),
        response_format: responseFormat,
      },
      annotations: readOnlyAnnotations,
    },
    async ({ vault, from_path, to_path, direction, max_depth, response_format }) => toolResult(async () => {
      const workerEnv = authorizedEnv();
      const resolvedVault = resolveVault(workerEnv, vault);
      const snapshot = await loadVaultGraph(workerEnv, resolvedVault);
      const path = findShortestPath(snapshot.graph, from_path, to_path, direction, max_depth);
      const structured = {
        vault: resolvedVault.fullName,
        revision: snapshot.revision,
        found: Boolean(path),
        path: path ?? [],
        distance: path ? path.length - 1 : null,
        direction,
        max_depth: max_depth,
      };
      return {
        structured,
        markdown: path ? path.map((note, index) => `${index + 1}. \`${note}\``).join("\n") : "No path was found within the requested depth.",
        responseFormat: response_format,
      };
    }),
  );

  return server;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const graphCacheVersion = "v2";

async function loadVaultGraph(workerEnv: Env, vault: VaultConfig): Promise<{ revision: string; graph: VaultGraph }> {
  const tree = await getMarkdownTree(workerEnv.GITHUB_VAULT_TOKEN, vault);
  const cacheKey = new Request(`https://obsidian-vault-graph.invalid/${graphCacheVersion}/${vault.fullName}/${tree.revision}`);
  const graphCache = await caches.open("obsidian-vault-graph");
  const cached = await graphCache.match(cacheKey);
  if (cached) return { revision: tree.revision, graph: await cached.json<VaultGraph>() };

  const documents = await readMarkdownTree(workerEnv.GITHUB_VAULT_TOKEN, vault, tree);
  const graph = buildVaultGraph(documents);
  await graphCache.put(cacheKey, new Response(JSON.stringify(graph), {
    headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" },
  }));
  return { revision: tree.revision, graph };
}

function normalizeGraphPrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  const normalized = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Graph path prefix must identify a visible folder inside the vault");
  }
  return normalized;
}

function isOrphan(graph: VaultGraph, path: string): boolean {
  return !graph.edges.some((edge) => (edge.source === path && edge.target !== path) || (edge.target === path && edge.source !== path));
}

function formatNoteLinks(
  path: string,
  outgoing: Array<{ resolved_path: string; embedded: boolean }>,
  incoming: Array<{ source_path: string }>,
  unresolved: Array<{ target_text: string; status: string }>,
): string {
  const lines = [`# Links for \`${path}\``, "", `Outgoing: ${outgoing.length}; backlinks: ${incoming.length}; unresolved: ${unresolved.length}.`];
  if (outgoing.length) lines.push("", "## Outgoing", ...outgoing.map((link) => `- ${link.embedded ? "embed" : "link"}: \`${link.resolved_path}\``));
  if (incoming.length) lines.push("", "## Backlinks", ...incoming.map((link) => `- \`${link.source_path}\``));
  if (unresolved.length) lines.push("", "## Unresolved", ...unresolved.map((link) => `- ${link.status}: \`${link.target_text}\``));
  return lines.join("\n");
}

function formatGraphPage(result: {
  revision: string;
  stats: { nodes: number; edges: number; orphans: number; unresolved: number };
  count: number;
  total: number;
  items: Array<Record<string, unknown>>;
}): string {
  const lines = [
    `# Obsidian graph at \`${result.revision}\``,
    "",
    `${result.stats.nodes} nodes, ${result.stats.edges} edges, ${result.stats.orphans} orphans, ${result.stats.unresolved} unresolved references.`,
    `Showing ${result.count} of ${result.total} graph items.`,
    "",
  ];
  for (const item of result.items) {
    if (item.type === "node") lines.push(`- node \`${String(item.path)}\` (${String(item.incoming_count)} in / ${String(item.outgoing_count)} out)`);
    else if (item.type === "edge") lines.push(`- edge \`${String(item.source_path)}\` → \`${String(item.target_path)}\``);
    else lines.push(`- ${String(item.status)} \`${String(item.source_path)}\` → \`${String(item.target_text)}\``);
  }
  return lines.join("\n");
}

function authorizedEnv(requiredScope = readScope): Env {
  const auth = getMcpAuthContext();
  const props = auth?.props as Partial<AuthProps> | undefined;
  const workerEnv = env as unknown as Env;
  if (!props?.githubUserId || props.githubUserId !== workerEnv.ALLOWED_GITHUB_USER_ID) {
    throw new Error("Authenticated GitHub account is not authorized for this vault");
  }
  if (!props.scopes?.includes(requiredScope)) throw new Error(`OAuth grant is missing required scope '${requiredScope}'`);
  return workerEnv;
}

async function toolResult(
  action: () => Promise<{ structured: Record<string, unknown>; markdown: string; responseFormat: "markdown" | "json" }> | { structured: Record<string, unknown>; markdown: string; responseFormat: "markdown" | "json" },
) {
  try {
    const result = await action();
    return {
      content: [
        {
          type: "text" as const,
          text: result.responseFormat === "json" ? JSON.stringify(result.structured, null, 2) : result.markdown,
        },
      ],
      structuredContent: result.structured,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Obsidian vault error: ${message}` }],
    };
  }
}
