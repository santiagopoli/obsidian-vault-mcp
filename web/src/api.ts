export interface Session {
  authenticated: true;
  user: { id: string; login: string };
  csrf_token: string;
  expires_at: number;
  deployment: "single-owner";
  chat_enabled: boolean;
}

export interface Vault {
  id: string;
  name: string;
  repository: string;
  default_branch: string;
  access: "read" | "write";
}

export interface NoteSummary {
  path: string;
  sha: string;
  size: number;
}

export interface Note extends NoteSummary {
  content: string;
  html_url?: string;
  cited_revision?: boolean;
}

export interface SearchMatch {
  path: string;
  excerpt: string;
  htmlUrl: string;
}

export interface ChatReply {
  answer: string;
  citations: Array<{ id: string; path: string; sha: string }>;
  context: { note_count: number };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export async function getSession(): Promise<Session | undefined> {
  const response = await fetch("/api/session", { headers: { Accept: "application/json" } });
  if (response.status === 401) return undefined;
  return json<Session>(response);
}

export async function getVaults(): Promise<Vault[]> {
  return (await json<{ vaults: Vault[] }>(await fetch("/api/vaults"))).vaults;
}

export async function getNotes(vaultId: string, offset = 0): Promise<{ notes: NoteSummary[]; total: number; hasMore: boolean }> {
  const result = await json<{ notes: NoteSummary[]; total: number; has_more: boolean }>(await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/notes?limit=200&offset=${offset}`,
  ));
  return { notes: result.notes, total: result.total, hasMore: result.has_more };
}

export async function getNote(vaultId: string, path: string, sha?: string): Promise<Note> {
  const query = new URLSearchParams({ path });
  if (sha) query.set("sha", sha);
  return json<Note>(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/note?${query}`));
}

export async function searchNotes(vaultId: string, query: string): Promise<SearchMatch[]> {
  const result = await json<{ matches: SearchMatch[] }>(await fetch(
    `/api/vaults/${encodeURIComponent(vaultId)}/search?q=${encodeURIComponent(query)}&limit=20`,
  ));
  return result.matches;
}

export async function chat(
  vaultId: string,
  csrf: string,
  request: {
    question: string;
    activePath?: string;
    scope: "note" | "vault";
    history: Array<{ role: "user" | "assistant"; content: string }>;
  },
): Promise<ChatReply> {
  return json<ChatReply>(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(request),
  }));
}

export async function logout(csrf: string): Promise<void> {
  await json(await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } }));
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed");
  return body as T;
}
