-- Phiên đăng nhập riêng của ShopAI (Facebook, Zalo, Email OTP). Không đụng bảng drafts.
-- Worker cũng tạo các bảng này lúc chạy (CREATE ... IF NOT EXISTS), nên áp dụng migration là tùy chọn và an toàn khi chạy lại.
CREATE TABLE IF NOT EXISTS auth_identities (owner TEXT PRIMARY KEY, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, last_login_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_otp_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_oauth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
