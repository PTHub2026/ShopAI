# Trạng thái kiểm chứng – 08/11/2026

## Kết luận

Mã hiện có hỗ trợ AI qua Workers AI và thao tác lưu/mở bản nháp văn bản qua D1. Chưa xác nhận bản này đã chạy trên Cloudflare thật. Không coi unit test, Workers cục bộ hoặc dry-run là bằng chứng đã triển khai.

## Đã kiểm chứng trong môi trường phát triển

- Bộ kiểm thử chạy bằng `npm test`: xác thực JWT, CORS, giới hạn UTF-8, đủ bốn tác vụ AI qua binding thay thế trong test, lỗi AI và bảo toàn bản nháp.
- SQLite thật kiểm tra SQL/schema, tách owner, revision và lỗi 409, đọc theo mã, phân trang có timestamp trùng nhau, dữ liệu không hợp lệ.
- jsdom chạy toàn bộ HTML: lưu/mở rõ ràng; không tự upload; lỗi phiên/HTML/DB không xác nhận lưu; kết quả chậm không ghi đè bản đang sửa; xung đột cho phép lưu thành bản mới; không mất type video.
- Miniflare/workerd chạy chính Worker, JWT RS256 được ký cho kiểm thử và D1 cục bộ thật: trang không JWT trả 401; JWT hợp lệ mở trang; PUT lưu được, GET đọc lại, ghi revision cũ trả 409 và tài khoản khác không đọc được. Khóa JWKS được cung cấp bởi fixture cục bộ; không gọi Access hoặc Workers AI thật trong test này.
- Phát hiện và sửa lỗi chỉ thấy trên Workers: fetch JWKS dùng `redirect: 'error'` gây TypeError và luôn từ chối JWT. Đổi sang `manual`, vẫn từ chối phản hồi chuyển hướng qua kiểm tra `response.ok`.
- Trang được bảo vệ gắn phạm vi tài khoản SHA-256. localStorage, IndexedDB, nháp và dự án video tách theo phạm vi; không tự đọc lại cache demo cũ.
- Bản server khởi tạo rỗng; các entry point mô phỏng đăng bài, lịch trình duyệt, kết nối kênh, tin nhắn, chỉ số ngẫu nhiên và nhập dữ liệu mẫu bị chặn. Bản HTML offline vẫn là demo.
- CI dùng Node.js 24, `npm ci`, bộ phụ thuộc khóa trong package-lock và build Wrangler dry-run. CI chạy trên PR, nhánh fix và main.
- Build nhúng SHA commit. `/health.release` và `/session.release` cho phép đối chiếu mã đóng gói; `/session.version` có ID phiên bản Cloudflare khi binding khả dụng. Health chỉ xác nhận cấu hình, không chứng minh AI hoặc SQL đã chạy thành công.

## Hợp đồng lưu bản nháp

- `GET /session`: cần JWT hợp lệ, trả `userScope`, các khả năng được cấu hình và mã phát hành. `capabilities.drafts=true` chỉ nghĩa là có binding DB.
- `GET /storage/drafts?limit=50&cursor=...`: tối đa 100 mục/trang, trả `{ drafts, nextCursor }` theo tài khoản.
- `GET /storage/drafts/:id`: đọc nội dung và revision hiện tại.
- `PUT /storage/drafts/:id`: `{ draft, revision }`; bản mới revision=0, cập nhật dùng revision đã đọc. Giới hạn 32 KB; nội dung tối đa 20.000 ký tự. Chỉ bản nháp văn bản, chưa có media/assets/custom/lịch đăng.
- Giao diện gửi `X-ShopAI-User-Scope`; backend từ chối nếu tài khoản Access đã đổi giữa lúc mở trang và gọi API. Subject owner luôn lấy từ JWT đã kiểm chứng, không từ body/header này.
- Không có endpoint xóa trong phạm vi thay đổi này. Các bản nháp cũ vẫn tồn tại khi lưu thành bản mới.

## Chưa xác minh hoặc chưa triển khai

1. Phiên Cloudflare trong lượt này đang ở trang đăng nhập. Chưa tạo deployment, chưa xác nhận mapping Access hiện tại đã hoạt động, chưa thử Workers AI thật hoặc D1 từ UI trên Cloudflare.
2. Binding D1 chỉ có trong cấu hình `previews`, không có DB production. Không trỏ production vào database preview.
3. Hồ sơ, cài đặt, kho ảnh/video, hội thoại và tệp gốc vẫn lưu tại thiết bị. Chỉ bản nháp văn bản được người dùng lưu rõ ràng có luồng máy chủ; không phải đồng bộ toàn bộ ứng dụng.
4. OAuth, webhook, đăng bài, lịch đăng server, nhập hộp thư và gửi tin thật của các kênh chưa có. Trên bản server các thao tác mô phỏng bị chặn; chưa thể gọi đây là sản phẩm đa kênh hoàn chỉnh.
5. Không có migration mới so với bảng `drafts` hiện tại. Cần xác minh migration 0001 đã hiện diện trong chính DB preview được gắn khi phát hành.

## Cổng phát hành

1. `npm ci` rồi `npm run check` trên commit sẽ phát hành. Kết quả cụ thể được ghi trong `backend/VERIFICATION.md`.
2. Sau khi có phiên Cloudflare hợp lệ, triển khai preview bằng cấu hình và database preview đã xác nhận; không đổi production để xử lý lỗi preview.
3. Đối chiếu `/health.release` với commit PR/deployment; đăng nhập Access vào đúng hostname. Kiểm tra thiếu JWT và phiên hết hạn vẫn bị từ chối.
4. Thử generate, improve, adapt, reply bằng nội dung thử nghiệm không có dữ liệu khách hàng; kiểm tra lỗi mạng và bảo toàn nháp.
5. Lưu/mở một bản nháp từ hai thiết bị hoặc hai tab; kiểm tra xung đột, refresh và tài khoản khác không thấy bản nháp đó. Không seed demo vào server.
6. Muốn production có lưu trữ: tạo DB production riêng, áp dụng migration, gắn đúng binding, xác nhận Access và kiểm chứng trước khi promote. Các tích hợp kênh cần tài khoản ứng dụng và quyền đã được cấp riêng.
