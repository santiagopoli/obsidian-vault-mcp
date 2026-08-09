CREATE TABLE vault_sync_destinations (
  destination_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'google_drive'),
  encrypted_refresh_token TEXT NOT NULL,
  root_folder_id TEXT,
  archive_file_id TEXT,
  cleanup_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'reauthorization_required', 'disabled')),
  last_synced_revision TEXT,
  last_synced_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(github_user_id, repository_id, provider)
);

CREATE INDEX vault_sync_destinations_vault
  ON vault_sync_destinations(vault, status);

CREATE TABLE vault_sync_oauth_states (
  state_hash TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX vault_sync_oauth_states_expiry
  ON vault_sync_oauth_states(expires_at);
