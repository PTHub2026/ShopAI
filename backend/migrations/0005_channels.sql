-- Kênh thật của shop (hiện dùng cho Zalo OA; các kênh khác vẫn ở chế độ demo).
-- Worker cũng tạo bảng này lúc chạy (CREATE ... IF NOT EXISTS) nên áp dụng migration là tùy chọn, an toàn khi chạy lại.
-- Chỉ bổ sung (additive): không xóa hay đổi cột/bảng có sẵn. access_token/refresh_token không bao giờ trả ra giao diện.
CREATE TABLE IF NOT EXISTS shop_channels (
  shop_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  name TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  status TEXT,
  connected_by TEXT,
  connected_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (shop_id, provider)
);
