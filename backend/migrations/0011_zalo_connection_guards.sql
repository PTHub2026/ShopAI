-- Additive state and token rotation guards, matching runtime initialization.
CREATE TABLE IF NOT EXISTS channel_oauth_states (state TEXT PRIMARY KEY, actor TEXT NOT NULL, shop_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_refresh_locks (shop_id TEXT NOT NULL, provider TEXT NOT NULL, lease TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(shop_id,provider));
CREATE TABLE IF NOT EXISTS channel_public_media (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, mime TEXT NOT NULL, body BLOB NOT NULL, created_at INTEGER NOT NULL);
