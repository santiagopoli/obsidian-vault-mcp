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

interface MentionableNote {
  path: string;
}

const mentionPattern = /@\[\[([^\r\n]*?)\]\]/g;

export function activeNoteMention(value: string, caret = value.length): ActiveNoteMention | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return undefined;
  const prefix = value.slice(0, caret);
  const match = /(?:^|[\s(])@([^@\[\]\r\n]{0,80})$/.exec(prefix);
  if (!match) return undefined;
  const start = prefix.lastIndexOf("@");
  return { start, end: caret, query: (match[1] ?? "").trim() };
}

export function extractMentionedPaths(value: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of value.matchAll(mentionPattern)) {
    const path = (match[1] ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
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
    .filter(({ path }) => path.length > 0 && !path.includes("\n") && !excluded.has(path))
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
  if (!path || /[\r\n]/.test(path)) throw new Error("Invalid note mention path");
  const token = `@[[${path}]]`;
  const suffix = value.slice(mention.end);
  const separator = suffix.length === 0 || !/^\s/.test(suffix) ? " " : "";
  const inserted = `${token}${separator}`;
  return {
    value: `${value.slice(0, mention.start)}${inserted}${suffix}`,
    caret: mention.start + inserted.length,
  };
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
