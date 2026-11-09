-- 0003: shop, thành viên, phân quyền, lời mời, nhật ký hệ thống, liên kết danh tính.
-- Worker tự tạo schema này lúc chạy (idempotent, xem backend/src/shops.js ensureShopSchema).
-- Áp thủ công vào D1 production: nếu Worker đã chạy trước đó, 4 câu ALTER TABLE drafts sẽ báo "duplicate column" — bỏ qua an toàn.
-- Không xóa hay đổi cột cũ của bảng drafts.

CREATE TABLE IF NOT EXISTS shops (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shops_owner ON shops(owner, created_at);
CREATE TABLE IF NOT EXISTS shop_members (shop_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'content', 'support', 'viewer')), can_publish INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, invited_by TEXT, PRIMARY KEY (shop_id, user_id));
CREATE INDEX IF NOT EXISTS shop_members_user ON shop_members(user_id, created_at);
CREATE TABLE IF NOT EXISTS shop_invites (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, email TEXT, role TEXT NOT NULL CHECK (role IN ('manager', 'content', 'support', 'viewer')), token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_by TEXT, accepted_at INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS shop_invites_shop ON shop_invites(shop_id, created_at);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT CHECK (detail IS NULL OR json_valid(detail)), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at);
CREATE TABLE IF NOT EXISTS identity_links (owner TEXT PRIMARY KEY, email TEXT NOT NULL, source TEXT NOT NULL, verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS identity_links_email ON identity_links(email);

ALTER TABLE drafts ADD COLUMN shop_id TEXT;
ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE drafts ADD COLUMN assigned_to TEXT;
ALTER TABLE drafts ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS drafts_shop_updated ON drafts(shop_id, updated_at DESC);
