# Shoppost — bản hợp nhất 10/11/2026

Trạng thái: hợp nhất và kiểm thử cục bộ; chưa phát hành GitHub/Cloudflare.

## Nguồn được giữ

- Main b605373: giao diện, thành viên, Zalo OA OAuth/kết nối/đăng ảnh/lịch Cron.
- e33a24d: claim lịch nguyên tử; hai lượt Cron không đăng trùng cùng một lịch.
- PR #19: tên hiển thị Shoppost; giữ cookie, scope, header và dữ liệu cũ.
- PR #20 / 944f14a: Telegram, Facebook Page, Instagram, mã hóa token social, job/idempotency và retry_after.
- Không phục hồi đăng nhập Zalo/Facebook. Callback /auth/zalo/callback của main phục vụ kết nối OA và yêu cầu phiên đã đăng nhập, không tạo phiên đăng nhập mới.

## Quyết định hợp nhất

- Dùng main mới làm nền, chuyển từng module; không merge nguyên trạng index/auth từ các nhánh cũ.
- Giữ shop_channels/scheduled_posts của Zalo; social_accounts/publish_jobs quản lý các kênh còn lại. Chưa chuyển dữ liệu giữa hai bộ bảng.
- Giữ migrations 0001–0006 đã có trên main. Các migration social dùng 0008, 0009, 0010 để không ghi đè 0005_channels và 0006_scheduled; khoảng trống 0007 là chủ ý. Cần kiểm kê d1_migrations trước áp dụng, không chạy lại migration đã ghi nhận hoặc đổi tên trên DB đã áp bộ tên cũ.
- Trang Kênh managed có cả OA và các kênh social; phần soạn/lịch Zalo hiện tại được bảo toàn.
- Giữ nguyên routes, DB bindings, Cron và biến triển khai của main. Không sửa production.

## Bằng chứng

- npm test: 117/117 pass, gồm workerd + D1 cục bộ, anti-duplicate Cron và nâng cấp SQLite giữ OA cũ.
- Build app.js qua backend/build.mjs trong bộ test; esbuild bundle toàn bộ graph cục bộ thành công, không gọi Wrangler hoặc upload Cloudflare.
- git diff --check sạch.

## Điều kiện phát hành còn thiếu

- Kiểm kê DB staging thật và migration history; xử lý bộ tên migration cũ nếu từng áp trên preview.
- Xác minh secrets/callback/App Review/quyền OA/Page và thử đăng thật được phép; không dùng unit test thay cho nghiệm thu.
- Zalo main hiện lưu access/refresh token trong cột văn bản: cần mã hóa và migration dữ liệu trước khi đánh giá đạt yêu cầu bảo mật lưu trữ; xử lý khóa refresh token một lần, state replay và xác minh OA fail-closed.
- Instagram cần lưu lại container khi processing; Meta cần chống callback/disconnect race. Zalo webhook/inbox chưa được hợp nhất vì chưa có triển khai được kiểm chứng.
- Tài khoản cũ chỉ có social identity cần luồng chuyển đổi email được xác minh, không tự gộp theo tên.
- Bước Cloudflare trước đó bị automatic approval review từ chối. Không push nhánh để kích hoạt gián tiếp Workers Builds khi chưa có xác nhận rõ mã backend và đích Cloudflare. Bản hợp nhất được giữ trong local git.
