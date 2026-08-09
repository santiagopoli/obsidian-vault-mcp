import type { NoteSummary } from "./api";

export interface PreparedMarkdown {
  body: string;
  properties: Array<{ name: string; value: string }>;
}

export function prepareObsidianMarkdown(content: string): PreparedMarkdown {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const properties = frontmatter ? parseProperties(frontmatter[1] ?? "") : [];
  let body = frontmatter ? content.slice(frontmatter[0].length) : content;
  body = body.replace(/%%[\s\S]*?%%/g, "");
  body = body.replace(/!\[\[([^\]\n]+)\]\]/g, (_, raw: string) => {
    const { target, label } = wikiParts(raw);
    if (!isMarkdownTarget(target)) return `*Embedded media omitted: ${escapeMarkdown(label)}*`;
    return `[Embedded: ${escapeMarkdown(label)}](${internalHref(target)})`;
  });
  body = body.replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (_, raw: string) => {
    const { target, label } = wikiParts(raw);
    return `[${escapeMarkdown(label)}](${internalHref(target)})`;
  });
  body = body.replace(/^(>\s*)\[!([\w-]+)\][+-]?\s*(.*)$/gim, (_, quote: string, type: string, title: string) => {
    const label = title.trim() || type[0]?.toUpperCase() + type.slice(1);
    return `${quote}**${escapeMarkdown(label)}**`;
  });
  return { body, properties };
}

export function resolveInternalNotePath(href: string, currentPath: string, notes: NoteSummary[]): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.replace(/^vault-note:/, ""));
  } catch {
    return undefined;
  }
  const target = decoded.split("#", 1)[0]?.split("^", 1)[0]?.replace(/\.md$/i, "") ?? "";
  if (!target) return undefined;
  const normalizedTarget = normalizePath(target);
  const currentDirectory = currentPath.split("/").slice(0, -1).join("/");
  const relativeCandidate = normalizePath(currentDirectory ? `${currentDirectory}/${normalizedTarget}` : normalizedTarget);
  const exact = notes.find((note) => stripExtension(normalizePath(note.path)) === stripExtension(relativeCandidate));
  if (exact) return exact.path;
  const globalMatches = notes.filter((note) => {
    const path = stripExtension(normalizePath(note.path));
    return path === stripExtension(normalizedTarget) || path.endsWith(`/${stripExtension(normalizedTarget)}`);
  });
  if (globalMatches.length === 1) return globalMatches[0]?.path;
  const basename = stripExtension(normalizedTarget).split("/").pop();
  const basenameMatches = notes.filter((note) => stripExtension(note.path).split("/").pop() === basename);
  return basenameMatches.length === 1 ? basenameMatches[0]?.path : undefined;
}

export function markdownLinkTarget(href: string, currentPath: string): string | undefined {
  if (!href || /^(https?:|mailto:)/i.test(href) || href.startsWith("#")) return undefined;
  if (href.startsWith("vault-note:")) return href;
  const [path, fragment] = href.split("#", 2);
  if (!path?.toLowerCase().endsWith(".md")) return undefined;
  const directory = currentPath.split("/").slice(0, -1);
  const resolved = normalizePath([...directory, ...path.split("/")].join("/"));
  return internalHref(`${resolved}${fragment ? `#${fragment}` : ""}`);
}

function parseProperties(source: string): Array<{ name: string; value: string }> {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([\w.-]+):\s*(.*)$/);
    return match ? [{ name: match[1] ?? "", value: (match[2] || "—").replace(/^['"]|['"]$/g, "") }] : [];
  });
}

function wikiParts(raw: string): { target: string; label: string } {
  const [targetPart = "", alias] = raw.split("|", 2);
  const target = targetPart.trim();
  return { target, label: alias?.trim() || target.split("#", 1)[0]?.split("/").pop() || target };
}

function isMarkdownTarget(target: string): boolean {
  const path = target.split("#", 1)[0] ?? target;
  return !/\.[A-Za-z0-9]{1,8}$/.test(path) || path.toLowerCase().endsWith(".md");
}

function internalHref(target: string): string {
  return `vault-note:${encodeURIComponent(target)}`;
}

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") output.pop();
    else output.push(segment);
  }
  return output.join("/");
}

function stripExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*{}\[\]()#+.!|>_-]/g, "\\$&");
}
