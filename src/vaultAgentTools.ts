import { z } from "zod";
import { buildVaultGraph, findShortestPath, noteByPath, type VaultDocument, type VaultGraph } from "./graph";
import { excerptAround, getMarkdownTree, rankMarkdownDocuments, readMarkdownBlobAtSha, readMarkdownTree, type MarkdownTree } from "./github";
import type { Env, VaultConfig } from "./types";

export type VaultAgentToolName = "list_notes" | "search_notes" | "read_notes" | "get_note_links" | "get_graph_overview" | "get_graph_neighbors" | "find_graph_path";

export interface AgentTraceNote {
  path: string;
  sha: string;
}

export interface AgentTraceEvent {
  id: string;
  step: number;
  tool: VaultAgentToolName;
  status: "completed" | "failed";
  input: { query?: string; prefix?: string; paths?: string[]; path?: string; from_path?: string; to_path?: string; direction?: string };
  summary: string;
  notes: AgentTraceNote[];
}

export interface AgentToolExecution {
  output: string;
  trace: AgentTraceEvent;
}

export const vaultAgentToolDefinitions = [
  {
    type: "function",
    name: "list_notes",
    description: "List visible Markdown note paths and exact SHAs. Use this to discover folders or exact paths before reading.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        prefix: { type: ["string", "null"], description: "Optional visible folder prefix." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 1000 },
      },
      required: ["prefix", "limit", "offset"],
    },
  },
  {
    type: "function",
    name: "search_notes",
    description: "Search visible note paths and contents at the fixed vault revision. Returns ranked exact-SHA excerpts, not full notes.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200 },
        prefix: { type: ["string", "null"], description: "Optional visible folder prefix." },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query", "prefix", "limit"],
    },
  },
  {
    type: "function",
    name: "read_notes",
    description: "Read up to ten exact Markdown notes. Use exact paths returned by list or search. Read the notes needed to support the answer.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 } },
      },
      required: ["paths"],
    },
  },
  {
    type: "function",
    name: "get_note_links",
    description: "Inspect outgoing links, backlinks, embeds, tags, and unresolved links for one exact note path.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "get_graph_overview",
    description: "Inspect graph statistics, prominent connected notes, and common tags for the current vault scope.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["limit"],
    },
  },
  {
    type: "function",
    name: "get_graph_neighbors",
    description: "Inspect the notes directly connected to one exact note, following outgoing links, backlinks, or both directions.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500 },
        direction: { type: "string", enum: ["outgoing", "backlinks", "both"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["path", "direction", "limit"],
    },
  },
  {
    type: "function",
    name: "find_graph_path",
    description: "Find the shortest link path between two exact notes. Use this to explain how ideas or story elements are connected.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        from_path: { type: "string", minLength: 1, maxLength: 500 },
        to_path: { type: "string", minLength: 1, maxLength: 500 },
        direction: { type: "string", enum: ["outgoing", "backlinks", "both"] },
        max_depth: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["from_path", "to_path", "direction", "max_depth"],
    },
  },
] as const;

const listSchema = z.object({ prefix: z.string().max(500).nullable(), limit: z.number().int().min(1).max(50), offset: z.number().int().min(0).max(1_000) }).strict();
const searchSchema = z.object({ query: z.string().trim().min(2).max(200), prefix: z.string().max(500).nullable(), limit: z.number().int().min(1).max(10) }).strict();
const readSchema = z.object({ paths: z.array(z.string().min(1).max(500)).min(1).max(10) }).strict();
const linksSchema = z.object({ path: z.string().min(1).max(500) }).strict();
const graphSchema = z.object({ limit: z.number().int().min(1).max(20) }).strict();
const neighborsSchema = z.object({
  path: z.string().min(1).max(500),
  direction: z.enum(["outgoing", "backlinks", "both"]),
  limit: z.number().int().min(1).max(50),
}).strict();
const pathSchema = z.object({
  from_path: z.string().min(1).max(500),
  to_path: z.string().min(1).max(500),
  direction: z.enum(["outgoing", "backlinks", "both"]),
  max_depth: z.number().int().min(1).max(20),
}).strict();

export class VaultAgentToolbox {
  private readonly filesByPath: Map<string, { path: string; sha: string; size?: number }>;
  private readonly documentCache = new Map<string, VaultDocument>();
  private readonly evidenceByPath = new Map<string, AgentTraceNote>();
  private documentsPromise?: Promise<VaultDocument[]>;
  private graphPromise?: Promise<VaultGraph>;
  private returnedCharacters = 0;

  private constructor(
    private readonly token: string,
    private readonly vault: VaultConfig,
    readonly tree: MarkdownTree,
    private readonly scope: "note" | "folder" | "vault",
    private readonly activePath?: string,
    private readonly pathPrefix?: string,
    private readonly signal?: AbortSignal,
  ) {
    this.filesByPath = new Map(tree.files.map((file) => [file.path, file]));
    if (scope === "note" && (!activePath || !this.filesByPath.has(activePath))) {
      throw new Error("The selected note is not present in the vault snapshot");
    }
  }

  static async create(env: Env, vault: VaultConfig, scope: "note" | "folder" | "vault", activePath?: string, pathPrefix?: string, signal?: AbortSignal) {
    if (scope === "note" && !activePath) throw new Error("Note scope requires an active note");
    if (scope === "folder" && !pathPrefix) throw new Error("Folder scope requires a path prefix");
    const normalizedPrefix = normalizePrefix(pathPrefix);
    signal?.throwIfAborted();
    const tree = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault, undefined, signal);
    signal?.throwIfAborted();
    return new VaultAgentToolbox(env.GITHUB_VAULT_TOKEN, vault, tree, scope, activePath, normalizedPrefix, signal);
  }

  availableTools() {
    if (this.scope === "note") return vaultAgentToolDefinitions.filter(({ name }) => name === "read_notes" || name === "get_note_links");
    return vaultAgentToolDefinitions;
  }

  canExecute(name: string): name is VaultAgentToolName {
    return isToolName(name) && this.availableTools().some((tool) => tool.name === name);
  }

  evidence(): Map<string, AgentTraceNote> {
    return new Map(this.evidenceByPath);
  }

  requireMentionedPaths(paths: string[]): AgentTraceNote[] {
    const notes: AgentTraceNote[] = [];
    for (const path of paths) {
      const file = this.filesByPath.get(path);
      if (!file) throw new Error("Mentioned note is not present in the vault snapshot");
      this.requireAllowedPath(path);
      notes.push({ path, sha: file.sha });
    }
    return notes;
  }

  async execute(name: string, rawArguments: string, step: number): Promise<AgentToolExecution> {
    const traceId = `step_${step}`;
    try {
      this.signal?.throwIfAborted();
      if (!this.canExecute(name)) throw new Error("Tool is outside the selected chat scope");
      const parsed = parseArguments(rawArguments);
      switch (name as VaultAgentToolName) {
        case "list_notes": return this.listNotes(listSchema.parse(parsed), traceId, step);
        case "search_notes": return await this.searchNotes(searchSchema.parse(parsed), traceId, step);
        case "read_notes": return await this.readNotes(readSchema.parse(parsed), traceId, step);
        case "get_note_links": return await this.getNoteLinks(linksSchema.parse(parsed), traceId, step);
        case "get_graph_overview": return await this.getGraphOverview(graphSchema.parse(parsed), traceId, step);
        case "get_graph_neighbors": return await this.getGraphNeighbors(neighborsSchema.parse(parsed), traceId, step);
        case "find_graph_path": return await this.findGraphPath(pathSchema.parse(parsed), traceId, step);
        default: throw new Error("Unknown vault tool");
      }
    } catch (error) {
      if (this.signal?.aborted) throw error;
      const tool = isToolName(name) ? name : "list_notes";
      return {
        output: safeJson({ error: "tool_request_failed" }),
        trace: { id: traceId, step, tool, status: "failed", input: {}, summary: "Tool request failed", notes: [] },
      };
    }
  }

  private listNotes(input: z.infer<typeof listSchema>, id: string, step: number): AgentToolExecution {
    const prefix = this.scopedPrefix(input.prefix ?? undefined);
    const files = this.visibleFiles(prefix);
    const page = files.slice(input.offset, input.offset + input.limit);
    const notes = page.map(({ path, sha, size }) => ({ path, sha, size: size ?? 0 }));
    return {
      output: safeJson({ revision: this.tree.revision, total: files.length, notes, has_more: input.offset + notes.length < files.length }),
      trace: { id, step, tool: "list_notes", status: "completed", input: { ...(prefix ? { prefix } : {}) }, summary: `Listed ${notes.length} of ${files.length} notes`, notes: [] },
    };
  }

  private async searchNotes(input: z.infer<typeof searchSchema>, id: string, step: number): Promise<AgentToolExecution> {
    const prefix = this.scopedPrefix(input.prefix ?? undefined);
    const documents = (await this.documents()).filter(({ path }) => !prefix || path.startsWith(`${prefix}/`));
    this.signal?.throwIfAborted();
    const result = rankMarkdownDocuments(this.vault, this.tree.revision, documents, [input.query], input.limit, 0);
    const matches = result.matches.map(({ path, sha, content }) => {
      this.evidenceByPath.set(path, { path, sha });
      return { path, sha, excerpt: excerptAround(content, input.query) };
    });
    return {
      output: safeJson({ revision: this.tree.revision, total: result.total, matches }),
      trace: { id, step, tool: "search_notes", status: "completed", input: { query: input.query, ...(prefix ? { prefix } : {}) }, summary: `Found ${result.total} matching notes`, notes: matches.map(({ path, sha }) => ({ path, sha })) },
    };
  }

  private async readNotes(input: z.infer<typeof readSchema>, id: string, step: number): Promise<AgentToolExecution> {
    const uniquePaths = [...new Set(input.paths)];
    const requested = uniquePaths.map((path) => {
      this.requireAllowedPath(path);
      const file = this.filesByPath.get(path);
      if (!file) throw new Error("Note was not found in the vault snapshot");
      return { path, file };
    });
    const notes: Array<{ path: string; sha: string; content: string; truncated: boolean }> = [];
    let nextReturnedCharacters = this.returnedCharacters;
    const remainingForCall = 80_000 - nextReturnedCharacters;
    if (remainingForCall < requested.length) throw new Error("Agent note-read budget was exhausted");
    const perNoteLimit = Math.min(16_000, Math.floor(remainingForCall / requested.length));
    const loadedDocuments: VaultDocument[] = [];
    for (const { path, file } of requested) {
      this.signal?.throwIfAborted();
      const cached = this.documentCache.get(path);
      const note = cached ?? await readMarkdownBlobAtSha(this.token, this.vault, path, file.sha, this.signal);
      this.signal?.throwIfAborted();
      const content = note.content.slice(0, perNoteLimit);
      nextReturnedCharacters += content.length;
      loadedDocuments.push({ path, sha: note.sha, content: note.content });
      notes.push({ path, sha: note.sha, content, truncated: content.length < note.content.length });
    }
    this.returnedCharacters = nextReturnedCharacters;
    for (const document of loadedDocuments) {
      this.documentCache.set(document.path, document);
      this.evidenceByPath.set(document.path, { path: document.path, sha: document.sha });
    }
    const tracedNotes = notes.map(({ path, sha }) => ({ path, sha }));
    return {
      output: safeJson({ revision: this.tree.revision, notes }),
      trace: { id, step, tool: "read_notes", status: "completed", input: { paths: uniquePaths }, summary: `Read ${notes.length} notes`, notes: tracedNotes },
    };
  }

  private async getNoteLinks(input: z.infer<typeof linksSchema>, id: string, step: number): Promise<AgentToolExecution> {
    this.requireAllowedPath(input.path);
    const graph = await this.graph();
    const note = noteByPath(graph, input.path);
    if (!note) throw new Error("Note was not found in the graph snapshot");
    return {
      output: safeJson({ revision: this.tree.revision, note }),
      trace: { id, step, tool: "get_note_links", status: "completed", input: { path: note.path }, summary: `Checked ${note.outgoing.length} links and ${note.backlinks.length} backlinks`, notes: [{ path: note.path, sha: note.sha }] },
    };
  }

  private async getGraphOverview(input: z.infer<typeof graphSchema>, id: string, step: number): Promise<AgentToolExecution> {
    const graph = await this.graph();
    const prominent = [...graph.notes].sort((left, right) => {
      const rightDegree = right.outgoing.length + right.backlinks.length;
      const leftDegree = left.outgoing.length + left.backlinks.length;
      return rightDegree - leftDegree || left.path.localeCompare(right.path);
    }).slice(0, input.limit).map((note) => ({ path: note.path, sha: note.sha, title: note.title, tags: note.tags, outgoing: note.outgoing.length, backlinks: note.backlinks.length }));
    const tags = [...graph.notes.flatMap(({ tags }) => tags).reduce((counts, tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1), new Map<string, number>())]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20).map(([tag, count]) => ({ tag, count }));
    return {
      output: safeJson({ revision: this.tree.revision, stats: { notes: graph.notes.length, edges: graph.edges.length, unresolved: graph.unresolved.length }, prominent, tags }),
      trace: { id, step, tool: "get_graph_overview", status: "completed", input: {}, summary: `Inspected a graph with ${graph.notes.length} notes and ${graph.edges.length} links`, notes: prominent.map(({ path, sha }) => ({ path, sha })) },
    };
  }

  private async getGraphNeighbors(input: z.infer<typeof neighborsSchema>, id: string, step: number): Promise<AgentToolExecution> {
    this.requireAllowedPath(input.path);
    const graph = await this.graph();
    const source = noteByPath(graph, input.path);
    if (!source) throw new Error("Note was not found in the graph snapshot");
    const paths = input.direction === "outgoing"
      ? source.outgoing
      : input.direction === "backlinks"
        ? source.backlinks
        : [...new Set([...source.outgoing, ...source.backlinks])].sort();
    const neighbors = paths.slice(0, input.limit).flatMap((path) => {
      const note = noteByPath(graph, path);
      return note ? [{
        path: note.path,
        sha: note.sha,
        title: note.title,
        tags: note.tags,
        outgoing: note.outgoing.length,
        backlinks: note.backlinks.length,
      }] : [];
    });
    return {
      output: safeJson({ revision: this.tree.revision, source: source.path, direction: input.direction, total: paths.length, neighbors }),
      trace: {
        id,
        step,
        tool: "get_graph_neighbors",
        status: "completed",
        input: { path: source.path, direction: input.direction },
        summary: `Found ${paths.length} notes connected to ${source.title}`,
        notes: [{ path: source.path, sha: source.sha }, ...neighbors.map(({ path, sha }) => ({ path, sha }))],
      },
    };
  }

  private async findGraphPath(input: z.infer<typeof pathSchema>, id: string, step: number): Promise<AgentToolExecution> {
    this.requireAllowedPath(input.from_path);
    this.requireAllowedPath(input.to_path);
    const graph = await this.graph();
    const path = findShortestPath(graph, input.from_path, input.to_path, input.direction, input.max_depth);
    const notes = (path ?? []).flatMap((notePath) => {
      const note = noteByPath(graph, notePath);
      return note ? [{ path: note.path, sha: note.sha }] : [];
    });
    return {
      output: safeJson({ revision: this.tree.revision, from: input.from_path, to: input.to_path, direction: input.direction, path: path ?? null }),
      trace: {
        id,
        step,
        tool: "find_graph_path",
        status: "completed",
        input: { from_path: input.from_path, to_path: input.to_path, direction: input.direction },
        summary: path ? `Found a ${path.length - 1}-link path` : "No path was found within the selected depth",
        notes,
      },
    };
  }

  private visibleFiles(prefix?: string) {
    return this.tree.files.filter(({ path }) => this.allowedPath(path) && (!prefix || path.startsWith(`${prefix}/`)));
  }

  private async documents(): Promise<VaultDocument[]> {
    const scopedTree = { ...this.tree, files: this.tree.files.filter(({ path }) => this.allowedPath(path)) };
    this.documentsPromise ??= readMarkdownTree(this.token, this.vault, scopedTree, this.signal).then((documents) => {
      this.signal?.throwIfAborted();
      for (const document of documents) this.documentCache.set(document.path, document);
      return documents;
    });
    return this.documentsPromise;
  }

  private async graph(): Promise<VaultGraph> {
    this.graphPromise ??= this.documents().then((documents) => {
      this.signal?.throwIfAborted();
      const graph = buildVaultGraph(documents);
      this.signal?.throwIfAborted();
      return graph;
    });
    return this.graphPromise;
  }

  private allowedPath(path: string): boolean {
    if (this.scope === "note") return path === this.activePath;
    if (this.scope === "folder" && this.pathPrefix) return path.startsWith(`${this.pathPrefix}/`);
    return true;
  }

  private requireAllowedPath(path: string): void {
    if (!this.allowedPath(path)) throw new Error("Note is outside the selected chat scope");
  }

  private scopedPrefix(requested?: string): string | undefined {
    const normalized = normalizePrefix(requested);
    if (this.scope === "note") return undefined;
    if (this.scope !== "folder" || !this.pathPrefix) return normalized;
    if (!normalized) return this.pathPrefix;
    if (normalized === this.pathPrefix || normalized.startsWith(`${this.pathPrefix}/`)) return normalized;
    throw new Error("Folder prefix is outside the selected chat scope");
  }
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error("Tool arguments are not valid JSON"); }
}

function normalizePrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.length > 500 || normalized.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("Folder prefix is invalid");
  }
  return normalized;
}

function isToolName(value: string): value is VaultAgentToolName {
  return vaultAgentToolDefinitions.some(({ name }) => name === value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}
