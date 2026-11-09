-- Lịch đăng thật cho kênh đã kết nối (hiện dùng cho Zalo OA; các kênh khác vẫn ở chế độ demo).
-- Cron Trigger (triggers.crons trong wrangler.jsonc) quét các bản ghi đến giờ rồi đăng.
-- Worker cũng tạo bảng này lúc chạy (CREATE ... IF NOT EXISTS) nên áp dụng migration là tùy chọn, an toàn khi chạy lại.
-- Chỉ bổ sung (additive): không xóa hay đổi cột/bảng có sẵn. images lưu nguyên data URL/URL để cron tải lên Zalo khi đăng.
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  title TEXT,
  content TEXT,
  images TEXT,
  author TEXT,
  run_at INTEGER,
  status TEXT,
  result_id TEXT,
  result_url TEXT,
  error TEXT,
  attempts INTEGER DEFAULT 0,
  created_by TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts (status, run_at);
