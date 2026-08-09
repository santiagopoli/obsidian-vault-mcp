export type SyncStatus = "active" | "reauthorization_required" | "disabled";

export interface SyncDestination {
  destinationId: string;
  githubUserId: string;
  repositoryId: string;
  vault: string;
  provider: "google_drive";
  encryptedRefreshToken: string;
  rootFolderId?: string;
  archiveFileId?: string;
  cleanupFileId?: string;
  status: SyncStatus;
  lastSyncedRevision?: string;
  lastSyncedAt?: number;
  lastErrorCode?: string;
  createdAt: number;
  updatedAt: number;
}

interface SyncDestinationRow {
  destinationId: string;
  githubUserId: string;
  repositoryId: string;
  vault: string;
  provider: "google_drive";
  encryptedRefreshToken: string;
  rootFolderId: string | null;
  archiveFileId: string | null;
  cleanupFileId: string | null;
  status: SyncStatus;
  lastSyncedRevision: string | null;
  lastSyncedAt: number | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

const columns = `destination_id AS destinationId, github_user_id AS githubUserId,
  repository_id AS repositoryId, vault, provider, encrypted_refresh_token AS encryptedRefreshToken,
  root_folder_id AS rootFolderId, archive_file_id AS archiveFileId, cleanup_file_id AS cleanupFileId, status,
  last_synced_revision AS lastSyncedRevision, last_synced_at AS lastSyncedAt,
  last_error_code AS lastErrorCode, created_at AS createdAt, updated_at AS updatedAt`;

export async function listSyncDestinations(db: D1Database, githubUserId: string, repositoryId?: string): Promise<SyncDestination[]> {
  const query = repositoryId
    ? db.prepare(`SELECT ${columns} FROM vault_sync_destinations WHERE github_user_id = ? AND repository_id = ? ORDER BY created_at`).bind(githubUserId, repositoryId)
    : db.prepare(`SELECT ${columns} FROM vault_sync_destinations WHERE github_user_id = ? ORDER BY created_at`).bind(githubUserId);
  const result = await query.all<SyncDestinationRow>();
  return result.results.map(toDestination);
}

export async function listActiveSyncDestinations(db: D1Database, vault: string): Promise<SyncDestination[]> {
  const result = await db.prepare(`SELECT ${columns} FROM vault_sync_destinations WHERE vault = ? AND status = 'active' ORDER BY created_at`)
    .bind(vault).all<SyncDestinationRow>();
  return result.results.map(toDestination);
}

export async function getSyncDestination(db: D1Database, destinationId: string): Promise<SyncDestination | undefined> {
  const row = await db.prepare(`SELECT ${columns} FROM vault_sync_destinations WHERE destination_id = ?`)
    .bind(destinationId).first<SyncDestinationRow>();
  return row ? toDestination(row) : undefined;
}

export async function saveGoogleDriveDestination(db: D1Database, input: {
  githubUserId: string;
  repositoryId: string;
  vault: string;
  encryptedRefreshToken: string;
}): Promise<SyncDestination> {
  const now = Math.floor(Date.now() / 1_000);
  const destinationId = crypto.randomUUID();
  await db.batch([
    db.prepare("DELETE FROM vault_sync_destinations WHERE github_user_id = ? AND repository_id = ? AND provider = 'google_drive'")
      .bind(input.githubUserId, input.repositoryId),
    db.prepare(`INSERT INTO vault_sync_destinations (
      destination_id, github_user_id, repository_id, vault, provider, encrypted_refresh_token, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'google_drive', ?, 'active', ?, ?)`)
      .bind(destinationId, input.githubUserId, input.repositoryId, input.vault, input.encryptedRefreshToken, now, now),
  ]);
  const destination = (await listSyncDestinations(db, input.githubUserId, input.repositoryId))[0];
  if (!destination) throw new Error("sync_destination_not_saved");
  return destination;
}

export async function updateSyncSuccess(db: D1Database, destinationId: string, input: {
  revision: string;
  rootFolderId: string;
  archiveFileId: string;
}, fence: { runId: string; leaseToken: string }): Promise<boolean> {
  const now = Math.floor(Date.now() / 1_000);
  const result = await db.prepare(`UPDATE vault_sync_destinations SET root_folder_id = ?,
    cleanup_file_id = CASE WHEN archive_file_id IS NOT NULL AND archive_file_id <> ? THEN archive_file_id ELSE cleanup_file_id END,
    archive_file_id = ?,
    status = 'active', last_synced_revision = ?, last_synced_at = ?, last_error_code = NULL, updated_at = ?
    WHERE destination_id = ? AND EXISTS (
      SELECT 1 FROM automation_jobs AS jobs
      INNER JOIN automation_targets AS targets ON targets.run_id = jobs.run_id
      WHERE jobs.run_id = ? AND jobs.status = 'running' AND jobs.lease_token = ? AND jobs.lease_expires_at > ?
    )`)
    .bind(input.rootFolderId, input.archiveFileId, input.archiveFileId, input.revision, now, now, destinationId, fence.runId, fence.leaseToken, new Date().toISOString()).run();
  return result.meta.changes !== 0;
}

export async function clearSyncCleanup(db: D1Database, destinationId: string, fileId: string): Promise<void> {
  await db.prepare("UPDATE vault_sync_destinations SET cleanup_file_id = NULL WHERE destination_id = ? AND cleanup_file_id = ?")
    .bind(destinationId, fileId).run();
}

export async function updateSyncFailure(
  db: D1Database,
  destinationId: string,
  code: string,
  reauthorize: boolean,
  fence: { runId: string; leaseToken: string },
): Promise<boolean> {
  const result = await db.prepare(`UPDATE vault_sync_destinations SET status = ?, last_error_code = ?, updated_at = ?
    WHERE destination_id = ? AND EXISTS (
      SELECT 1 FROM automation_jobs AS jobs
      INNER JOIN automation_targets AS targets ON targets.run_id = jobs.run_id
      WHERE jobs.run_id = ? AND jobs.status = 'running' AND jobs.lease_token = ? AND jobs.lease_expires_at > ?
    )`)
    .bind(
      reauthorize ? "reauthorization_required" : "active",
      code.slice(0, 200),
      Math.floor(Date.now() / 1_000),
      destinationId,
      fence.runId,
      fence.leaseToken,
      new Date().toISOString(),
    ).run();
  return result.meta.changes !== 0;
}

export async function deleteSyncDestination(db: D1Database, githubUserId: string, repositoryId: string, destinationId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM vault_sync_destinations WHERE destination_id = ? AND github_user_id = ? AND repository_id = ?")
    .bind(destinationId, githubUserId, repositoryId).run();
  return result.meta.changes !== 0;
}

export async function createSyncOAuthState(db: D1Database, githubUserId: string, repositoryId: string): Promise<string> {
  const state = randomToken();
  await db.prepare("INSERT INTO vault_sync_oauth_states (state_hash, github_user_id, repository_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(state), githubUserId, repositoryId, Math.floor(Date.now() / 1_000) + 600).run();
  return state;
}

export async function consumeSyncOAuthState(db: D1Database, state: string, githubUserId: string): Promise<{ repositoryId: string } | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return undefined;
  const row = await db.prepare(`DELETE FROM vault_sync_oauth_states
    WHERE state_hash = ? AND github_user_id = ? AND expires_at > ? RETURNING repository_id AS repositoryId`)
    .bind(await sha256(state), githubUserId, Math.floor(Date.now() / 1_000)).first<{ repositoryId: string }>();
  return row ?? undefined;
}

export async function cleanupSyncOAuthStates(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM vault_sync_oauth_states WHERE expires_at <= ?").bind(Math.floor(Date.now() / 1_000)).run();
}

function toDestination(row: SyncDestinationRow): SyncDestination {
  return {
    destinationId: row.destinationId,
    githubUserId: row.githubUserId,
    repositoryId: row.repositoryId,
    vault: row.vault,
    provider: row.provider,
    encryptedRefreshToken: row.encryptedRefreshToken,
    ...(row.rootFolderId ? { rootFolderId: row.rootFolderId } : {}),
    ...(row.archiveFileId ? { archiveFileId: row.archiveFileId } : {}),
    ...(row.cleanupFileId ? { cleanupFileId: row.cleanupFileId } : {}),
    status: row.status,
    ...(row.lastSyncedRevision ? { lastSyncedRevision: row.lastSyncedRevision } : {}),
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
