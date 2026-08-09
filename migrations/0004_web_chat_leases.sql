CREATE TABLE web_chat_leases (
  github_user_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX web_chat_leases_expiry_idx ON web_chat_leases(expires_at);
