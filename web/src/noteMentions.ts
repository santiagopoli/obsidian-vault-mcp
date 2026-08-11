export const MAX_NOTE_MENTIONS = 10;

export interface ActiveNoteMention {
  start: number;
  end: number;
  query: string;
}

export interface NoteMentionInsertion {
  value: string;
  caret: number;
}

export type MentionEditorPart =
  | { type: "text"; text: string }
  | { type: "mention"; path: string };

export type MentionMenuKeyAction =
  | { type: "none" }
  | { type: "navigate"; index: number }
  | { type: "select"; index: number }
  | { type: "close" };

interface MentionableNote {
  path: string;
}

const mentionPattern = /@\[\[([^\r\n]*?)\]\]/g;

export function activeNoteMention(value: string, caret = value.length): ActiveNoteMention | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return undefined;
  const prefix = value.slice(0, caret);
  const match = /(?:^|[\s(]|\]\])@([^@\[\]\r\n]{0,80})$/.exec(prefix);
  if (!match) return undefined;
  const start = prefix.lastIndexOf("@");
  return { start, end: caret, query: (match[1] ?? "").trim() };
}

export function extractMentionedPaths(value: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(mentionPattern)) {
    const path = match[1] ?? "";
    if (!isMentionPath(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function parseMentionDocument(value: string, validPaths?: ReadonlySet<string>): MentionEditorPart[] {
  const parts: MentionEditorPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(mentionPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    const path = match[1] ?? "";
    appendText(parts, value.slice(cursor, index));
    if (isMentionPath(path) && (!validPaths || validPaths.has(path))) parts.push({ type: "mention", path });
    else appendText(parts, token);
    cursor = index + token.length;
  }
  appendText(parts, value.slice(cursor));
  return parts;
}

export function serializeMentionDocument(parts: readonly MentionEditorPart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    assertMentionPath(part.path);
    return `@[[${part.path}]]`;
  }).join("");
}

export function removeMentionOccurrence(parts: readonly MentionEditorPart[], occurrence: number): MentionEditorPart[] {
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error("Invalid note mention occurrence");
  let current = 0;
  let removed = false;
  const result: MentionEditorPart[] = [];
  for (const part of parts) {
    if (part.type === "mention" && current++ === occurrence) {
      removed = true;
      continue;
    }
    if (part.type === "text") appendText(result, part.text);
    else result.push(part);
  }
  if (!removed) throw new Error("Note mention occurrence was not found");
  return result;
}

export function mentionMenuKeyAction(key: string, activeIndex: number, optionCount: number, isComposing = false): MentionMenuKeyAction {
  if (isComposing) return { type: "none" };
  if (key === "Escape") return { type: "close" };
  if (optionCount <= 0) return { type: "none" };
  const index = modulo(activeIndex, optionCount);
  if (key === "ArrowDown") return { type: "navigate", index: (index + 1) % optionCount };
  if (key === "ArrowUp") return { type: "navigate", index: (index - 1 + optionCount) % optionCount };
  if (key === "Enter" || key === "Tab") return { type: "select", index };
  return { type: "none" };
}

export function suggestNoteMentions(
  notes: readonly MentionableNote[],
  query: string,
  mentionedPaths: readonly string[] = [],
  limit = 8,
): MentionableNote[] {
  if (mentionedPaths.length >= MAX_NOTE_MENTIONS || limit <= 0) return [];
  const excluded = new Set(mentionedPaths);
  const needle = searchable(query.trim());
  return notes
    .filter(({ path }) => isMentionPath(path) && !excluded.has(path))
    .flatMap((note) => {
      const path = searchable(note.path);
      const title = searchable(basename(note.path));
      const score = mentionScore(title, path, needle);
      return score === undefined ? [] : [{ note, score, title }];
    })
    .sort((left, right) => left.score - right.score || left.title.localeCompare(right.title) || left.note.path.localeCompare(right.note.path))
    .slice(0, Math.min(limit, MAX_NOTE_MENTIONS - mentionedPaths.length))
    .map(({ note }) => note);
}

export function insertNoteMention(value: string, mention: ActiveNoteMention, path: string): NoteMentionInsertion {
  if (mention.start < 0 || mention.end < mention.start || mention.end > value.length) throw new Error("Invalid note mention range");
  assertMentionPath(path);
  const token = `@[[${path}]]`;
  const suffix = value.slice(mention.end);
  const separator = suffix.length === 0 || !/^[\s.,;:!?)}\]"'»”’—–]/.test(suffix) ? " " : "";
  const inserted = `${token}${separator}`;
  return {
    value: `${value.slice(0, mention.start)}${inserted}${suffix}`,
    caret: mention.start + inserted.length,
  };
}

function appendText(parts: MentionEditorPart[], text: string): void {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") previous.text += text;
  else parts.push({ type: "text", text });
}

function assertMentionPath(path: string): void {
  if (!isMentionPath(path)) throw new Error("Invalid note mention path");
}

function isMentionPath(path: string): boolean {
  return Boolean(path) && path.trim() === path && !/[\r\n]/.test(path) && !path.includes("]]");
}

function modulo(value: number, divisor: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0;
  return ((integer % divisor) + divisor) % divisor;
}

function mentionScore(title: string, path: string, query: string): number | undefined {
  if (!query) return 5;
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (path.split("/").some((segment) => segment.startsWith(query))) return 2;
  if (title.includes(query)) return 3;
  if (path.includes(query)) return 4;
  return undefined;
}

function basename(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

function searchable(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}
