import { Hono } from "hono";
import { z } from "zod";
import { allowedGitHubUserId, configuredVaults, webChatEnabled } from "./config";
import { chatModelIds, chatModels, defaultChatModel, reasoningEfforts } from "./chatModels";
import {
  getMarkdownTree,
  getRepositoryMetadata,
  readMarkdownBlobAtSha,
  readMarkdownFile,
  searchMarkdownFiles,
} from "./github";
import { hashedSafetyIdentifier, runVaultAgent, VaultAgentProviderError, type AgentProgressEvent, type VaultAgentResult } from "./openaiAgent";
import { VaultAgentToolbox } from "./vaultAgentTools";
import { clearWebSessionCookie, readWebSession, revokeWebSession, secureEquals, type WebSession } from "./webSession";
import type { Env, VaultConfig } from "./types";
import { encryptCredential } from "./credentialCipher";
import { exchangeGoogleCode, googleAuthorizationUrl } from "./googleDrive";
import {
  consumeSyncOAuthState,
  createSyncOAuthState,
  deleteSyncDestination,
  listSyncDestinations,
  saveGoogleDriveDestination,
} from "./syncStore";
import { credentialContext, enqueueSyncSnapshot } from "./vaultSync";
import { dispatchPendingAutomationJobs } from "./eventQueue";

const app = new Hono<{ Bindings: Env }>();

const chatSchema = z.object({
  question: z.string().trim().min(1).max(4_000),
  activePath: z.string().max(500).optional(),
  pathPrefix: z.string().max(500).optional(),
  scope: z.enum(["note", "folder", "vault"]).default("vault"),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(4_000),
  })).max(10).default([]),
  model: z.enum(chatModelIds),
  reasoning_effort: z.enum(reasoningEfforts),
}).strict().superRefine((request, context) => {
  if (request.scope === "note" && !request.activePath) {
    context.addIssue({ code: "custom", path: ["activePath"], message: "activePath is required for note scope" });
  }
  if (request.scope === "folder" && !request.pathPrefix) {
    context.addIssue({ code: "custom", path: ["pathPrefix"], message: "pathPrefix is required for folder scope" });
  }
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
    chat: {
      enabled: webChatEnabled(context.env) && Boolean(context.env.OPENAI_API_KEY),
      provider: "openai",
      models: chatModels,
      reasoning_efforts: reasoningEfforts,
      default_model: defaultChatModel(context.env),
      default_reasoning_effort: "medium",
    },
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

app.get("/vaults/:vaultId/sync", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const destinations = await listSyncDestinations(context.env.EVENT_DB, session.githubUserId, context.req.param("vaultId"));
  return context.json({
    vault: vault.fullName,
    google_drive_configured: Boolean(context.env.GOOGLE_CLIENT_ID && context.env.GOOGLE_CLIENT_SECRET && context.env.SYNC_CREDENTIALS_KEY),
    destinations: destinations.map((destination) => ({
      id: destination.destinationId,
      provider: destination.provider,
      status: destination.status,
      last_synced_revision: destination.lastSyncedRevision,
      last_synced_at: destination.lastSyncedAt,
      last_error: destination.lastErrorCode,
      folder_url: destination.rootFolderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(destination.rootFolderId)}` : undefined,
      updated_at: destination.updatedAt,
    })),
  });
});

app.post("/vaults/:vaultId/sync/google/start", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  requireMutationAuthorization(context.req.raw, session);
  await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  if (!context.env.GOOGLE_CLIENT_ID || !context.env.GOOGLE_CLIENT_SECRET || !context.env.SYNC_CREDENTIALS_KEY) {
    throw new WebApiError(503, "google_drive_sync_not_configured");
  }
  const state = await createSyncOAuthState(context.env.EVENT_DB, session.githubUserId, context.req.param("vaultId"));
  return context.json({ authorization_url: googleAuthorizationUrl({
    clientId: context.env.GOOGLE_CLIENT_ID,
    redirectUri: `${new URL(context.req.url).origin}/api/sync/google/callback`,
    state,
  }) });
});

app.get("/sync/google/callback", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  const state = context.req.query("state") ?? "";
  const authorization = await consumeSyncOAuthState(context.env.EVENT_DB, state, session.githubUserId);
  if (!authorization) return context.redirect("/?sync=invalid_state");
  const callbackLocation = (result: string) => `/?sync=${encodeURIComponent(result)}&sync_vault=${encodeURIComponent(authorization.repositoryId)}`;
  if (context.req.query("error")) return context.redirect(callbackLocation("denied"));
  const code = context.req.query("code");
  if (!code || !context.env.GOOGLE_CLIENT_ID || !context.env.GOOGLE_CLIENT_SECRET || !context.env.SYNC_CREDENTIALS_KEY) {
    return context.redirect(callbackLocation("configuration_error"));
  }
  const vault = await resolveAuthorizedVault(context.env, authorization.repositoryId);
  try {
    const { refreshToken } = await exchangeGoogleCode({
      clientId: context.env.GOOGLE_CLIENT_ID,
      clientSecret: context.env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri: `${new URL(context.req.url).origin}/api/sync/google/callback`,
    });
    const encryptedRefreshToken = await encryptCredential(
      context.env.SYNC_CREDENTIALS_KEY,
      refreshToken,
      credentialContext(session.githubUserId, authorization.repositoryId),
    );
    const destination = await saveGoogleDriveDestination(context.env.EVENT_DB, {
      githubUserId: session.githubUserId,
      repositoryId: authorization.repositoryId,
      vault: vault.fullName,
      encryptedRefreshToken,
    });
    const tree = await getMarkdownTree(context.env.GITHUB_VAULT_TOKEN, vault);
    await enqueueSyncSnapshot(context.env, destination, tree.revision, `sync-connected:${crypto.randomUUID()}`);
    await dispatchPendingAutomationJobs(context.env);
    return context.redirect(callbackLocation("connected"));
  } catch (error) {
    console.error(JSON.stringify({ type: "sync.google_oauth_failed", error: safeError(error) }));
    return context.redirect(callbackLocation("connection_failed"));
  }
});

app.post("/vaults/:vaultId/sync/:destinationId/run", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  requireMutationAuthorization(context.req.raw, session);
  const vault = await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const destination = (await listSyncDestinations(context.env.EVENT_DB, session.githubUserId, context.req.param("vaultId")))
    .find((candidate) => candidate.destinationId === context.req.param("destinationId"));
  if (!destination) throw new WebApiError(404, "sync_destination_not_found");
  const tree = await getMarkdownTree(context.env.GITHUB_VAULT_TOKEN, vault);
  await enqueueSyncSnapshot(context.env, destination, tree.revision, `sync-manual:${crypto.randomUUID()}`);
  await dispatchPendingAutomationJobs(context.env);
  return context.json({ queued: true, revision: tree.revision });
});

app.delete("/vaults/:vaultId/sync/:destinationId", async (context) => {
  const session = await requireAuthorizedSession(context.env, context.req.header("Cookie"));
  requireMutationAuthorization(context.req.raw, session);
  await resolveAuthorizedVault(context.env, context.req.param("vaultId"));
  const deleted = await deleteSyncDestination(context.env.EVENT_DB, session.githubUserId, context.req.param("vaultId"), context.req.param("destinationId"));
  if (!deleted) throw new WebApiError(404, "sync_destination_not_found");
  return context.json({ deleted: true, remote_copy_preserved: true });
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
  const declaredLength = Number(context.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 64_000) throw new WebApiError(413, "request_too_large");
  const rawBody = await context.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 64_000) throw new WebApiError(413, "request_too_large");
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = undefined; }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) throw new WebApiError(400, "invalid_chat_request");
  const deadline = Date.now() + 150_000;
  const deadlineSignal = AbortSignal.timeout(150_000);
  const leaseId = await acquireChatLease(context.env.EVENT_DB, session.githubUserId, Math.ceil((deadline + 150_000) / 1_000));
  try { await reserveChatRequest(context.env, session.githubUserId); } catch (error) {
    await releaseChatLease(context.env.EVENT_DB, session.githubUserId, leaseId);
    throw error;
  }
  const execute = (signal: AbortSignal, onProgress?: (event: AgentProgressEvent) => void | Promise<void>) => executeVaultAgent(
    context.env,
    context.req.param("vaultId"),
    session,
    parsed.data,
    signal,
    deadline,
    onProgress,
  );

  if (context.req.header("Accept")?.includes("application/x-ndjson")) {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    let streamClosed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: unknown) => {
          if (!streamClosed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        emit({ type: "status", phase: "preparing" });
        void execute(AbortSignal.any([context.req.raw.signal, abortController.signal, deadlineSignal]), emit)
          .then((result) => emit({ type: "result", reply: agentReply(result) }))
          .catch((error) => {
            const normalized = agentStreamError(error);
            emit({ type: "error", ...normalized });
          })
          .finally(async () => {
            await releaseChatLease(context.env.EVENT_DB, session.githubUserId, leaseId).catch(() => undefined);
            if (!streamClosed) {
              streamClosed = true;
              controller.close();
            }
          });
      },
      cancel() { streamClosed = true; abortController.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
  }

  try {
    return context.json(agentReply(await execute(AbortSignal.any([context.req.raw.signal, deadlineSignal]))));
  } finally {
    await releaseChatLease(context.env.EVENT_DB, session.githubUserId, leaseId);
  }
});

app.onError((error, context) => {
  if (error instanceof WebApiError) return context.json({ error: error.code }, error.status);
  if (error instanceof VaultAgentProviderError) return context.json({ error: error.code }, error.status as 408 | 422 | 429 | 502 | 503 | 504);
  console.error(JSON.stringify({ type: "web_api.failed", route: new URL(context.req.url).pathname, error: safeError(error) }));
  return context.json({ error: "request_failed" }, 500);
});

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

async function resolveAuthorizedVault(env: Env, vaultId: string, signal?: AbortSignal): Promise<VaultConfig> {
  signal?.throwIfAborted();
  if (!/^\d+$/.test(vaultId)) throw new WebApiError(404, "vault_not_found");
  const configured = configuredVaults(env);
  let row = await env.EVENT_DB.prepare("SELECT full_name FROM web_vault_registry WHERE repository_id = ?")
    .bind(vaultId).first<{ full_name: string }>();
  if (!row) {
    await refreshVaultRegistry(env, signal);
    signal?.throwIfAborted();
    row = await env.EVENT_DB.prepare("SELECT full_name FROM web_vault_registry WHERE repository_id = ?")
      .bind(vaultId).first<{ full_name: string }>();
  }
  const vault = row ? configured.find((candidate) => candidate.fullName === row.full_name) : undefined;
  if (vault) return vault;
  throw new WebApiError(404, "vault_not_found");
}

async function refreshVaultRegistry(env: Env, signal?: AbortSignal) {
  const now = Math.floor(Date.now() / 1_000);
  return Promise.all(configuredVaults(env).map(async (vault) => {
    signal?.throwIfAborted();
    const metadata = await getRepositoryMetadata(env.GITHUB_VAULT_TOKEN, vault, signal);
    signal?.throwIfAborted();
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

async function acquireChatLease(db: D1Database, githubUserId: string, expiresAt: number): Promise<string> {
  const leaseId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const row = await db.prepare(
    "INSERT INTO web_chat_leases (github_user_id, lease_id, expires_at) VALUES (?, ?, ?) " +
    "ON CONFLICT (github_user_id) DO UPDATE SET lease_id = excluded.lease_id, expires_at = excluded.expires_at " +
    "WHERE web_chat_leases.expires_at <= ? RETURNING lease_id",
  ).bind(githubUserId, leaseId, expiresAt, now).first<{ lease_id: string }>();
  if (row?.lease_id !== leaseId) throw new WebApiError(429, "chat_already_running");
  return leaseId;
}

async function releaseChatLease(db: D1Database, githubUserId: string, leaseId: string): Promise<void> {
  await db.prepare("DELETE FROM web_chat_leases WHERE github_user_id = ? AND lease_id = ?").bind(githubUserId, leaseId).run();
}

async function executeVaultAgent(
  env: Env,
  vaultId: string,
  session: WebSession,
  request: z.infer<typeof chatSchema>,
  signal: AbortSignal,
  deadline: number,
  onProgress?: (event: AgentProgressEvent) => void | Promise<void>,
): Promise<VaultAgentResult> {
  try {
    signal.throwIfAborted();
    const vault = await resolveAuthorizedVault(env, vaultId, signal);
    signal.throwIfAborted();
    const toolbox = await VaultAgentToolbox.create(env, vault, request.scope, request.activePath, request.pathPrefix, signal);
    signal.throwIfAborted();
    return await runVaultAgent({
      apiKey: env.OPENAI_API_KEY ?? "",
      model: request.model,
      reasoningEffort: request.reasoning_effort,
      question: request.question,
      history: request.history,
      scope: request.scope,
      activePath: request.activePath,
      safetyIdentifier: await hashedSafetyIdentifier(session.githubUserId),
      toolbox,
      signal,
      deadline,
      onProgress,
    });
  } catch (error) {
    if (signal.aborted && !(error instanceof VaultAgentProviderError)) {
      throw signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? new VaultAgentProviderError("agent_timeout", 504)
        : new VaultAgentProviderError("agent_cancelled", 408);
    }
    throw error;
  }
}

function agentReply(result: VaultAgentResult) {
  const citations = result.citations.map((source, index) => ({ id: `S${index + 1}`, path: source.path, sha: source.sha }));
  const inspected = [...new Map(result.trace.flatMap((event) => event.notes).map((note) => [`${note.path}\0${note.sha}`, note])).values()];
  return {
    answer: result.answer,
    citations,
    trace: result.trace,
    context: { note_count: inspected.length, revision: result.revision },
    usage: result.usage,
    agent: { model: result.model, reasoning_effort: result.reasoningEffort, tool_calls: result.trace.length, model_requests: result.usage.requests },
  };
}

function agentStreamError(error: unknown): { error: string; status: number } {
  if (error instanceof WebApiError || error instanceof VaultAgentProviderError) return { error: error.code, status: error.status };
  console.error(JSON.stringify({ type: "web_chat_stream.failed", error: safeError(error) }));
  return { error: "request_failed", status: 500 };
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
