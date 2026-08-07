import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { allowedGitHubUserId, configuredVaults, resolveVault, vaultAccess } from "./config";
import { parseAutomationConfig } from "./automations/config";
import { consumeConsentState, storeConsentState } from "./consentState";
import { isLoopbackRedirect, loopbackHandoffPage } from "./loopbackRedirect";
import { selectGrantedScopes, writeScope } from "./authPolicy";
import type { AuthProps, Env } from "./types";

const authStatePrefix = "github-oauth-state:";
const stateTtlSeconds = 600;
const githubCallbackStateCookie = "__Host-obsidian_mcp_state";

interface PendingIdentity {
  oauthRequest: AuthRequest;
  grantedScopes: string[];
}

interface PendingConsent extends PendingIdentity {
  githubUserId: string;
  githubLogin: string;
  clientName: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
  context.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'");
  context.header("Referrer-Policy", "no-referrer");
  context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
});

app.get("/authorize", async (context) => {
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await context.env.OAUTH_PROVIDER.parseAuthRequest(context.req.raw);
  } catch (error) {
    return authorizationErrorResponse(error);
  }

  const client = await context.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return context.text("Unknown OAuth client", 400);

  let grantedScopes: string[];
  try {
    grantedScopes = selectGrantedScopes(oauthRequest.scope, vaultAccess(context.env));
  } catch (error) {
    return oauthRedirectError(oauthRequest, "invalid_scope", error instanceof Error ? error.message : "Invalid scope");
  }

  const state = crypto.randomUUID();
  const pending: PendingIdentity = { oauthRequest, grantedScopes };
  await context.env.OAUTH_KV.put(`${authStatePrefix}${state}`, JSON.stringify(pending), {
    expirationTtl: stateTtlSeconds,
  });

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", context.env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", new URL("/callback", context.req.url).href);
  authorizeUrl.searchParams.set("scope", "read:user");
  authorizeUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.href,
      "Set-Cookie": stateCookieValue(state, stateTtlSeconds, "Lax"),
    },
  });
});

app.get("/callback", async (context) => {
  const state = context.req.query("state");
  const code = context.req.query("code");
  const cookieState = readCookie(context.req.header("Cookie"), githubCallbackStateCookie);
  if (!state || !code || !cookieState || !timingSafeEqual(state, cookieState)) {
    return context.text("Invalid OAuth callback state", 400);
  }

  const storedRequest = await takeState<PendingIdentity>(context.env.OAUTH_KV, `${authStatePrefix}${state}`);
  if (!storedRequest) return context.text("OAuth request expired", 400);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: context.env.GITHUB_CLIENT_ID,
      client_secret: context.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/callback", context.req.url).href,
    }),
  });
  if (!tokenResponse.ok) return context.text("GitHub authentication failed", 502);
  const tokenBody = await tokenResponse.json<{ access_token?: string }>();
  if (!tokenBody.access_token) return context.text("GitHub did not issue an access token", 502);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "obsidian-vault-mcp-server",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userResponse.ok) return context.text("Could not verify GitHub identity", 502);
  const user = await userResponse.json<{ id: number; login: string }>();
  if (String(user.id) !== allowedGitHubUserId(context.env)) {
    return context.text("This GitHub account is not allowed to access the vault", 403);
  }

  const client = await context.env.OAUTH_PROVIDER.lookupClient(storedRequest.oauthRequest.clientId);
  if (!client) return context.text("OAuth client expired", 400);

  const consentId = crypto.randomUUID();
  const pending: PendingConsent = {
    ...storedRequest,
    githubUserId: String(user.id),
    githubLogin: user.login,
    clientName: displayClientName(client),
  };
  await storeConsentState(context.env.OAUTH_KV, consentId, pending, stateTtlSeconds);

  return new Response(consentPage(consentId, pending, configuredVaults(context.env).map(({ fullName }) => fullName)), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": stateCookieValue("", 0, "Lax"),
    },
  });
});

app.post("/consent", async (context) => {
  const form = await context.req.raw.formData();
  const consentId = form.get("consent_id");
  const decision = form.get("decision");
  const consent = await consumeConsentState<PendingConsent>(context.env.OAUTH_KV, consentId);
  if (consent.status === "invalid") return context.text("Invalid consent state", 400);
  if (consent.status === "expired") {
    return context.text("Consent request expired or was already used. Return to Codex and connect again.", 410);
  }
  const pending = consent.value;

  if (decision !== "approve") {
    return oauthRedirectError(pending.oauthRequest, "access_denied", "The vault owner denied access");
  }

  const props: AuthProps = {
    githubUserId: pending.githubUserId,
    githubLogin: pending.githubLogin,
    scopes: pending.grantedScopes,
  };
  const { redirectTo } = await context.env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthRequest,
    userId: pending.githubUserId,
    metadata: { label: `Obsidian vault access for ${pending.githubLogin}`, clientName: pending.clientName },
    scope: pending.grantedScopes,
    props,
  });

  if (isLoopbackRedirect(redirectTo)) {
    return new Response(loopbackHandoffPage(redirectTo), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo },
  });
});

app.get("/consent.js", (context) => context.body(`const form = document.querySelector("form[data-consent]");
if (form) {
  let submitted = false;
  form.addEventListener("submit", (event) => {
    if (submitted) {
      event.preventDefault();
      return;
    }
    submitted = true;
    form.setAttribute("aria-busy", "true");
    const submitter = event.submitter;
    const decision = submitter instanceof HTMLButtonElement ? submitter.value : "deny";
    const decisionInput = document.createElement("input");
    decisionInput.type = "hidden";
    decisionInput.name = "decision";
    decisionInput.value = decision;
    form.append(decisionInput);
    for (const button of form.querySelectorAll("button")) button.disabled = true;
    if (submitter instanceof HTMLButtonElement) {
      submitter.textContent = decision === "approve" ? "Authorizing…" : "Denying…";
    }
    const status = document.querySelector("[data-consent-status]");
    if (status) status.textContent = "Authorization submitted. Returning to Codex…";
  });
}`, 200, { "Content-Type": "text/javascript; charset=utf-8" }));

app.get("/healthz", async (context) => {
  allowedGitHubUserId(context.env);
  configuredVaults(context.env);
  vaultAccess(context.env);
  resolveVault(context.env, context.env.GITHUB_WEBHOOK_VAULT);
  if (!/^\d+$/.test(context.env.GITHUB_WEBHOOK_HOOK_ID) || !/^\d+$/.test(context.env.GITHUB_WEBHOOK_REPOSITORY_ID)) {
    throw new Error("Webhook policy IDs must be numeric");
  }
  const automationConfig = parseAutomationConfig(context.env.AUTOMATIONS_YAML ?? "version: 1\nautomations: []\n");
  if (automationConfig.automations.some((automation) => automation.enabled && automation.target.handler === "summarize-note")) {
    if (!context.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required by summarize-note");
    if (vaultAccess(context.env) !== "write") throw new Error("summarize-note requires VAULT_ACCESS=write");
  }
  if (!context.env.AUTOMATIONS_QUEUE || typeof context.env.AUTOMATIONS_QUEUE.send !== "function") {
    throw new Error("AUTOMATIONS_QUEUE binding is required");
  }
  await context.env.EVENT_DB.prepare("SELECT 1 FROM vault_states LIMIT 1").first();
  await context.env.EVENT_DB.prepare("SELECT 1 FROM automation_jobs LIMIT 1").first();
  await context.env.EVENT_DB.prepare("SELECT 1 FROM automation_targets LIMIT 1").first();
  return context.json({ ok: true, service: "obsidian-vault-mcp" });
});

app.get("/", (context) =>
  context.json({
    name: "Obsidian Vault MCP",
    endpoint: "/mcp",
    authentication: "OAuth 2.1 via GitHub with per-client consent",
    access: vaultAccess(context.env),
  }),
);

function consentPage(consentId: string, pending: PendingConsent, repositories: string[]): string {
  const permissions = pending.grantedScopes.map((scope) => `<li>${scope === writeScope ? "Create and update Markdown notes" : "Read notes, links, tags, and graph metadata"}</li>`).join("");
  const vaults = repositories.map((repository) => `<li><code>${escapeHtml(repository)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Obsidian Vault MCP</title><script src="/consent.js" defer></script></head>
<body><main><h1>Authorize ${escapeHtml(pending.clientName)}</h1>
<p>Signed in as <strong>${escapeHtml(pending.githubLogin)}</strong>. This client is requesting access to:</p>
<ul>${vaults}</ul><h2>Permissions</h2><ul>${permissions}</ul>
<p>Only approve clients you recognize. Access can be revoked by reconnecting or clearing OAuth grants.</p>
<form method="post" action="/consent" data-consent><input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<button type="submit" name="decision" value="approve">Allow access</button>
<button type="submit" name="decision" value="deny">Deny</button>
<p data-consent-status role="status" aria-live="polite"></p></form></main></body></html>`;
}

function displayClientName(client: ClientInfo): string {
  return client.clientName?.trim() || "an unnamed MCP client";
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function oauthRedirectError(request: AuthRequest, code: string, description: string): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return Response.redirect(redirect, 302);
}

async function takeState<T>(kv: KVNamespace, key: string): Promise<T | undefined> {
  const stored = await kv.get(key);
  await kv.delete(key);
  if (!stored) return undefined;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return undefined;
  }
}

function stateCookieValue(value: string, maxAge: number, sameSite: "Lax" | "Strict"): string {
  return `${githubCallbackStateCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export { app as AuthHandler };
