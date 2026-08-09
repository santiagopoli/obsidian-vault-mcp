const driveApi = "https://www.googleapis.com/drive/v3";
const driveUploadApi = "https://www.googleapis.com/upload/drive/v3";
const driveFolderMime = "application/vnd.google-apps.folder";

export class GoogleDriveError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryable: boolean) {
    super(code);
  }
}

export function googleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const query = new URLSearchParams({
    client_id: required(input.clientId, "GOOGLE_CLIENT_ID"),
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state: input.state,
  });
  if (input.loginHint) query.set("login_hint", input.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

export async function exchangeGoogleCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ refreshToken: string }> {
  const tokens = await tokenRequest(new URLSearchParams({
    client_id: required(input.clientId, "GOOGLE_CLIENT_ID"),
    client_secret: required(input.clientSecret, "GOOGLE_CLIENT_SECRET"),
    code: required(input.code, "Google authorization code"),
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  }));
  assertDriveFileScope(tokens.scope);
  if (!tokens.refresh_token) throw new GoogleDriveError("google_refresh_token_missing", 400, false);
  return { refreshToken: tokens.refresh_token };
}

export async function refreshGoogleAccessToken(clientId: string, clientSecret: string, refreshToken: string, signal?: AbortSignal): Promise<string> {
  const tokens = await tokenRequest(new URLSearchParams({
    client_id: required(clientId, "GOOGLE_CLIENT_ID"),
    client_secret: required(clientSecret, "GOOGLE_CLIENT_SECRET"),
    refresh_token: required(refreshToken, "Google refresh token"),
    grant_type: "refresh_token",
  }), signal);
  if (!tokens.access_token) throw new GoogleDriveError("google_access_token_missing", 502, true);
  return tokens.access_token;
}

export async function createDriveFolder(accessToken: string, name: string, signal?: AbortSignal): Promise<string> {
  return createMetadata(accessToken, { name, mimeType: driveFolderMime }, signal);
}

export async function uploadDriveArchive(
  accessToken: string,
  name: string,
  parentId: string,
  archive: Response,
  signal?: AbortSignal,
): Promise<string> {
  if (!archive.body) throw new GoogleDriveError("vault_archive_empty", 502, true);
  const contentLength = archive.headers.get("Content-Length");
  if (!contentLength || !/^\d+$/.test(contentLength)) throw new GoogleDriveError("vault_archive_size_missing", 502, true);
  const session = await fetch(`${driveUploadApi}/files?uploadType=resumable&fields=id&supportsAllDrives=true`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "application/zip",
      "X-Upload-Content-Length": contentLength,
    },
    body: JSON.stringify({ name, mimeType: "application/zip", parents: [parentId] }),
  });
  if (session.status === 404) throw new GoogleDriveError("google_drive_parent_missing", 404, false);
  await requireGoogleResponse(session, "google_drive_upload_session_failed");
  const location = session.headers.get("Location");
  if (!location) throw new GoogleDriveError("google_drive_upload_session_missing", 502, true);
  const response = await fetch(location, {
    method: "PUT",
    signal,
    headers: { "Content-Type": "application/zip", "Content-Length": contentLength },
    body: archive.body,
  });
  await requireGoogleResponse(response, "google_drive_upload_failed");
  const result = await response.json<{ id?: string }>();
  if (!result.id) throw new GoogleDriveError("google_drive_file_id_missing", 502, true);
  return result.id;
}

export async function trashDriveFile(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${driveApi}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    signal,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  if (response.status === 404) return;
  await requireGoogleResponse(response, "google_drive_cleanup_failed");
}

async function createMetadata(accessToken: string, metadata: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${driveApi}/files?fields=id&supportsAllDrives=true`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  await requireGoogleResponse(response, "google_drive_create_failed");
  const result = await response.json<{ id?: string }>();
  if (!result.id) throw new GoogleDriveError("google_drive_file_id_missing", 502, true);
  return result.id;
}

async function tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<{ access_token?: string; refresh_token?: string; scope?: string }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const error: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
    const invalidGrant = error.error === "invalid_grant";
    throw new GoogleDriveError(invalidGrant ? "google_reauthorization_required" : "google_token_exchange_failed", response.status, !invalidGrant && (response.status === 429 || response.status >= 500));
  }
  return response.json();
}

async function requireGoogleResponse(response: Response, code: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) throw new GoogleDriveError("google_reauthorization_required", response.status, false);
  if (response.status === 403) throw new GoogleDriveError(code, response.status, true);
  throw new GoogleDriveError(code, response.status, response.status === 429 || response.status >= 500);
}

function assertDriveFileScope(scope: string | undefined): void {
  const scopes = new Set(scope?.split(/\s+/).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has("https://www.googleapis.com/auth/drive.file")) {
    throw new GoogleDriveError("google_scope_rejected", 403, false);
  }
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}
