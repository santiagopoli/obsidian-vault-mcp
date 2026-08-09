import type { GitHubTreeItem, VaultConfig } from "./types";
import type { VaultDocument } from "./graph";

const githubApi = "https://api.github.com";
const maxNoteBytes = 512_000;
const maxGraphNotes = 1_000;
const maxGraphBytes = 8_000_000;
const graphBlobBatchSize = 20;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function headers(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "obsidian-vault-mcp-server",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${githubApi}${path}`, { headers: headers(token) });
  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    throw new GitHubError(
      `GitHub request failed (${response.status})${requestId ? `, request ${requestId}` : ""}`,
      response.status,
    );
  }
  return response.json<T>();
}

export function normalizeNotePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    !normalized.toLowerCase().endsWith(".md") ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("Note path must be a visible Markdown file inside the vault");
  }
  return normalized;
}

function normalizePrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  const normalized = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/");
  if (
    normalized.length > 500 ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error("Folder prefix must identify a visible folder inside the vault");
  }
  return normalized;
}

export async function listMarkdownFiles(
  token: string,
  vault: VaultConfig,
  prefix?: string,
): Promise<GitHubTreeItem[]> {
  return (await getMarkdownTree(token, vault, prefix)).files;
}

export interface MarkdownTree {
  revision: string;
  files: GitHubTreeItem[];
}

export async function getMarkdownTree(
  token: string,
  vault: VaultConfig,
  prefix?: string,
): Promise<MarkdownTree> {
  const repository = await getRepositoryMetadata(token, vault);
  return getMarkdownTreeAtRevision(token, vault, repository.defaultBranch, prefix);
}

export interface GitHubRepositoryMetadata {
  id: string;
  defaultBranch: string;
}

export async function getRepositoryMetadata(token: string, vault: VaultConfig): Promise<GitHubRepositoryMetadata> {
  const repository = await githubFetch<{ id: number; default_branch: string }>(
    token,
    `/repos/${vault.owner}/${vault.repo}`,
  );
  return { id: String(repository.id), defaultBranch: repository.default_branch };
}

export async function getMarkdownTreeAtRevision(
  token: string,
  vault: VaultConfig,
  revision: string,
  prefix?: string,
): Promise<MarkdownTree> {
  if (!/^[0-9a-f]{40}$/i.test(revision) && !/^[A-Za-z0-9._/-]{1,255}$/.test(revision)) {
    throw new Error("GitHub tree revision is invalid");
  }
  const tree = await githubFetch<{ sha: string; tree: GitHubTreeItem[]; truncated: boolean }>(
    token,
    `/repos/${vault.owner}/${vault.repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
  );
  if (tree.truncated) {
    throw new Error("Vault tree is too large for a recursive GitHub listing");
  }

  const normalizedPrefix = normalizePrefix(prefix);
  const files = tree.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        item.path.toLowerCase().endsWith(".md") &&
        !item.path.split("/").some((segment) => segment.startsWith(".")) &&
        (!normalizedPrefix || item.path === normalizedPrefix || item.path.startsWith(`${normalizedPrefix}/`)),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  return { revision: tree.sha, files };
}

export async function readMarkdownTree(
  token: string,
  vault: VaultConfig,
  tree: MarkdownTree,
): Promise<VaultDocument[]> {
  if (tree.files.length > maxGraphNotes) {
    throw new Error(`Vault graph is limited to ${maxGraphNotes} Markdown notes; narrow or split this vault`);
  }
  const declaredBytes = tree.files.reduce((total, file) => total + (file.size ?? 0), 0);
  if (declaredBytes > maxGraphBytes) {
    throw new Error(`Vault graph exceeds the ${maxGraphBytes}-byte Markdown budget`);
  }

  const documents: VaultDocument[] = [];
  for (let offset = 0; offset < tree.files.length; offset += graphBlobBatchSize) {
    const files = tree.files.slice(offset, offset + graphBlobBatchSize);
    const blobs = await readBlobBatch(token, vault, files);
    documents.push(...files.map((file, index) => {
      const blob = blobs[`blob${index}`];
      if (!blob || blob.oid !== file.sha || blob.isBinary || blob.text === null) {
        throw new Error(`GitHub returned an unsupported blob for '${file.path}'`);
      }
      if (blob.byteSize > maxNoteBytes) {
        throw new Error(`Note '${file.path}' exceeds the ${maxNoteBytes}-byte graph limit`);
      }
      return { path: file.path, sha: file.sha, content: blob.text };
    }));
  }
  return documents;
}

interface GraphQlBlob {
  oid: string;
  byteSize: number;
  isBinary: boolean;
  text: string | null;
}

async function readBlobBatch(
  token: string,
  vault: VaultConfig,
  files: GitHubTreeItem[],
): Promise<Record<string, GraphQlBlob | null>> {
  const selections = files.map((file, index) => {
    if (!/^[0-9a-f]+$/i.test(file.sha)) throw new Error(`GitHub returned an invalid SHA for '${file.path}'`);
    return `blob${index}: object(oid: "${file.sha}") { ... on Blob { oid byteSize isBinary text } }`;
  }).join("\n");
  const response = await fetch(`${githubApi}/graphql`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query VaultBlobs($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${selections} } }`,
      variables: { owner: vault.owner, repo: vault.repo },
    }),
  });
  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    throw new GitHubError(
      `GitHub graph read failed (${response.status})${requestId ? `, request ${requestId}` : ""}`,
      response.status,
    );
  }
  const result = await response.json<{
    data?: { repository?: Record<string, GraphQlBlob | null> | null };
    errors?: Array<{ message: string }>;
  }>();
  if (result.errors?.length || !result.data?.repository) {
    throw new Error(`GitHub graph read failed: ${result.errors?.[0]?.message ?? "repository was not returned"}`);
  }
  return result.data.repository;
}

export interface MarkdownFile {
  content: string;
  sha: string;
  htmlUrl: string;
}

export interface MarkdownBlob {
  path: string;
  content: string;
  sha: string;
}

export async function readMarkdownBlobAtSha(
  token: string,
  vault: VaultConfig,
  path: string,
  sha: string,
): Promise<MarkdownBlob> {
  const normalized = normalizeNotePath(path);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Markdown blob SHA must be a 40-character Git object ID");

  const blobs = await readBlobBatch(token, vault, [{ path: normalized, sha, type: "blob" }]);
  const blob = blobs.blob0;
  if (!blob || blob.oid !== sha || blob.isBinary || blob.text === null) {
    throw new Error(`GitHub returned an unsupported blob for '${normalized}'`);
  }
  if (blob.byteSize > maxNoteBytes) {
    throw new Error(`Note '${normalized}' exceeds the ${maxNoteBytes}-byte read limit`);
  }
  return { path: normalized, content: blob.text, sha: blob.oid };
}

interface GitHubContentFile {
  content: string;
  encoding: "base64";
  html_url: string;
  sha: string;
  size: number;
  type: "file";
}

export async function readMarkdownFile(
  token: string,
  vault: VaultConfig,
  path: string,
): Promise<MarkdownFile> {
  const normalized = normalizeNotePath(path);
  const file = await githubFetch<GitHubContentFile>(
    token,
    `/repos/${vault.owner}/${vault.repo}/contents/${encodePath(normalized)}`,
  );
  if (file.type !== "file" || file.encoding !== "base64") {
    throw new Error(`GitHub returned an unsupported representation for '${normalized}'`);
  }
  if (file.size > maxNoteBytes) {
    throw new Error(`Note '${normalized}' exceeds the ${maxNoteBytes}-byte read limit`);
  }
  return { content: decodeBase64Utf8(file.content), sha: file.sha, htmlUrl: file.html_url };
}

export interface WriteResult {
  path: string;
  contentSha: string;
  commitSha: string;
  htmlUrl: string;
  created: boolean;
}

export async function writeMarkdownFile(
  token: string,
  vault: VaultConfig,
  path: string,
  content: string,
  expectedSha?: string,
): Promise<WriteResult> {
  const normalized = normalizeNotePath(path);
  if (new TextEncoder().encode(content).byteLength > maxNoteBytes) {
    throw new Error(`Note '${normalized}' exceeds the ${maxNoteBytes}-byte write limit`);
  }

  const existing = await optionalContentFile(token, vault, normalized);
  if (existing && !expectedSha) {
    throw new Error(`Note '${normalized}' already exists; read it and pass its sha as expected_sha`);
  }
  if (!existing && expectedSha) {
    throw new Error(`Note '${normalized}' does not exist, so expected_sha must be omitted`);
  }
  if (existing && expectedSha !== existing.sha) {
    throw new Error(`Note '${normalized}' changed since it was read; read it again before updating`);
  }
  if (existing && decodeBase64Utf8(existing.content) === content) {
    return {
      path: normalized,
      contentSha: existing.sha,
      commitSha: "unchanged",
      htmlUrl: existing.html_url,
      created: false,
    };
  }

  const response = await fetch(
    `${githubApi}/repos/${vault.owner}/${vault.repo}/contents/${encodePath(normalized)}`,
    {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `${existing ? "Update" : "Create"} ${normalized} via Obsidian Vault MCP`,
        content: encodeBase64Utf8(content),
        ...(existing ? { sha: existing.sha } : {}),
      }),
    },
  );
  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    throw new GitHubError(
      `GitHub could not write note '${normalized}' (${response.status})${requestId ? `, request ${requestId}` : ""}`,
      response.status,
    );
  }
  const result = await response.json<{
    content: { path: string; sha: string; html_url: string };
    commit: { sha: string };
  }>();
  return {
    path: result.content.path,
    contentSha: result.content.sha,
    commitSha: result.commit.sha,
    htmlUrl: result.content.html_url,
    created: !existing,
  };
}

async function optionalContentFile(
  token: string,
  vault: VaultConfig,
  path: string,
): Promise<GitHubContentFile | undefined> {
  try {
    return await githubFetch<GitHubContentFile>(
      token,
      `/repos/${vault.owner}/${vault.repo}/contents/${encodePath(path)}`,
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}

export interface SearchMatch {
  path: string;
  sha: string;
  excerpt: string;
  htmlUrl: string;
}

export interface SearchDocumentMatch {
  path: string;
  htmlUrl: string;
  sha: string;
  content: string;
}

export async function searchMarkdownDocuments(
  token: string,
  vault: VaultConfig,
  queries: string[],
  pathPrefix: string | undefined,
  limit: number,
  offset: number,
  requireEveryTerm = true,
): Promise<{ revision: string; total: number; matches: SearchDocumentMatch[] }> {
  const tree = await getMarkdownTree(token, vault, pathPrefix);
  const normalizedPrefix = normalizePrefix(pathPrefix);
  const documents = (await readMarkdownTree(token, vault, tree)).filter(
    (document) => !normalizedPrefix || document.path.startsWith(`${normalizedPrefix}/`),
  );
  return rankMarkdownDocuments(vault, tree.revision, documents, queries, limit, offset, requireEveryTerm);
}

export function rankMarkdownDocuments(
  vault: VaultConfig,
  revision: string,
  documents: VaultDocument[],
  queries: string[],
  limit: number,
  offset: number,
  requireEveryTerm = true,
): { revision: string; total: number; matches: SearchDocumentMatch[] } {
  const normalizedQueries = queries.map(validateSearchQuery);
  if (normalizedQueries.length === 0) throw new Error("Search requires at least one query");
  const ranked = documents.flatMap((document) => {
    const searchablePath = normalizeSearchText(document.path);
    const searchableContent = normalizeSearchText(document.content);
    const scores = normalizedQueries.map((query) => scoreSearchMatch(searchablePath, searchableContent, query));
    const matched = requireEveryTerm ? scores.every((score) => score > 0) : scores.some((score) => score > 0);
    if (!matched) return [];
    return [{ document, score: scores.reduce((total, score) => total + score, 0) }];
  }).sort((left, right) => right.score - left.score || left.document.path.localeCompare(right.document.path));

  return {
    revision,
    total: ranked.length,
    matches: ranked.slice(offset, offset + limit).map(({ document }) => ({
      ...document,
      htmlUrl: `https://github.com/${vault.fullName}/blob/${revision}/${encodePath(document.path)}`,
    })),
  };
}

export async function searchMarkdownFiles(
  token: string,
  vault: VaultConfig,
  query: string,
  pathPrefix: string | undefined,
  limit: number,
  offset: number,
): Promise<{ total: number; incomplete: boolean; matches: SearchMatch[] }> {
  const result = await searchMarkdownDocuments(token, vault, [query], pathPrefix, limit, offset);
  return {
    total: result.total,
    incomplete: false,
    matches: result.matches.map((item) => ({
      path: item.path,
      sha: item.sha,
      htmlUrl: item.htmlUrl,
      excerpt: excerptAround(item.content, query.trim()),
    })),
  };
}

function validateSearchQuery(query: string): string {
  const normalized = normalizeSearchText(query.trim());
  if (normalized.length < 2 || normalized.length > 200) {
    throw new Error("Search query must contain between 2 and 200 characters");
  }
  return normalized;
}

function scoreSearchMatch(path: string, content: string, query: string): number {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => path.includes(term) || content.includes(term))) return 0;
  let score = terms.reduce((total, term) => total + (path.includes(term) ? 12 : 0) + (content.includes(term) ? 2 : 0), 0);
  if (path.includes(query)) score += 40;
  if (content.includes(query)) score += 20;
  return score;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

function excerptAround(content: string, query: string): string {
  const flattened = content.replace(/\s+/g, " ").trim();
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  const lower = flattened.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const matchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, matchAt - 140);
  const end = Math.min(flattened.length, matchAt + 360);
  return `${start > 0 ? "…" : ""}${flattened.slice(start, end)}${end < flattened.length ? "…" : ""}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(value: string): string {
  const compact = value.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
