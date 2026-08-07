const textEncoder = new TextEncoder();

export const defaultGitHubWebhookMaxBodyBytes = 1_000_000;

export type SupportedGitHubWebhookEvent = "ping" | "push";

export type GitHubWebhookErrorCode =
  | "body_too_large"
  | "hook_mismatch"
  | "invalid_header"
  | "invalid_payload"
  | "invalid_policy"
  | "invalid_signature"
  | "missing_header"
  | "ref_mismatch"
  | "repository_mismatch"
  | "unsupported_content_type"
  | "unsupported_event";

export class GitHubWebhookError extends Error {
  constructor(
    readonly code: GitHubWebhookErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubWebhookError";
  }
}

export interface GitHubWebhookHeaders {
  deliveryId: string;
  event: string;
  hookId: string;
  signature: string;
}

export interface GitHubWebhookPolicy {
  secret: string;
  hookId: string;
  repositoryId: string;
  defaultBranchRef: `refs/heads/${string}`;
  maxBodyBytes?: number;
}

interface ValidatedGitHubWebhookBase {
  deliveryId: string;
  hookId: string;
  repositoryId: string;
  bodySha256: string;
}

export interface ValidatedGitHubPingWebhook extends ValidatedGitHubWebhookBase {
  event: "ping";
}

export interface ValidatedGitHubPushWebhook extends ValidatedGitHubWebhookBase {
  event: "push";
  ref: string;
  before: string;
  after: string;
  forced: boolean;
}

export type ValidatedGitHubWebhook = ValidatedGitHubPingWebhook | ValidatedGitHubPushWebhook;

export async function validateGitHubWebhook(
  headers: Headers,
  rawBody: Uint8Array,
  policy: GitHubWebhookPolicy,
): Promise<ValidatedGitHubWebhook> {
  validatePolicy(policy);
  const envelope = readGitHubWebhookHeaders(headers, policy.maxBodyBytes);
  assertGitHubWebhookBodySize(rawBody, policy.maxBodyBytes);

  if (envelope.hookId !== policy.hookId) {
    throw new GitHubWebhookError("hook_mismatch", "GitHub webhook hook ID is not allowed", 403);
  }
  if (!(await verifyGitHubWebhookSignature(rawBody, envelope.signature, policy.secret))) {
    throw new GitHubWebhookError("invalid_signature", "GitHub webhook signature is invalid", 401);
  }

  const event = assertSupportedGitHubWebhookEvent(envelope.event);
  const payload = parseJsonObject(rawBody);
  const repositoryId = assertGitHubWebhookRepository(payload, policy.repositoryId);
  const base = {
    deliveryId: envelope.deliveryId,
    hookId: envelope.hookId,
    repositoryId,
    bodySha256: await sha256Hex(rawBody),
  };

  if (event === "ping") return { ...base, event };

  const push = assertGitHubPushPayload(payload, policy.defaultBranchRef);
  return { ...base, event, ...push };
}

export function readGitHubWebhookHeaders(
  headers: Headers,
  maxBodyBytes = defaultGitHubWebhookMaxBodyBytes,
): GitHubWebhookHeaders {
  assertBodyLimit(maxBodyBytes);
  const contentType = requiredHeader(headers, "content-type").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GitHubWebhookError(
      "unsupported_content_type",
      "GitHub webhook Content-Type must be application/json",
      415,
    );
  }

  const contentEncoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new GitHubWebhookError(
      "invalid_header",
      "GitHub webhook Content-Encoding must be identity",
      400,
    );
  }

  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new GitHubWebhookError("invalid_header", "GitHub webhook Content-Length is invalid", 400);
    }
    if (Number(contentLength) > maxBodyBytes) {
      throw new GitHubWebhookError("body_too_large", "GitHub webhook body exceeds the configured limit", 413);
    }
  }

  const deliveryId = requiredHeader(headers, "x-github-delivery");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId)) {
    throw new GitHubWebhookError("invalid_header", "X-GitHub-Delivery must be a GUID", 400);
  }

  const event = requiredHeader(headers, "x-github-event");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(event)) {
    throw new GitHubWebhookError("invalid_header", "X-GitHub-Event is invalid", 400);
  }

  const hookId = requiredHeader(headers, "x-github-hook-id");
  if (!/^[1-9]\d*$/.test(hookId)) {
    throw new GitHubWebhookError("invalid_header", "X-GitHub-Hook-ID must be a positive integer", 400);
  }

  const signature = requiredHeader(headers, "x-hub-signature-256");
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    throw new GitHubWebhookError("invalid_header", "X-Hub-Signature-256 is invalid", 400);
  }

  return { deliveryId, event, hookId, signature };
}

export function assertGitHubWebhookBodySize(
  rawBody: Uint8Array,
  maxBodyBytes = defaultGitHubWebhookMaxBodyBytes,
): void {
  assertBodyLimit(maxBodyBytes);
  if (rawBody.byteLength > maxBodyBytes) {
    throw new GitHubWebhookError("body_too_large", "GitHub webhook body exceeds the configured limit", 413);
  }
}

export function assertSupportedGitHubWebhookEvent(event: string): SupportedGitHubWebhookEvent {
  if (event !== "ping" && event !== "push") {
    throw new GitHubWebhookError("unsupported_event", `Unsupported GitHub webhook event '${event}'`, 400);
  }
  return event;
}

export function assertGitHubWebhookRepository(
  payload: Record<string, unknown>,
  expectedRepositoryId: string,
): string {
  const repository = payload.repository;
  if (!isRecord(repository) || !isPositiveSafeInteger(repository.id)) {
    throw new GitHubWebhookError("invalid_payload", "GitHub webhook repository ID is invalid", 400);
  }
  const repositoryId = String(repository.id);
  if (repositoryId !== expectedRepositoryId) {
    throw new GitHubWebhookError("repository_mismatch", "GitHub webhook repository is not allowed", 403);
  }
  return repositoryId;
}

export function assertGitHubPushRef(payload: Record<string, unknown>, expectedRef: string): string {
  if (typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")) {
    throw new GitHubWebhookError("invalid_payload", "GitHub push ref is invalid", 400);
  }
  if (payload.ref !== expectedRef) {
    throw new GitHubWebhookError("ref_mismatch", "GitHub push does not target the canonical branch", 403);
  }
  return payload.ref;
}

export async function verifyGitHubWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret) throw new GitHubWebhookError("invalid_policy", "GitHub webhook secret must not be empty", 500);
  const supplied = signatureBytes(signatureHeader);
  if (!supplied) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(rawBody)));
  return safeEqualBytes(expected, supplied);
}

export function safeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function validatePolicy(policy: GitHubWebhookPolicy): void {
  if (!policy.secret || !/^[1-9]\d*$/.test(policy.hookId) || !/^[1-9]\d*$/.test(policy.repositoryId)) {
    throw new GitHubWebhookError("invalid_policy", "GitHub webhook policy IDs and secret must be configured", 500);
  }
  if (!/^refs\/heads\/[^/].*$/.test(policy.defaultBranchRef)) {
    throw new GitHubWebhookError("invalid_policy", "GitHub webhook canonical ref is invalid", 500);
  }
  assertBodyLimit(policy.maxBodyBytes ?? defaultGitHubWebhookMaxBodyBytes);
}

function assertGitHubPushPayload(
  payload: Record<string, unknown>,
  expectedRef: string,
): Pick<ValidatedGitHubPushWebhook, "ref" | "before" | "after" | "forced"> {
  const ref = assertGitHubPushRef(payload, expectedRef);
  if (!isGitObjectId(payload.before) || !isGitObjectId(payload.after) || typeof payload.forced !== "boolean") {
    throw new GitHubWebhookError("invalid_payload", "GitHub push revision fields are invalid", 400);
  }
  return { ref, before: payload.before, after: payload.after, forced: payload.forced };
}

function parseJsonObject(rawBody: Uint8Array): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new GitHubWebhookError("invalid_payload", "GitHub webhook body must be valid UTF-8 JSON", 400);
  }
  if (!isRecord(payload)) {
    throw new GitHubWebhookError("invalid_payload", "GitHub webhook body must be a JSON object", 400);
  }
  return payload;
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new GitHubWebhookError("missing_header", `Missing required GitHub webhook header '${name}'`, 400);
  return value;
}

function assertBodyLimit(maxBodyBytes: number): void {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new GitHubWebhookError("invalid_policy", "GitHub webhook body limit must be a positive integer", 500);
  }
}

function signatureBytes(value: string): Uint8Array | undefined {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(value);
  if (!match?.[1]) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
