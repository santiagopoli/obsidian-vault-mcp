import { decryptCredential } from "./credentialCipher";
import { fetchVaultArchive, GitHubError } from "./github";
import {
  createDriveFolder,
  GoogleDriveError,
  refreshGoogleAccessToken,
  trashDriveFile,
  uploadDriveArchive,
} from "./googleDrive";
import { clearSyncCleanup, getSyncDestination, updateSyncFailure, updateSyncSuccess } from "./syncStore";
import { resolveVault } from "./config";
import { AutomationJobWriteFenceError, type AutomationJobRecord } from "./automationStore";
import type { Env } from "./types";
import { enqueueAutomationJob } from "./automationStore";
import type { SyncDestination } from "./syncStore";

export async function syncVaultToGoogleDrive(
  env: Env,
  job: AutomationJobRecord,
  leaseToken: string,
): Promise<void> {
  const destination = await getSyncDestination(env.EVENT_DB, job.outputPath.replace(/^_Sync\//, "").replace(/\.md$/, ""));
  if (!destination || destination.status === "disabled" || destination.vault !== job.vault) throw new Error("sync_destination_unavailable");
  if (destination.lastSyncedRevision === job.sourceRevision && !destination.cleanupFileId) return;
  const signal = AbortSignal.timeout(4 * 60_000);
  try {
    const refreshToken = await decryptCredential(
      env.SYNC_CREDENTIALS_KEY ?? "",
      destination.encryptedRefreshToken,
      credentialContext(destination.githubUserId, destination.repositoryId),
    );
    const accessToken = await refreshGoogleAccessToken(env.GOOGLE_CLIENT_ID ?? "", env.GOOGLE_CLIENT_SECRET ?? "", refreshToken, signal);
    if (destination.cleanupFileId) {
      await trashDriveFile(accessToken, destination.cleanupFileId, signal);
      await clearSyncCleanup(env.EVENT_DB, destination.destinationId, destination.cleanupFileId);
      if (destination.lastSyncedRevision === job.sourceRevision) return;
    }
    const archive = await fetchVaultArchive(env.GITHUB_VAULT_TOKEN, resolveVault(env, job.vault), job.sourceRevision, signal);
    let rootFolderId = destination.rootFolderId
      ?? await createDriveFolder(accessToken, `Obsidian Vault — ${vaultLabel(destination.vault)}`, signal);
    let nextArchiveId: string;
    try {
      nextArchiveId = await uploadDriveArchive(accessToken, `${vaultLabel(destination.vault)}.zip`, rootFolderId, archive, signal);
    } catch (error) {
      if (!(error instanceof GoogleDriveError) || error.code !== "google_drive_parent_missing") throw error;
      rootFolderId = await createDriveFolder(accessToken, `Obsidian Vault — ${vaultLabel(destination.vault)}`, signal);
      nextArchiveId = await uploadDriveArchive(accessToken, `${vaultLabel(destination.vault)}.zip`, rootFolderId, archive, signal);
    }
    try {
      const committed = await updateSyncSuccess(env.EVENT_DB, destination.destinationId, {
        revision: job.sourceRevision,
        rootFolderId,
        archiveFileId: nextArchiveId,
      }, { runId: job.runId, leaseToken });
      if (!committed) throw new AutomationJobWriteFenceError(job.runId);
    } catch (error) {
      await trashDriveFile(accessToken, nextArchiveId).catch(() => undefined);
      throw error;
    }
    if (destination.archiveFileId && destination.archiveFileId !== nextArchiveId) {
      await trashDriveFile(accessToken, destination.archiveFileId, signal);
      await clearSyncCleanup(env.EVENT_DB, destination.destinationId, destination.archiveFileId);
    }
  } catch (error) {
    if (error instanceof AutomationJobWriteFenceError) throw error;
    const reauthorize = error instanceof GoogleDriveError && error.code === "google_reauthorization_required";
    const recorded = await updateSyncFailure(
      env.EVENT_DB,
      destination.destinationId,
      syncErrorCode(error),
      reauthorize,
      { runId: job.runId, leaseToken },
    );
    if (!recorded) throw new AutomationJobWriteFenceError(job.runId);
    throw error;
  }
}

export function credentialContext(githubUserId: string, repositoryId: string): string {
  return `vault-sync:v1:${githubUserId}:${repositoryId}:google_drive`;
}

export async function syncConfigHash(destinationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`google-drive-sync:v1:${destinationId}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enqueueSyncSnapshot(
  env: Env,
  destination: SyncDestination,
  revision: string,
  eventId: string,
): Promise<void> {
  const targetPath = `_Sync/${destination.destinationId}.md`;
  await enqueueAutomationJob(env.EVENT_DB, {
    automationId: `sync-google:${destination.destinationId}`,
    handler: "sync-google-drive",
    configHash: await syncConfigHash(destination.destinationId),
    eventId,
    repositoryId: destination.repositoryId,
    vault: destination.vault,
    sourcePath: targetPath,
    sourceRevision: revision,
    sourceSha: revision,
    outputPath: targetPath,
  });
}

function vaultLabel(vault: string): string {
  return vault.split("/").pop()?.replace(/[^A-Za-z0-9._ -]/g, "-").slice(0, 100) || "vault";
}

function syncErrorCode(error: unknown): string {
  if (error instanceof GoogleDriveError) return error.code;
  if (error instanceof GitHubError) return `github_${error.status}`;
  if (error instanceof TypeError) return "sync_network_failed";
  if (error instanceof Error && error.message === "sync_credential_invalid") return "sync_credential_invalid";
  return "sync_failed";
}
