const webStateCookie = "__Host-obsidian_web_state";
const webSessionCookie = "__Host-obsidian_session";
const authStateLifetimeSeconds = 600;
const sessionLifetimeSeconds = 8 * 60 * 60;

export interface WebSession {
  githubUserId: string;
  githubLogin: string;
  csrfSecret: string;
  expiresAt: number;
}

export async function createWebAuthState(db: D1Database): Promise<{ state: string; cookie: string }> {
  const state = randomToken();
  const expiresAt = unixSeconds() + authStateLifetimeSeconds;
  await db.prepare("INSERT INTO web_auth_states (state_hash, expires_at) VALUES (?, ?)")
    .bind(await sha256(state), expiresAt)
    .run();
  return { state, cookie: hostCookie(webStateCookie, state, authStateLifetimeSeconds) };
}

export async function consumeWebAuthState(db: D1Database, state: string): Promise<boolean> {
  if (!isToken(state)) return false;
  const row = await db.prepare(
    "DELETE FROM web_auth_states WHERE state_hash = ? AND expires_at > ? RETURNING state_hash",
  ).bind(await sha256(state), unixSeconds()).first<{ state_hash: string }>();
  return Boolean(row);
}

export async function createWebSession(
  db: D1Database,
  githubUserId: string,
  githubLogin: string,
): Promise<{ session: WebSession; cookie: string }> {
  const token = randomToken();
  const csrfSecret = randomToken();
  const now = unixSeconds();
  const expiresAt = now + sessionLifetimeSeconds;
  await db.prepare(
    "INSERT INTO web_sessions (session_hash, github_user_id, github_login, csrf_secret, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(await sha256(token), githubUserId, githubLogin, csrfSecret, now, expiresAt).run();
  return {
    session: { githubUserId, githubLogin, csrfSecret, expiresAt },
    cookie: hostCookie(webSessionCookie, token, sessionLifetimeSeconds),
  };
}

export async function readWebSession(db: D1Database, cookieHeader: string | undefined): Promise<WebSession | undefined> {
  const token = readCookie(cookieHeader, webSessionCookie);
  if (!token || !isToken(token)) return undefined;
  const row = await db.prepare(
    "SELECT github_user_id, github_login, csrf_secret, expires_at FROM web_sessions WHERE session_hash = ? AND expires_at > ?",
  ).bind(await sha256(token), unixSeconds()).first<{
    github_user_id: string;
    github_login: string;
    csrf_secret: string;
    expires_at: number;
  }>();
  if (!row) return undefined;
  return {
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    csrfSecret: row.csrf_secret,
    expiresAt: row.expires_at,
  };
}

export async function revokeWebSession(db: D1Database, cookieHeader: string | undefined): Promise<void> {
  const token = readCookie(cookieHeader, webSessionCookie);
  if (!token || !isToken(token)) return;
  await db.prepare("DELETE FROM web_sessions WHERE session_hash = ?").bind(await sha256(token)).run();
}

export async function cleanupWebPortalState(db: D1Database, now = new Date()): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const usageCutoff = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM web_auth_states WHERE expires_at <= ?").bind(nowSeconds),
    db.prepare("DELETE FROM mcp_consent_states WHERE expires_at <= ?").bind(nowSeconds),
    db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").bind(nowSeconds),
    db.prepare("DELETE FROM web_chat_usage WHERE usage_day < ?").bind(usageCutoff),
  ]);
}

export function clearWebStateCookie(): string {
  return hostCookie(webStateCookie, "", 0);
}

export function clearWebSessionCookie(): string {
  return hostCookie(webSessionCookie, "", 0);
}

export function readWebStateCookie(cookieHeader: string | undefined): string | undefined {
  return readCookie(cookieHeader, webStateCookie);
}

export function secureEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function isToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function hostCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
