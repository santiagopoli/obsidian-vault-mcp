export interface Session {
  authenticated: true;
  user: { id: string; login: string };
  csrf_token: string;
  expires_at: number;
  deployment: "single-owner";
  chat_enabled: boolean;
  chat: {
    enabled: boolean;
    provider: "openai";
    models: Array<{ id: ChatModelId; label: string; description: string }>;
    reasoning_efforts: ReasoningEffort[];
    default_model: ChatModelId;
    default_reasoning_effort: ReasoningEffort;
  };
}

export type ChatModelId = "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

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
  sha: string;
  excerpt: string;
  htmlUrl: string;
}

export interface SyncDestination {
  id: string;
  provider: "google_drive";
  status: "active" | "reauthorization_required" | "disabled";
  last_synced_revision?: string;
  last_synced_at?: number;
  last_error?: string;
  folder_url?: string;
  updated_at: number;
}

export interface VaultSyncSettings {
  vault: string;
  google_drive_configured: boolean;
  destinations: SyncDestination[];
}

export interface ChatReply {
  answer: string;
  citations: Array<{ id: string; path: string; sha: string }>;
  context: { note_count: number };
  trace: AgentTraceEvent[];
  usage: AgentUsage;
  agent: { model: ChatModelId; reasoning_effort: ReasoningEffort; tool_calls: number; model_requests: number };
}

export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface AgentTraceEvent {
  id: string;
  step: number;
  tool: "list_notes" | "search_notes" | "read_notes" | "get_note_links" | "get_graph_overview";
  status: "completed" | "failed";
  input: { query?: string; prefix?: string; paths?: string[]; path?: string };
  summary: string;
  notes: Array<{ path: string; sha: string }>;
}

export type ChatProgress =
  | { type: "status"; phase: "preparing" }
  | { type: "model_request"; round: number }
  | { type: "usage"; usage: AgentUsage }
  | { type: "tool"; trace: AgentTraceEvent };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export class AgentChatError extends ApiError {
  constructor(status: number, code: string, readonly usage: AgentUsage, readonly trace: AgentTraceEvent[]) {
    super(status, code);
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

export async function getAllNotes(vaultId: string): Promise<{ notes: NoteSummary[]; total: number }> {
  const notes: NoteSummary[] = [];
  let total = 0;
  do {
    const page = await getNotes(vaultId, notes.length);
    notes.push(...page.notes);
    total = page.total;
    if (!page.hasMore) break;
  } while (notes.length < 1_000);
  return { notes, total };
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

export async function getVaultSync(vaultId: string): Promise<VaultSyncSettings> {
  return json(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/sync`));
}

export async function connectGoogleDrive(vaultId: string, csrf: string): Promise<string> {
  const result = await json<{ authorization_url: string }>(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/sync/google/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  }));
  return result.authorization_url;
}

export async function runVaultSync(vaultId: string, destinationId: string, csrf: string): Promise<{ revision: string }> {
  return json(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/sync/${encodeURIComponent(destinationId)}/run`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
  }));
}

export async function disconnectVaultSync(vaultId: string, destinationId: string, csrf: string): Promise<void> {
  await json(await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/sync/${encodeURIComponent(destinationId)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": csrf },
  }));
}

export async function chat(
  vaultId: string,
  csrf: string,
  request: {
    question: string;
    activePath?: string;
    scope: "note" | "vault";
    history: Array<{ role: "user" | "assistant"; content: string }>;
    model: ChatModelId;
    reasoning_effort: ReasoningEffort;
  },
  options: { signal?: AbortSignal; onProgress?: (event: ChatProgress) => void } = {},
): Promise<ChatReply> {
  const response = await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Accept: "application/x-ndjson" },
    body: JSON.stringify(request),
    signal: options.signal,
  });
  if (!response.ok) return json<ChatReply>(response);
  if (!response.body) throw new ApiError(502, "agent_stream_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply: ChatReply | undefined;
  let usage = emptyAgentUsage();
  const trace: AgentTraceEvent[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as ChatProgress | { type: "result"; reply: ChatReply } | { type: "error"; error: string; status: number };
        if (event.type === "result") reply = event.reply;
        else if (event.type === "error") throw new AgentChatError(event.status, event.error, usage, trace);
        else {
          if (event.type === "usage") usage = event.usage;
          if (event.type === "tool") trace.push(event.trace);
          options.onProgress?.(event);
        }
      }
      if (chunk.done) break;
    }
  } catch (error) {
    if (options.signal?.aborted || error instanceof AgentChatError) throw error;
    throw new AgentChatError(502, "agent_stream_interrupted", usage, trace);
  }
  if (!reply) throw new AgentChatError(502, "agent_stream_invalid", usage, trace);
  return reply;
}

export async function logout(csrf: string): Promise<void> {
  await json(await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } }));
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "request_failed");
  return body as T;
}

function emptyAgentUsage(): AgentUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}
