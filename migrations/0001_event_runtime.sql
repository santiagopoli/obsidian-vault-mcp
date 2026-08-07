CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  ref TEXT,
  before_sha TEXT,
  after_sha TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'accepted',
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_repository_received
  ON webhook_deliveries(repository_id, received_at DESC);

CREATE TABLE IF NOT EXISTS vault_states (
  repository_id TEXT PRIMARY KEY,
  vault TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_events (
  event_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT NOT NULL,
  before_revision TEXT NOT NULL,
  after_revision TEXT NOT NULL,
  before_sha TEXT,
  after_sha TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_events_vault_occurred
  ON vault_events(vault, occurred_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS vault_events_path_occurred
  ON vault_events(vault, path, occurred_at DESC);

CREATE TABLE IF NOT EXISTS automation_runs (
  run_id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT NOT NULL,
  handler TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(automation_id, event_id)
);

CREATE INDEX IF NOT EXISTS automation_runs_vault_updated
  ON automation_runs(vault, updated_at DESC, run_id DESC);
