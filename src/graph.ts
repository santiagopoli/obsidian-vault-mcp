import { parse as parseYaml } from "yaml";

export interface VaultDocument {
  path: string;
  sha: string;
  content: string;
}

export type GraphEdgeKind = "wikilink" | "markdown";

export interface GraphEdge {
  source: string;
  target: string;
  targetText: string;
  kind: GraphEdgeKind;
  embedded: boolean;
  subpath?: string;
  displayText?: string;
}

export interface UnresolvedGraphLink {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  embedded: boolean;
  status: "unresolved" | "ambiguous";
  candidates?: string[];
  subpath?: string;
  displayText?: string;
}

export interface GraphNote {
  path: string;
  sha: string;
  title: string;
  aliases: string[];
  tags: string[];
  outgoing: string[];
  backlinks: string[];
  embeds: string[];
  unresolved: string[];
}

export interface VaultGraph {
  notes: GraphNote[];
  edges: GraphEdge[];
  unresolved: UnresolvedGraphLink[];
}

interface ParsedDocument {
  path: string;
  sha: string;
  title: string;
  aliases: string[];
  tags: string[];
  links: Array<{
    target: string;
    kind: GraphEdgeKind;
    embedded: boolean;
    subpath?: string;
    displayText?: string;
  }>;
}

interface ResolvedTarget {
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  candidates?: string[];
}

export function buildVaultGraph(documents: VaultDocument[]): VaultGraph {
  const parsed = documents.map(parseDocument).sort((left, right) => left.path.localeCompare(right.path));
  const paths = parsed.map(({ path }) => path);
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedGraphLink[] = [];
  const edgeKeys = new Set<string>();
  const unresolvedKeys = new Set<string>();

  for (const document of parsed) {
    for (const link of document.links) {
      const resolved = resolveLinkTarget(document.path, link.target, paths, link.kind === "markdown");
      if (resolved.status === "resolved" && resolved.path) {
        const key = `${document.path}\u0000${resolved.path}\u0000${link.kind}\u0000${link.embedded}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({
            source: document.path,
            target: resolved.path,
            targetText: link.target,
            kind: link.kind,
            embedded: link.embedded,
            ...(link.subpath ? { subpath: link.subpath } : {}),
            ...(link.displayText ? { displayText: link.displayText } : {}),
          });
        }
      } else {
        const key = `${document.path}\u0000${link.target}\u0000${link.kind}\u0000${link.embedded}`;
        if (!unresolvedKeys.has(key)) {
          unresolvedKeys.add(key);
          unresolved.push({
            source: document.path,
            target: link.target,
            kind: link.kind,
            embedded: link.embedded,
            status: resolved.status === "ambiguous" ? "ambiguous" : "unresolved",
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
            ...(link.subpath ? { subpath: link.subpath } : {}),
            ...(link.displayText ? { displayText: link.displayText } : {}),
          });
        }
      }
    }
  }

  edges.sort(compareLinks);
  unresolved.sort(compareLinks);
  const notes = parsed.map((document) => {
    const outgoing = uniqueSorted(edges.filter(({ source }) => source === document.path).map(({ target }) => target));
    const backlinks = uniqueSorted(edges.filter(({ target }) => target === document.path).map(({ source }) => source));
    const embeds = uniqueSorted(
      edges.filter(({ source, embedded }) => source === document.path && embedded).map(({ target }) => target),
    );
    const missing = uniqueSorted(unresolved.filter(({ source }) => source === document.path).map(({ target }) => target));
    return {
      path: document.path,
      sha: document.sha,
      title: document.title,
      aliases: document.aliases,
      tags: document.tags,
      outgoing,
      backlinks,
      embeds,
      unresolved: missing,
    };
  });

  return { notes, edges, unresolved };
}

export function noteByPath(graph: VaultGraph, path: string): GraphNote | undefined {
  const visiblePath = path.replaceAll("\\", "/").replace(/^\/+/, "").normalize("NFC");
  const exact = graph.notes.find((note) => note.path.normalize("NFC") === visiblePath);
  if (exact) return exact;
  const folded = graph.notes.filter((note) => normalizePath(note.path) === normalizePath(visiblePath));
  return folded.length === 1 ? folded[0] : undefined;
}

export function isGraphOrphan(graph: VaultGraph, path: string): boolean {
  return !graph.edges.some((edge) =>
    (edge.source === path && edge.target !== path) || (edge.target === path && edge.source !== path));
}

export function findShortestPath(
  graph: VaultGraph,
  source: string,
  target: string,
  direction: "outgoing" | "backlinks" | "both",
  maxDepth: number,
): string[] | undefined {
  const sourceNote = noteByPath(graph, source);
  const targetNote = noteByPath(graph, target);
  if (!sourceNote) throw new Error(`Graph note '${source}' was not found; use obsidian_get_graph to discover exact paths`);
  if (!targetNote) throw new Error(`Graph note '${target}' was not found; use obsidian_get_graph to discover exact paths`);
  if (sourceNote.path === targetNote.path) return [sourceNote.path];

  const queue: string[][] = [[sourceNote.path]];
  const visited = new Set([sourceNote.path]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    if (path.length - 1 >= maxDepth) continue;
    const current = noteByPath(graph, path.at(-1) ?? "");
    if (!current) continue;
    const neighbors = direction === "outgoing"
      ? current.outgoing
      : direction === "backlinks"
        ? current.backlinks
        : uniqueSorted([...current.outgoing, ...current.backlinks]);
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      const next = [...path, neighbor];
      if (neighbor === targetNote.path) return next;
      visited.add(neighbor);
      queue.push(next);
    }
  }
  return undefined;
}

function parseDocument(document: VaultDocument): ParsedDocument {
  const { frontmatter } = splitFrontmatter(document.content);
  const fields = parseFrontmatter(frontmatter);
  const searchable = stripCode(document.content);
  const links: ParsedDocument["links"] = [];

  for (const match of searchable.matchAll(/(?<!\\)(!?)\[\[([^\]\n]+)\]\]/g)) {
    const inner = match[2] ?? "";
    const separator = inner.indexOf("|");
    const raw = (separator >= 0 ? inner.slice(0, separator) : inner).trim();
    const displayText = separator >= 0 ? inner.slice(separator + 1).trim() : undefined;
    const parsedTarget = splitSubpath(raw);
    if (parsedTarget.target && isLocalWikiTarget(parsedTarget.target)) {
      links.push({
        target: parsedTarget.target,
        kind: "wikilink",
        embedded: match[1] === "!",
        ...(parsedTarget.subpath ? { subpath: parsedTarget.subpath } : {}),
        ...(displayText ? { displayText } : {}),
      });
    }
  }
  for (const match of searchable.matchAll(/(?<!\\)(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
    const raw = match[3]?.trim().replace(/^<|>$/g, "");
    if (raw && isLocalMarkdownTarget(raw)) {
      const parsedTarget = splitSubpath(raw);
      links.push({
        target: parsedTarget.target,
        kind: "markdown",
        embedded: match[1] === "!",
        ...(parsedTarget.subpath ? { subpath: parsedTarget.subpath } : {}),
        ...(match[2] ? { displayText: match[2] } : {}),
      });
    }
  }

  const tags = new Set(fields.tags);
  for (const match of searchable.matchAll(/(^|[\s(>])#([\p{L}\p{N}_/-]+)/gmu)) {
    if (match[2]) tags.add(match[2]);
  }

  return {
    path: document.path,
    sha: document.sha,
    title: fields.title ?? basenameWithoutExtension(document.path),
    aliases: uniqueSorted(fields.aliases),
    tags: uniqueSorted(tags),
    links,
  };
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return match ? { frontmatter: match[1] ?? "", body: content.slice(match[0].length) } : { frontmatter: "", body: content };
}

function parseFrontmatter(frontmatter: string): { title?: string; aliases: string[]; tags: string[] } {
  if (!frontmatter) return { aliases: [], tags: [] };
  let value: unknown;
  try {
    value = parseYaml(frontmatter);
  } catch {
    return { aliases: [], tags: [] };
  }
  if (!isRecord(value)) return { aliases: [], tags: [] };
  const title = typeof value.title === "string" ? value.title.trim() : undefined;
  const aliases = [...stringValues(value.aliases), ...stringValues(value.alias)];
  const tags = [...stringValues(value.tags), ...stringValues(value.tag)].map((tag) => tag.replace(/^#/, ""));
  return { ...(title ? { title } : {}), aliases: uniqueSorted(aliases), tags: uniqueSorted(tags) };
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCode(content: string): string {
  return content
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, "\n")
    .replace(/`[^`\n]*`/g, "");
}

function splitSubpath(target: string): { target: string; subpath?: string } {
  const query = target.indexOf("?");
  const withoutQuery = query < 0 ? target : target.slice(0, query);
  const marker = withoutQuery.search(/[#^]/);
  if (marker < 0) return { target: withoutQuery.trim() };
  const path = withoutQuery.slice(0, marker).trim();
  const subpath = withoutQuery.slice(marker).trim();
  return { target: path, ...(subpath ? { subpath } : {}) };
}

function isLocalWikiTarget(target: string): boolean {
  const filename = target.split("/").at(-1) ?? target;
  return !filename.includes(".") || filename.toLowerCase().endsWith(".md");
}

function isLocalMarkdownTarget(target: string): boolean {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) return false;
  return target.split(/[?#]/, 1)[0]?.toLowerCase().endsWith(".md") ?? false;
}

function resolveLinkTarget(source: string, rawTarget: string, paths: string[], markdown: boolean): ResolvedTarget {
  const withoutFragment = rawTarget.trim();
  if (!withoutFragment) return { status: "unresolved" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  const target = decoded.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  if (!target) return { status: "unresolved" };

  const sourceDirectory = source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "";
  const relative = normalizeRelativePath(sourceDirectory, target);
  const absolute = `${target}.md`;
  const candidates = markdown ? [relative, absolute] : [absolute, relative];
  for (const candidate of candidates) {
    const exact = paths.find((path) => path.normalize("NFC") === candidate.normalize("NFC"));
    if (exact) return { status: "resolved", path: exact };
    const folded = paths.filter((path) => normalizePath(path) === normalizePath(candidate));
    if (folded.length === 1 && folded[0]) return { status: "resolved", path: folded[0] };
    if (folded.length > 1) return { status: "ambiguous", candidates: folded.sort((a, b) => a.localeCompare(b)) };
  }

  const basename = target.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const basenameMatches = paths.filter((path) => basenameWithoutExtension(path).toLocaleLowerCase() === basename);
  if (basenameMatches.length === 1 && basenameMatches[0]) return { status: "resolved", path: basenameMatches[0] };
  if (basenameMatches.length > 1) {
    return { status: "ambiguous", candidates: basenameMatches.sort((left, right) => left.localeCompare(right)) };
  }
  return { status: "unresolved" };
}

function normalizeRelativePath(directory: string, target: string): string {
  const segments = [...(directory ? directory.split("/") : []), ...target.split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") normalized.pop();
    else normalized.push(segment);
  }
  return `${normalized.join("/")}.md`;
}

function basenameWithoutExtension(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").normalize("NFC").toLocaleLowerCase();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareLinks(left: { source: string; target: string; kind: string }, right: { source: string; target: string; kind: string }): number {
  return left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.kind.localeCompare(right.kind);
}
