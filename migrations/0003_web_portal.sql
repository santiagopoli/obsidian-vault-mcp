CREATE TABLE web_auth_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX web_auth_states_expiry_idx ON web_auth_states(expires_at);

CREATE TABLE mcp_consent_states (
  consent_id_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX mcp_consent_states_expiry_idx ON mcp_consent_states(expires_at);

CREATE TABLE web_sessions (
  session_hash TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX web_sessions_expiry_idx ON web_sessions(expires_at);

CREATE TABLE web_chat_usage (
  github_user_id TEXT NOT NULL,
  usage_day TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (github_user_id, usage_day)
);

CREATE TABLE web_vault_registry (
  repository_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
);
