CREATE TABLE IF NOT EXISTS meta_oauth_state_fences (state_hash TEXT PRIMARY KEY, shop_id TEXT NOT NULL, generation INTEGER NOT NULL);
