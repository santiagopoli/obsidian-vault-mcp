CREATE TABLE IF NOT EXISTS automation_jobs (
  job_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  automation_id TEXT NOT NULL,
  handler TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  output_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  outbox_pending INTEGER NOT NULL DEFAULT 1,
  dispatched_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(automation_id, config_hash, event_id),
  UNIQUE(run_id, job_sequence),
  CHECK(length(run_id) BETWEEN 1 AND 4000),
  CHECK(length(automation_id) BETWEEN 1 AND 64),
  CHECK(length(handler) BETWEEN 1 AND 64),
  CHECK(length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(source_revision) = 40 AND source_revision NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(source_sha) = 40 AND source_sha NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(source_path) BETWEEN 1 AND 500),
  CHECK(length(output_path) BETWEEN 1 AND 500),
  CHECK(status IN (
    'queued', 'running', 'succeeded', 'failed_retryable',
    'failed_terminal', 'conflict', 'skipped_superseded', 'skipped_loop'
  )),
  CHECK(attempts >= 0),
  CHECK(outbox_pending IN (0, 1)),
  CHECK(outbox_pending = 0 OR status IN ('queued', 'failed_retryable')),
  CHECK(
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS automation_jobs_outbox
  ON automation_jobs(outbox_pending, available_at, job_sequence);

CREATE INDEX IF NOT EXISTS automation_jobs_expired_leases
  ON automation_jobs(status, lease_expires_at)
  WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS automation_jobs_active_lease_tokens
  ON automation_jobs(lease_token)
  WHERE lease_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS automation_jobs_vault_updated
  ON automation_jobs(vault, updated_at DESC, job_sequence DESC);

CREATE TABLE IF NOT EXISTS automation_targets (
  automation_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  source_path TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(automation_id, vault, source_path),
  UNIQUE(run_id),
  FOREIGN KEY(run_id, job_sequence)
    REFERENCES automation_jobs(run_id, job_sequence) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS automation_targets_run
  ON automation_targets(run_id);
