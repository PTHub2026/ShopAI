# Kho bản nháp D1 – preview

## Cấu hình

Database preview: `shopai-drafts-preview`, UUID `543ddfdd-8b74-4a2b-8b41-f9a2c4ba5306`. Binding `DB` chỉ nằm trong `previews.d1_databases` của `wrangler.jsonc`. Không có D1 ở cấu hình production.

Migration: `backend/migrations/0001_drafts.sql`. Tài liệu trước ghi nhận migration đã được chạy trên DB preview. Lượt này chỉ xác minh migration với SQLite và D1/workerd cục bộ, chưa xác minh lại cloud database. Không tự coi ghi nhận cũ là chứng cứ runtime hiện tại.

## API và giao diện

Giao diện server có nút lưu và mở bản nháp. Không tự upload localStorage, dữ liệu demo, media hoặc thông tin OAuth. Bản nháp văn bản có thể mở trên thiết bị khác sau khi cùng tài khoản Access đăng nhập vào deployment có DB.

- GET `/storage/drafts`: trả `{drafts, nextCursor}`, mặc định 50 mục/trang. Dùng `limit` 1–100 và cursor do server trả về.
- GET `/storage/drafts/:id`: trả `{draft, revision, updatedAt}`.
- PUT `/storage/drafts/:id`: nhận `{draft, revision}`. revision=0 tạo mới, revision đã đọc dùng để cập nhật. Sai revision trả 409; UI giữ bản cục bộ và cho lưu thành bản mới.
- Draft gồm id, type (post/video), content, channels, status=draft, media=[], assets=[], custom={}. Trường chưa hỗ trợ bị từ chối thay vì lặng lẽ bỏ dữ liệu.
- Mỗi query bind owner lấy từ subject JWT hợp lệ. UI gửi `X-ShopAI-User-Scope` để phát hiện thay tài khoản. Ghi chỉ từ cùng Origin, JSON tối đa 32768 byte.

## Kiểm chứng

`npm test` có kiểm thử real SQLite và Miniflare/workerd với D1 cục bộ; không gọi dịch vụ AI hoặc Access thật. Cloudflare runtime cần được kiểm chứng riêng theo [READINESS.md](READINESS.md).

Trước khi deploy preview: xác nhận chính database trên được gắn trong Preview base config/kết quả deploy. `npm run build` là dry-run production nên danh sách binding không có DB là đúng; nó không xác nhận cấu hình preview đã được áp dụng.

Sau khi đăng nhập Cloudflare, có thể dùng `npm exec -- wrangler preview --cwd backend --name <ten-preview> --tag <commit-sha>`. Đây là lệnh tạo preview thật, cần quyền Workers phù hợp. Không dùng `wrangler deploy` thay thế vì sẽ tác động Worker production.

Không tự đổi Access, audience hoặc hostname để vượt lỗi đăng nhập. Nếu Access báo không tìm thấy ứng dụng, chủ tài khoản cần kiểm tra mapping hostname, application audience và chính sách cho phép trong Zero Trust.

## Phạm vi còn thiếu

Chưa lưu ảnh/video, profile, hội thoại, cấu hình hoặc lịch đăng lên server. Chưa có endpoint xóa bản nháp. OAuth/webhook và tích hợp kênh chưa thực hiện. Để production có dữ liệu: tạo DB production riêng rồi migration và kiểm chứng, không dùng chung DB preview.
