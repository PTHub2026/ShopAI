-- 0004: mật khẩu đăng nhập (PBKDF2) cho đăng ký, đăng nhập, quên mật khẩu và đặt/đổi mật khẩu.
-- Worker cũng tạo bảng này lúc chạy (CREATE ... IF NOT EXISTS, xem backend/src/auth.js PASSWORD_SCHEMA),
-- nên áp dụng migration là tùy chọn và an toàn khi chạy lại. Không đụng bảng auth cũ.
-- Khóa theo owner (định danh phiên: email:<email>, fb:<id>, …); cột email duy nhất để đăng nhập/đặt lại bằng email.
CREATE TABLE IF NOT EXISTS auth_passwords (owner TEXT PRIMARY KEY, email TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT, password_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS auth_passwords_email ON auth_passwords(email);
