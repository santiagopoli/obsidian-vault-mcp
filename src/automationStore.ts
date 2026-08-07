import { normalizeNotePath } from "./github";

export const automationJobStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "conflict",
  "skipped_superseded",
  "skipped_loop",
] as const;

export type AutomationJobStatus = typeof automationJobStatuses[number];
export type AutomationJobFinalStatus = Exclude<AutomationJobStatus, "queued" | "running">;

export interface EnqueueAutomationJobInput {
  automationId: string;
  handler: string;
  configHash: string;
  eventId: string;
  repositoryId: string;
  vault: string;
  sourcePath: string;
  sourceRevision: string;
  sourceSha: string;
  outputPath: string;
}

export interface AutomationJobRecord {
  jobSequence: number;
  runId: string;
  automationId: string;
  handler: string;
  configHash: string;
  eventId: string;
  repositoryId: string;
  vault: string;
  sourcePath: string;
  sourceRevision: string;
  sourceSha: string;
  outputPath: string;
  status: AutomationJobStatus;
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
  availableAt: string;
  outboxPending: boolean;
  dispatchedAt?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface EnqueuedAutomationJob {
  job: AutomationJobRecord;
  inserted: boolean;
  currentTarget: boolean;
}

export interface ClaimAutomationJobOptions {
  leaseToken: string;
  leaseDurationMs: number;
  now?: Date;
}

export interface FinishAutomationJobOptions {
  status: AutomationJobFinalStatus;
  errorCode?: string;
  retryAt?: Date;
  now?: Date;
}

interface AutomationJobRow {
  jobSequence: number;
  runId: string;
  automationId: string;
  handler: string;
  configHash: string;
  eventId: string;
  repositoryId: string;
  vault: string;
  sourcePath: string;
  sourceRevision: string;
  sourceSha: string;
  outputPath: string;
  status: AutomationJobStatus;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  availableAt: string;
  outboxPending: number;
  dispatchedAt: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export class AutomationJobWriteFenceError extends Error {
  constructor(readonly runId: string) {
    super(`Automation job '${runId}' no longer owns its target and lease`);
    this.name = "AutomationJobWriteFenceError";
  }
}

export async function enqueueAutomationJob(
  db: D1Database,
  input: EnqueueAutomationJobInput,
  now = new Date(),
): Promise<EnqueuedAutomationJob> {
  const normalized = normalizeInput(input);
  const runId = automationJobRunId(normalized.automationId, normalized.configHash, normalized.eventId);
  const timestamp = iso(now);
  const results = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO automation_jobs (
        run_id, automation_id, handler, config_hash, event_id, repository_id,
        vault, source_path, source_revision, source_sha, output_path,
        status, attempts, available_at, outbox_pending, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, 1, ?, ?)
    `).bind(
      runId,
      normalized.automationId,
      normalized.handler,
      normalized.configHash,
      normalized.eventId,
      normalized.repositoryId,
      normalized.vault,
      normalized.sourcePath,
      normalized.sourceRevision,
      normalized.sourceSha,
      normalized.outputPath,
      timestamp,
      timestamp,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO automation_targets (
        automation_id, vault, source_path, run_id, job_sequence, updated_at
      )
      SELECT automation_id, vault, source_path, run_id, job_sequence, ?
      FROM automation_jobs WHERE run_id = ?
      ON CONFLICT(automation_id, vault, source_path) DO UPDATE SET
        run_id = excluded.run_id,
        job_sequence = excluded.job_sequence,
        updated_at = excluded.updated_at
      WHERE excluded.job_sequence > automation_targets.job_sequence
    `).bind(timestamp, runId),
    db.prepare(`
      UPDATE automation_jobs
      SET status = 'skipped_superseded', outbox_pending = 0,
        completed_at = ?, updated_at = ?
      WHERE automation_id = ? AND vault = ? AND source_path = ?
        AND run_id <> ? AND status IN ('queued', 'failed_retryable')
        AND EXISTS (
          SELECT 1 FROM automation_targets
          WHERE automation_targets.automation_id = automation_jobs.automation_id
            AND automation_targets.vault = automation_jobs.vault
            AND automation_targets.source_path = automation_jobs.source_path
            AND automation_targets.run_id = ?
        )
    `).bind(
      timestamp,
      timestamp,
      normalized.automationId,
      normalized.vault,
      normalized.sourcePath,
      runId,
      runId,
    ),
  ]);

  const job = await requireAutomationJob(db, runId);
  assertSameJob(job, normalized);
  const target = await db.prepare(`
    SELECT run_id AS runId FROM automation_targets
    WHERE automation_id = ? AND vault = ? AND source_path = ?
  `).bind(job.automationId, job.vault, job.sourcePath).first<{ runId: string }>();
  return {
    job,
    inserted: (results[0]?.meta.changes ?? 0) !== 0,
    currentTarget: target?.runId === runId,
  };
}

export async function listPendingAutomationJobs(
  db: D1Database,
  limit = 50,
  now = new Date(),
): Promise<AutomationJobRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Automation outbox limit must be an integer between 1 and 100");
  }
  const result = await db.prepare(`
    SELECT ${automationJobColumnsWithAlias("jobs")}
    FROM automation_jobs AS jobs
    INNER JOIN automation_targets AS targets ON targets.run_id = jobs.run_id
    WHERE (
      (jobs.outbox_pending = 1
        AND jobs.status IN ('queued', 'failed_retryable')
        AND jobs.available_at <= ?)
      OR (jobs.status = 'running' AND jobs.lease_expires_at <= ?)
    )
    ORDER BY jobs.job_sequence
    LIMIT ?
  `).bind(iso(now), iso(now), limit).all<AutomationJobRow>();
  return result.results.map(toRecord);
}

export async function markAutomationJobDispatched(
  db: D1Database,
  runId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE automation_jobs
    SET outbox_pending = 0, dispatched_at = ?, updated_at = ?
    WHERE run_id = ?
      AND outbox_pending = 1
      AND status IN ('queued', 'failed_retryable')
  `).bind(iso(now), iso(now), requiredText(runId, "run ID", 4000)).run();
  return result.meta.changes !== 0;
}

export async function claimAutomationJob(
  db: D1Database,
  runId: string,
  options: ClaimAutomationJobOptions,
): Promise<AutomationJobRecord | undefined> {
  const now = options.now ?? new Date();
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 1_000 || options.leaseDurationMs > 3_600_000) {
    throw new Error("Automation lease duration must be between 1 second and 1 hour");
  }
  const leaseToken = requiredText(options.leaseToken, "lease token", 200);
  const timestamp = iso(now);
  const leaseExpiresAt = iso(new Date(now.getTime() + options.leaseDurationMs));
  const row = await db.prepare(`
    UPDATE automation_jobs
    SET status = 'running', attempts = attempts + 1,
      lease_token = ?, lease_expires_at = ?, outbox_pending = 0,
      error_code = NULL, updated_at = ?
    WHERE run_id = ?
      AND (
        (status IN ('queued', 'failed_retryable') AND available_at <= ?)
        OR (status = 'running' AND lease_expires_at <= ?)
      )
      AND (lease_token IS NULL OR lease_token <> ?)
      AND EXISTS (SELECT 1 FROM automation_targets WHERE automation_targets.run_id = automation_jobs.run_id)
    RETURNING ${automationJobColumns}
  `).bind(
    leaseToken,
    leaseExpiresAt,
    timestamp,
    requiredText(runId, "run ID", 4000),
    timestamp,
    timestamp,
    leaseToken,
  ).first<AutomationJobRow>();
  return row ? toRecord(row) : undefined;
}

export async function assertAutomationJobCanWrite(
  db: D1Database,
  runId: string,
  leaseToken: string,
  now = new Date(),
): Promise<AutomationJobRecord> {
  const row = await db.prepare(`
    SELECT ${automationJobColumnsWithAlias("jobs")}
    FROM automation_jobs AS jobs
    INNER JOIN automation_targets AS targets
      ON targets.automation_id = jobs.automation_id
      AND targets.vault = jobs.vault
      AND targets.source_path = jobs.source_path
      AND targets.run_id = jobs.run_id
    WHERE jobs.run_id = ?
      AND jobs.status = 'running'
      AND jobs.lease_token = ?
      AND jobs.lease_expires_at > ?
  `).bind(
    requiredText(runId, "run ID", 4000),
    requiredText(leaseToken, "lease token", 200),
    iso(now),
  ).first<AutomationJobRow>();
  if (!row) throw new AutomationJobWriteFenceError(runId);
  return toRecord(row);
}

export async function finishAutomationJob(
  db: D1Database,
  runId: string,
  leaseToken: string,
  options: FinishAutomationJobOptions,
): Promise<boolean> {
  const now = options.now ?? new Date();
  const timestamp = iso(now);
  if (!automationJobFinalStatuses.has(options.status)) {
    throw new Error("Automation finish status is invalid");
  }
  const errorCode = optionalErrorCode(options.errorCode);
  const retryable = options.status === "failed_retryable";
  if (retryable !== (options.retryAt !== undefined)) {
    throw new Error("Retryable automation jobs require retryAt, and terminal jobs must omit it");
  }
  const availableAt = options.retryAt ? iso(options.retryAt) : timestamp;
  if (options.retryAt && options.retryAt.getTime() <= now.getTime()) {
    throw new Error("Automation retryAt must be in the future");
  }
  const result = await db.prepare(`
    UPDATE automation_jobs
    SET status = ?, lease_token = NULL, lease_expires_at = NULL,
      available_at = ?, outbox_pending = ?, error_code = ?,
      completed_at = ?, updated_at = ?
    WHERE run_id = ? AND status = 'running' AND lease_token = ?
  `).bind(
    options.status,
    availableAt,
    retryable ? 1 : 0,
    errorCode ?? null,
    retryable ? null : timestamp,
    timestamp,
    requiredText(runId, "run ID", 4000),
    requiredText(leaseToken, "lease token", 200),
  ).run();
  return result.meta.changes !== 0;
}

export function automationJobRunId(automationId: string, configHash: string, eventId: string): string {
  const runId = `automation-job:v1:${encodeURIComponent(requiredText(automationId, "automation ID", 64))}:${hex(configHash, 64, "config hash")}:${encodeURIComponent(requiredText(eventId, "event ID", 3000))}`;
  return requiredText(runId, "automation run ID", 4000);
}

const automationJobFinalStatuses = new Set<AutomationJobFinalStatus>([
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "conflict",
  "skipped_superseded",
  "skipped_loop",
]);

const automationJobColumns = jobColumns();

const selectAutomationJob = `SELECT ${automationJobColumns} FROM automation_jobs`;

function automationJobColumnsWithAlias(alias: string): string {
  return jobColumns(`${alias}.`);
}

function jobColumns(prefix = ""): string {
  return `
    ${prefix}job_sequence AS jobSequence, ${prefix}run_id AS runId,
    ${prefix}automation_id AS automationId, ${prefix}handler,
    ${prefix}config_hash AS configHash, ${prefix}event_id AS eventId,
    ${prefix}repository_id AS repositoryId, ${prefix}vault,
    ${prefix}source_path AS sourcePath, ${prefix}source_revision AS sourceRevision,
    ${prefix}source_sha AS sourceSha, ${prefix}output_path AS outputPath,
    ${prefix}status, ${prefix}attempts, ${prefix}lease_token AS leaseToken,
    ${prefix}lease_expires_at AS leaseExpiresAt, ${prefix}available_at AS availableAt,
    ${prefix}outbox_pending AS outboxPending, ${prefix}dispatched_at AS dispatchedAt,
    ${prefix}error_code AS errorCode, ${prefix}created_at AS createdAt,
    ${prefix}updated_at AS updatedAt, ${prefix}completed_at AS completedAt
  `;
}

async function requireAutomationJob(db: D1Database, runId: string): Promise<AutomationJobRecord> {
  const row = await db.prepare(`${selectAutomationJob} WHERE run_id = ?`).bind(runId).first<AutomationJobRow>();
  if (!row) throw new Error(`Automation job '${runId}' was not persisted`);
  return toRecord(row);
}

function normalizeInput(input: EnqueueAutomationJobInput): EnqueueAutomationJobInput {
  return {
    automationId: requiredText(input.automationId, "automation ID", 64),
    handler: requiredText(input.handler, "automation handler", 64),
    configHash: hex(input.configHash, 64, "config hash"),
    eventId: requiredText(input.eventId, "event ID", 3000),
    repositoryId: requiredText(input.repositoryId, "repository ID", 64),
    vault: requiredText(input.vault, "vault", 200),
    sourcePath: normalizeNotePath(input.sourcePath),
    sourceRevision: hex(input.sourceRevision, 40, "source revision"),
    sourceSha: hex(input.sourceSha, 40, "source SHA"),
    outputPath: normalizeNotePath(input.outputPath),
  };
}

function assertSameJob(job: AutomationJobRecord, input: EnqueueAutomationJobInput): void {
  const fields = [
    job.automationId === input.automationId,
    job.handler === input.handler,
    job.configHash === input.configHash,
    job.eventId === input.eventId,
    job.repositoryId === input.repositoryId,
    job.vault === input.vault,
    job.sourcePath === input.sourcePath,
    job.sourceRevision === input.sourceRevision,
    job.sourceSha === input.sourceSha,
    job.outputPath === input.outputPath,
  ];
  if (fields.some((matches) => !matches)) {
    throw new Error(`Automation run ID '${job.runId}' was reused with different metadata`);
  }
}

function toRecord(row: AutomationJobRow): AutomationJobRecord {
  return {
    jobSequence: row.jobSequence,
    runId: row.runId,
    automationId: row.automationId,
    handler: row.handler,
    configHash: row.configHash,
    eventId: row.eventId,
    repositoryId: row.repositoryId,
    vault: row.vault,
    sourcePath: row.sourcePath,
    sourceRevision: row.sourceRevision,
    sourceSha: row.sourceSha,
    outputPath: row.outputPath,
    status: row.status,
    attempts: row.attempts,
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    availableAt: row.availableAt,
    outboxPending: row.outboxPending === 1,
    ...(row.dispatchedAt ? { dispatchedAt: row.dispatchedAt } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  };
}

function requiredText(value: string, label: string, maxLength: number): string {
  if (!value || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must contain between 1 and ${maxLength} safe characters`);
  }
  return value;
}

function hex(value: string, length: number, label: string): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`${label} must be a lower-case ${length}-character hexadecimal value`);
  }
  return value;
}

function optionalErrorCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "automation error code", 200);
}

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Automation timestamp is invalid");
  return value.toISOString();
}
