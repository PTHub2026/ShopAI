-- Kho bản nháp văn bản theo mô hình S.posts, không nhập dữ liệu demo.
CREATE TABLE IF NOT EXISTS drafts (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, id)
  );
CREATE INDEX IF NOT EXISTS drafts_owner_updated ON drafts(owner, updated_at DESC);
