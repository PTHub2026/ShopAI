CREATE TABLE IF NOT EXISTS channel_connection_generations(shop_id TEXT NOT NULL,provider TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(shop_id,provider));
