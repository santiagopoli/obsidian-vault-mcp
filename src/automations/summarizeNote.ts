import type { SummarizeNoteAutomationTarget } from "./types";

const managedPrefix = "<!-- obsidian-vault-mcp-managed ";

export interface ExactSummarySource {
  path: string;
  sha: string;
  content: string;
}

export interface ExistingSummary {
  sha: string;
  content: string;
}

export interface SummaryWriteRequest {
  content: string;
  expectedSha?: string;
  idempotencyKey: string;
}

export interface SummaryWriteReceipt {
  contentSha: string;
  commitSha: string;
  created: boolean;
}

export interface PreboundSummaryWriter {
  path: string;
  read(): Promise<ExistingSummary | undefined>;
  write(request: SummaryWriteRequest): Promise<SummaryWriteReceipt>;
}

export type SummarizeNoteModel = (input: {
  path: string;
  content: string;
  model: string;
  maxCharacters: number;
}) => Promise<string>;

export interface SummarizeNoteRequest {
  automationId: string;
  eventId: string;
  source: ExactSummarySource;
  target: SummarizeNoteAutomationTarget;
  model: SummarizeNoteModel;
  writer: PreboundSummaryWriter;
}

export type SummarizeNoteResult =
  | {
      status: "replayed";
      path: string;
      contentSha: string;
      sourceSha: string;
      eventId: string;
    }
  | {
      status: "written";
      path: string;
      sourceSha: string;
      eventId: string;
      receipt: SummaryWriteReceipt;
    };

interface SummaryProvenance {
  version: 1;
  handler: "summarize-note";
  owner: string;
  eventId: string;
  sourceSha: string;
}

export async function summarizeNote(request: SummarizeNoteRequest): Promise<SummarizeNoteResult> {
  const sourcePath = normalizeMarkdownPath(request.source.path, "Source path");
  const sourceSha = normalizeSha(request.source.sha, "Source SHA");
  const owner = normalizeOwner(request.automationId);
  const eventId = normalizeEventId(request.eventId);
  const outputPath = summaryOutputPath(request.target.output.directory, sourcePath);
  if (request.writer.path !== outputPath) {
    throw new Error(`Summary writer must be prebound to '${outputPath}'`);
  }

  const existing = await request.writer.read();
  if (existing) {
    const provenance = readProvenance(existing.content);
    if (!provenance) throw new Error(`Summary output '${outputPath}' is not managed by obsidian-vault-mcp`);
    if (provenance.owner !== owner || provenance.handler !== "summarize-note") {
      throw new Error(`Summary output '${outputPath}' is managed by another automation`);
    }
    if (provenance.eventId === eventId && provenance.sourceSha === sourceSha) {
      return { status: "replayed", path: outputPath, contentSha: existing.sha, sourceSha, eventId };
    }
  }

  const modelInput = request.target.input.include_frontmatter
    ? request.source.content
    : stripMarkdownFrontmatter(request.source.content);
  if (characterCount(modelInput) > request.target.input.max_characters) {
    throw new Error(`Summary input exceeds the ${request.target.input.max_characters}-character limit`);
  }
  if (!modelInput.trim()) throw new Error("Summary input must not be empty");

  const summary = (await request.model({
    path: sourcePath,
    content: modelInput,
    model: request.target.model.name,
    maxCharacters: request.target.output.max_characters,
  })).trim();
  if (!summary) throw new Error("Summary model returned empty output");
  if (characterCount(summary) > request.target.output.max_characters) {
    throw new Error(`Summary output exceeds the ${request.target.output.max_characters}-character limit`);
  }

  const provenance: SummaryProvenance = {
    version: 1,
    handler: "summarize-note",
    owner,
    eventId,
    sourceSha,
  };
  const content = `${managedPrefix}${JSON.stringify(provenance)} -->\n\n${summary}\n`;
  const receipt = await request.writer.write({
    content,
    ...(existing ? { expectedSha: existing.sha } : {}),
    idempotencyKey: `automation:v1:${owner}:${eventId}`,
  });
  return { status: "written", path: outputPath, sourceSha, eventId, receipt };
}

export function summaryOutputPath(directory: string, sourcePath: string): string {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedSource = normalizeMarkdownPath(sourcePath, "Source path");
  const relative = normalizedSource.replace(/\.md$/i, ".summary.md");
  return normalizeMarkdownPath(`${normalizedDirectory}/${relative}`, "Summary output path");
}

export function stripMarkdownFrontmatter(content: string): string {
  const match = content.match(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return match ? content.slice(match[0].length) : content;
}

function readProvenance(content: string): SummaryProvenance | undefined {
  const firstLineEnd = content.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? content : content.slice(0, firstLineEnd)).replace(/\r$/, "");
  if (!firstLine.startsWith(managedPrefix) || !firstLine.endsWith(" -->")) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(firstLine.slice(managedPrefix.length, -4));
  } catch {
    throw new Error("Summary output contains invalid managed provenance");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.handler !== "summarize-note" ||
    typeof value.owner !== "string" ||
    typeof value.eventId !== "string" ||
    typeof value.sourceSha !== "string"
  ) {
    throw new Error("Summary output contains invalid managed provenance");
  }
  return value as unknown as SummaryProvenance;
}

function normalizeDirectory(directory: string): string {
  const normalized = directory.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 400 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("Summary directory must be a visible relative folder");
  }
  return normalized;
}

function normalizeMarkdownPath(path: string, label: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 500 ||
    !normalized.toLowerCase().endsWith(".md") ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error(`${label} must be a visible Markdown path`);
  }
  return normalized;
}

function normalizeSha(sha: string, label: string): string {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${label} must be a 40-character Git object ID`);
  return sha.toLowerCase();
}

function normalizeOwner(owner: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(owner)) {
    throw new Error("Summary owner must be a lower-case automation identifier");
  }
  return owner;
}

function normalizeEventId(eventId: string): string {
  if (!eventId || eventId.length > 2_000 || /[\u0000-\u001f\u007f]|-->/.test(eventId)) {
    throw new Error("Summary event ID is invalid");
  }
  return eventId;
}

function characterCount(value: string): number {
  return [...value].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
