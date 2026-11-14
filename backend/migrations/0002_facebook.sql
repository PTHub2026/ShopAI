CREATE TABLE IF NOT EXISTS facebook_owners (
  owner TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  origin TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS facebook_connections (
  owner TEXT NOT NULL,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_cipher TEXT,
  scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  tasks TEXT NOT NULL CHECK(json_valid(tasks)),
  verified_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected')),
  PRIMARY KEY(owner, page_id)
);
