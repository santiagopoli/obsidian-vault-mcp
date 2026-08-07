import type { VaultEvent } from "./events";

export interface WebhookDeliveryRecord {
  deliveryId: string;
  hookId: string;
  eventType: "ping" | "push" | "reconcile";
  repositoryId: string;
  vault: string;
  ref?: string;
  beforeSha?: string;
  afterSha?: string;
  forced: boolean;
  bodySha256: string;
}

export interface VaultState {
  repositoryId: string;
  vault: string;
  revision: string;
}

export interface StoredVaultEvent {
  eventId: string;
  repositoryId: string;
  vault: string;
  eventType: VaultEvent["type"];
  path: string;
  beforeRevision: string;
  afterRevision: string;
  beforeSha?: string;
  afterSha?: string;
  occurredAt: string;
}

export interface StoredAutomationRun {
  runId: string;
  automationId: string;
  eventId: string;
  vault: string;
  eventType: string;
  path: string;
  handler: string;
  status: string;
  attempts: number;
  errorCode?: string;
  updatedAt: string;
}

export async function recordWebhookDelivery(db: D1Database, delivery: WebhookDeliveryRecord): Promise<"accepted" | "duplicate"> {
  const receivedAt = new Date().toISOString();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries (
      delivery_id, hook_id, event_type, repository_id, vault, ref,
      before_sha, after_sha, forced, body_sha256, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    delivery.deliveryId,
    delivery.hookId,
    delivery.eventType,
    delivery.repositoryId,
    delivery.vault,
    delivery.ref ?? null,
    delivery.beforeSha ?? null,
    delivery.afterSha ?? null,
    delivery.forced ? 1 : 0,
    delivery.bodySha256,
    receivedAt,
  ).run();
  if (result.meta.changes !== 0) return "accepted";

  const existing = await db.prepare(`
    SELECT body_sha256 AS bodySha256 FROM webhook_deliveries WHERE delivery_id = ?
  `).bind(delivery.deliveryId).first<{ bodySha256: string }>();
  if (!existing || existing.bodySha256 !== delivery.bodySha256) {
    throw new Error("Webhook delivery ID was reused with different content");
  }
  return "duplicate";
}

export async function markWebhookDeliveryProcessed(db: D1Database, deliveryId: string, disposition = "processed"): Promise<void> {
  await db.prepare(`
    UPDATE webhook_deliveries SET disposition = ?, processed_at = ? WHERE delivery_id = ?
  `).bind(disposition, new Date().toISOString(), deliveryId).run();
}

export async function getVaultState(db: D1Database, repositoryId: string): Promise<VaultState | undefined> {
  const row = await db.prepare(`
    SELECT repository_id AS repositoryId, vault, revision
    FROM vault_states WHERE repository_id = ?
  `).bind(repositoryId).first<VaultState>();
  return row ?? undefined;
}

export async function storeVaultEvents(
  db: D1Database,
  repositoryId: string,
  vault: string,
  revision: string,
  events: VaultEvent[],
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const statements = events.map((event) => db.prepare(`
    INSERT OR IGNORE INTO vault_events (
      event_id, repository_id, vault, event_type, path,
      before_revision, after_revision, before_sha, after_sha, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id,
    repositoryId,
    vault,
    event.type,
    event.path,
    event.beforeRevision,
    event.afterRevision,
    beforeSha(event) ?? null,
    afterSha(event) ?? null,
    occurredAt,
  ));
  statements.push(db.prepare(`
    INSERT INTO vault_states (repository_id, vault, revision, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET
      vault = excluded.vault,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).bind(repositoryId, vault, revision, occurredAt));
  await db.batch(statements);
}

export async function startAutomationRun(
  db: D1Database,
  automationId: string,
  event: VaultEvent,
  repositoryId: string,
  vault: string,
  handler: string,
): Promise<{ runId: string; status: "claimed" | "running" | "succeeded" }> {
  const runId = `automation-run:v1:${encodeURIComponent(automationId)}:${encodeURIComponent(event.id)}`;
  const now = new Date().toISOString();
  const leaseCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const claimed = await db.prepare(`
    INSERT INTO automation_runs (
      run_id, automation_id, event_id, repository_id, vault,
      event_type, path, handler, status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?)
    ON CONFLICT(automation_id, event_id) DO UPDATE SET
      status = 'running', attempts = automation_runs.attempts + 1,
      error_code = NULL, updated_at = excluded.updated_at
    WHERE automation_runs.status = 'failed'
      OR (automation_runs.status = 'running' AND automation_runs.updated_at < ?)
    RETURNING run_id AS runId
  `).bind(
    runId,
    automationId,
    event.id,
    repositoryId,
    vault,
    event.type,
    event.path,
    handler,
    now,
    now,
    leaseCutoff,
  ).first<{ runId: string }>();
  if (claimed) return { runId, status: "claimed" };

  const existing = await db.prepare(`
    SELECT status FROM automation_runs WHERE automation_id = ? AND event_id = ?
  `).bind(automationId, event.id).first<{ status: string }>();
  return { runId, status: existing?.status === "succeeded" ? "succeeded" : "running" };
}

export async function finishAutomationRun(
  db: D1Database,
  runId: string,
  status: "succeeded" | "failed" | "skipped",
  errorCode?: string,
): Promise<void> {
  await db.prepare(`
    UPDATE automation_runs SET status = ?, error_code = ?, updated_at = ? WHERE run_id = ?
  `).bind(status, errorCode ?? null, new Date().toISOString(), runId).run();
}

export async function listVaultEvents(
  db: D1Database,
  vault: string,
  options: { eventType?: VaultEvent["type"]; pathPrefix?: string; limit: number; offset: number },
): Promise<StoredVaultEvent[]> {
  const conditions = ["vault = ?"];
  const bindings: unknown[] = [vault];
  if (options.eventType) {
    conditions.push("event_type = ?");
    bindings.push(options.eventType);
  }
  if (options.pathPrefix) {
    conditions.push("(path = ? OR path LIKE ? ESCAPE '\\')");
    const escaped = options.pathPrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    bindings.push(options.pathPrefix, `${escaped}/%`);
  }
  bindings.push(options.limit, options.offset);
  const result = await db.prepare(`
    SELECT event_id AS eventId, repository_id AS repositoryId, vault,
      event_type AS eventType, path, before_revision AS beforeRevision,
      after_revision AS afterRevision, before_sha AS beforeSha,
      after_sha AS afterSha, occurred_at AS occurredAt
    FROM vault_events
    WHERE ${conditions.join(" AND ")}
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT ? OFFSET ?
  `).bind(...bindings).all<StoredVaultEvent>();
  return result.results;
}

export async function listAutomationRuns(
  db: D1Database,
  vault: string,
  limit: number,
  offset: number,
): Promise<StoredAutomationRun[]> {
  const result = await db.prepare(`
    SELECT run_id AS runId, automation_id AS automationId, event_id AS eventId,
      vault, event_type AS eventType, path, handler, status, attempts,
      error_code AS errorCode, updated_at AS updatedAt
    FROM automation_runs WHERE vault = ?
    ORDER BY updated_at DESC, run_id DESC LIMIT ? OFFSET ?
  `).bind(vault, limit, offset).all<StoredAutomationRun>();
  return result.results;
}

function beforeSha(event: VaultEvent): string | undefined {
  if (event.type === "note.updated") return event.beforeSha;
  if (event.type === "note.deleted") return event.noteSha;
  return undefined;
}

function afterSha(event: VaultEvent): string | undefined {
  if (event.type === "note.updated") return event.afterSha;
  if (event.type === "note.created") return event.noteSha;
  return undefined;
}
