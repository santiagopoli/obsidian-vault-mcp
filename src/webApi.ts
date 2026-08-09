import { Hono } from "hono";
import { z } from "zod";
import { allowedGitHubUserId, configuredVaults, webChatEnabled } from "./config";
import {
  getMarkdownTree,
  getRepositoryMetadata,
  rankMarkdownDocuments,
  readMarkdownBlobAtSha,
  readMarkdownFile,
  readMarkdownTree,
  searchMarkdownFiles,
} from "./github";
import { answerVaultQuestion, chatSearchTerms, hashedSafetyIdentifier, VaultChatProviderError } from "./openaiChat";
import { clearWebSessionCookie, readWebSession, revokeWebSession, secureEquals, type WebSession } from "./webSession";
import type { Env, VaultConfig } from "./types";

const app = new Hono<{ Bindings: Env }>();

const chatSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  activePath: z.string().max(500).optional(),
  pathPrefix: z.string().max(500).optional(),
  scope: z.enum(["note", "folder", "vault"]).default("vault"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(4_000),
  })).max(8).default([]),
});

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "private, no-store");
  context.header("Content-Type", context.res.headers.get("Content-Type") ?? "application/json; charset=utf-8");
});

app.get("/session", async (context) => {
  const session = await optionalAuthorizedSession(context.env, context.req.header("Cookie"));
  if (!session) return context.json({ authenticated: false, login_url: "/web/login" }, 401);
  return context.json({
    authenticated: true,
    user: { id: session.githubUserId, login: session.githubLogin },
    csrf_token: session.csrfSecret,
    expires_at: session.expiresAt,
    deployment: "single-owner",
    chat_enabled: webChatEnabled(context.env) && Boolean(context.env.OPENAI_API_KEY),
  });
});

app.post("/logout", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  requireMutationAuthorization(context.req.raw, session);
  await revokeWebSession(context.env.EVENT_DB, context.req.header("Cookie"));
  return context.json({ ok: true }, 200, { "Set-Cookie": clearWebSessionCookie() });
});

app.get("/vaults", async (context) => {
  await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const vaults = await refreshVaultRegistry(context.env);
  return context.json({ vaults });
});

app.get("/vaults/:vaultId/notes", async (context) => {
  await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const prefix = optionalQuery(context.req.query("prefix"), 500);
  const limit = boundedInteger(context.req.query("limit"), 100, 1, 200);
  const offset = boundedInteger(context.req.query("offset"), 0, 0, 100_000);
  const tree = await getMarkdownTree(context.env.GITHUB_VAULT_TOKEN, vault, prefix);
  const notes = tree.files.slice(offset, offset + limit).map((file) => ({
    path: file.path,
    sha: file.sha,
    size: file.size ?? 0,
  }));
  return context.json({
    revision: tree.revision,
    total: tree.files.length,
    count: notes.length,
    offset,
    notes,
    has_more: offset + notes.length < tree.files.length,
  });
});

app.get("/vaults/:vaultId/note", async (context) => {
  await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const path = context.req.query("path");
  if (!path) throw new WebApiError(400, "note_path_required");
  const sha = context.req.query("sha");
  if (sha) {
    const exact = await readMarkdownBlobAtSha(context.env.GITHUB_VAULT_TOKEN, vault, path, sha);
    return context.json({ path: exact.path, sha: exact.sha, content: exact.content, cited_revision: true });
  }
  const note = await readMarkdownFile(context.env.GITHUB_VAULT_TOKEN, vault, path);
  return context.json({ path, sha: note.sha, html_url: note.htmlUrl, content: note.content });
});

app.get("/vaults/:vaultId/search", async (context) => {
  await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const query = context.req.query("q")?.trim();
  if (!query) throw new WebApiError(400, "search_query_required");
  const prefix = optionalQuery(context.req.query("prefix"), 500);
  const limit = boundedInteger(context.req.query("limit"), 20, 1, 20);
  const offset = boundedInteger(context.req.query("offset"), 0, 0, 900);
  const result = await searchMarkdownFiles(context.env.GITHUB_VAULT_TOKEN, vault, query, prefix, limit, offset);
  return context.json({ ...result, count: result.matches.length, offset });
});

app.post("/vaults/:vaultId/chat", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  requireMutationAuthorization(context.req.raw, session);
  if (!context.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new WebApiError(415, "json_required");
  }
  if (!webChatEnabled(context.env) || !context.env.OPENAI_API_KEY) {
    throw new WebApiError(503, "chat_not_configured");
  }
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 64_000) throw new WebApiError(413, "request_too_large");
  const rawBody = await context.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 64_000) throw new WebApiError(413, "request_too_large");
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = undefined; }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) throw new WebApiError(400, "invalid_chat_request");
  const retrieved = await retrieveSources(context.env, vault, parsed.data);
  await reserveChatRequest(context.env, session.githubUserId);
  const result = await answerVaultQuestion({
    apiKey: context.env.OPENAI_API_KEY,
    model: context.env.OPENAI_CHAT_MODEL?.trim() || "gpt-5.6-sol",
    question: parsed.data.question,
    history: parsed.data.history,
    sources: retrieved.sources,
    safetyIdentifier: await hashedSafetyIdentifier(session.githubUserId),
  });
  const byId = new Map(retrieved.sources.map((source) => [source.id, source]));
  const citations = result.citationIds.flatMap((id) => {
    const source = byId.get(id);
    return source ? [{ id, path: source.path, sha: source.sha }] : [];
  });
  return context.json({
    answer: result.answer,
    citations,
    context: { note_count: retrieved.sources.length, revision: retrieved.revision },
    usage: result.usage,
    request_id: result.requestId,
  });
});

app.onError((error, context) => {
  if (error instanceof WebApiError) return context.json({ error: error.code }, error.status);
  if (error instanceof VaultChatProviderError) return context.json({ error: error.code }, error.status as 429 | 502 | 503);
  console.error(JSON.stringify({ type: "web_api.failed", route: new URL(context.req.url).pathname, error: safeError(error) }));
  return context.json({ error: "request_failed" }, 500);
});

interface ChatRequest {
  question: string;
  activePath?: string;
  pathPrefix?: string;
  scope: "note" | "folder" | "vault";
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

async function retrieveSources(env: Env, vault: VaultConfig, request: ChatRequest) {
  const tree = await getMarkdownTree(env.GITHUB_VAULT_TOKEN, vault);
  const filesByPath = new Map(tree.files.map((file) => [file.path, file]));
  const visibleDocuments = (request.scope === "note" ? [] : await readMarkdownTree(env.GITHUB_VAULT_TOKEN, vault, tree)).filter((document) => {
    if (request.scope !== "folder" || !request.pathPrefix) return true;
    return document.path.startsWith(`${request.pathPrefix.replace(/\/+$/, "")}/`);
  });
  const documentsByPath = new Map<string, { sha: string; content: string }>();
  const paths: string[] = [];
  let maxSources = 6;
  if (request.activePath && filesByPath.has(request.activePath)) paths.push(request.activePath);
  if (request.scope !== "note") {
    const terms = chatSearchTerms(request.question);
    const matches = terms.length > 0
      ? rankMarkdownDocuments(vault, tree.revision, visibleDocuments, terms, 6, 0, false).matches
      : [];
    if (matches.length === 0) maxSources = 12;
    const selected = matches.length > 0 ? matches : representativeDocuments(visibleDocuments, maxSources);
    for (const match of selected) {
      documentsByPath.set(match.path, match);
      if (!paths.includes(match.path)) paths.push(match.path);
      if (paths.length >= maxSources) break;
    }
  }

  let remainingCharacters = 50_000;
  const sources = [];
  for (const path of paths.slice(0, maxSources)) {
    if (remainingCharacters <= 0) break;
    const file = filesByPath.get(path);
    if (!file) continue;
    const note = documentsByPath.get(path) ?? await readMarkdownBlobAtSha(env.GITHUB_VAULT_TOKEN, vault, path, file.sha);
    const content = note.content.slice(0, Math.min(12_000, remainingCharacters));
    remainingCharacters -= content.length;
    sources.push({ id: `S${sources.length + 1}`, path, sha: note.sha, content });
  }
  return { revision: tree.revision, sources };
}

function representativeDocuments(documents: Array<{ path: string; sha: string; content: string }>, limit: number) {
  return [...documents].sort((left, right) => {
    const score = (path: string) => {
      const lower = path.toLocaleLowerCase();
      const preferred = /(readme|index|overview|summary|canon|story|world|character|personaje)/.test(lower) ? 30 : 0;
      return preferred - path.split("/").length * 3;
    };
    return score(right.path) - score(left.path) || left.path.localeCompare(right.path);
  }).slice(0, limit);
}

async function optionalAuthorizedSession(env: Env, cookie: string | undefined): Promise<WebSession | undefined> {
  const session = await readWebSession(env.EVENT_DB, cookie);
  if (!session || session.githubUserId !== allowedGitHubUserId(env)) return undefined;
  return session;
}

async function requireAuthorizedSession(env: Env, cookie: string | undefined): Promise<WebSession> {
  const session = await optionalAuthorizedSession(env, cookie);
  if (!session) throw new WebApiError(401, "authentication_required");
  return session;
}

async function resolveAuthorizedVault(env: Env, vaultId: string): Promise<VaultConfig> {
  if (!/^\d+$/.test(vaultId)) throw new WebApiError(404, "vault_not_found");
  const configured = configuredVaults(env);
  let row = await env.EVENT_DB.prepare("SELECT full_name FROM web_vault_registry WHERE repository_id = ?")
    .bind(vaultId).first<{ full_name: string }>();
  if (!row) {
    await refreshVaultRegistry(env);
    row = await env.EVENT_DB.prepare("SELECT full_name FROM web_vault_registry WHERE repository_id = ?")
      .bind(vaultId).first<{ full_name: string }>();
  }
  const vault = row ? configured.find((candidate) => candidate.fullName === row.full_name) : undefined;
  if (vault) return vault;
  throw new WebApiError(404, "vault_not_found");
}

async function refreshVaultRegistry(env: Env) {
  const now = Math.floor(Date.now() / 1_000);
  return Promise.all(configuredVaults(env).map(async (vault) => {
    const metadata = await getRepositoryMetadata(env.GITHUB_VAULT_TOKEN, vault);
    await env.EVENT_DB.prepare(
      "INSERT INTO web_vault_registry (repository_id, full_name, default_branch, refreshed_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (repository_id) DO UPDATE SET full_name = excluded.full_name, default_branch = excluded.default_branch, refreshed_at = excluded.refreshed_at",
    ).bind(metadata.id, vault.fullName, metadata.defaultBranch, now).run();
    return {
      id: metadata.id,
      name: vault.name,
      repository: vault.fullName,
      default_branch: metadata.defaultBranch,
      access: env.VAULT_ACCESS,
    };
  }));
}

function requireMutationAuthorization(request: Request, session: WebSession): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new WebApiError(403, "origin_rejected");
  const csrf = request.headers.get("X-CSRF-Token");
  if (!csrf || !secureEquals(csrf, session.csrfSecret)) throw new WebApiError(403, "csrf_rejected");
}

async function reserveChatRequest(env: Env, githubUserId: string): Promise<void> {
  const configured = Number(env.WEB_CHAT_DAILY_LIMIT ?? "50");
  const limit = Number.isInteger(configured) && configured >= 1 && configured <= 1_000 ? configured : 50;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.EVENT_DB.prepare(
    "INSERT INTO web_chat_usage (github_user_id, usage_day, request_count) VALUES (?, ?, 1) " +
    "ON CONFLICT (github_user_id, usage_day) DO UPDATE SET request_count = request_count + 1 RETURNING request_count",
  ).bind(githubUserId, day).first<{ request_count: number }>();
  if (!row || row.request_count > limit) throw new WebApiError(429, "chat_daily_limit_reached");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new WebApiError(400, "invalid_pagination");
  return parsed;
}

function optionalQuery(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  if (value.length > maximum) throw new WebApiError(400, "query_too_long");
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}

class WebApiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 413 | 415 | 429 | 503, readonly code: string) {
    super(code);
  }
}

export { app as WebApiHandler };
