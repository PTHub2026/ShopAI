-- OAuth state records are short-lived and single-use, scoped to the initiating shop and actor.
CREATE TABLE IF NOT EXISTS meta_oauth_states (state_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL, actor TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS meta_oauth_expires ON meta_oauth_states(expires_at);
