# Trạng thái kiểm chứng – 08/11/2026

## Kết luận

Production đã được kiểm chứng trực tiếp ngày 08/11/2026: AI tạo nội dung thật và bản nháp văn bản lưu/mở qua D1. Bản phát hành `aac8980750d2962a6b39bd947e857356d5f383ce`, Cloudflare version `5a2507c2-5aea-409f-988a-2232220c39c6`. Production build theo nhánh `main`, PR #6 đã merge. Chưa phải sản phẩm đa kênh hoàn chỉnh: đăng bài, lịch đăng và hộp thư thật chưa bật.

Ứng dụng thật: https://shopai-backend.ct-3f8.workers.dev/ (yêu cầu Cloudflare Access). GitHub Pages vẫn là bản demo và có liên kết sang ứng dụng thật.

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

## Đã kiểm chứng trên cloud

- Preview: generate, improve, adapt và reply trả nội dung Workers AI thật. Đã thay model nghỉ cung cấp bằng `@cf/google/gemma-4-26b-a4b-it`, tắt thinking để giữ ngân sách đầu ra cho nội dung, chỉ nhận kết quả hoàn chỉnh.
- Production: `/session.release` đúng commit phát hành; generate trả đủ ba phương án. CI GitHub và Cloudflare build đều thành công.
- D1 production `shopai-drafts-production` tách khỏi preview. Schema `0001_drafts.sql` được áp dụng; lưu bản nháp kiểm thử `d_rjs4ak2c`, revision 1, đọc qua API và mở từ tab thứ hai thành công. Không dùng dữ liệu khách hàng.
- Xung đột revision và phân quyền chéo tài khoản được kiểm thử bằng SQLite/workerd cục bộ; chưa có hai tài khoản cloud để chứng minh phân quyền bằng E2E cloud.

## Chưa xác minh hoặc chưa triển khai

1. Hồ sơ, cài đặt, kho ảnh/video, hội thoại và tệp gốc vẫn ở thiết bị; chỉ bản nháp văn bản được lưu rõ ràng lên máy chủ.
2. Lịch sử adapter `facebook.js`: OAuth **tắt mặc định**. Chưa có grant/token cloud tại mốc này. Kết nối Meta thật chưa được kiểm chứng. `FACEBOOK_SETUP.md` lưu hướng dẫn cũ. Luồng hiện hành dùng `social.js`/`meta.js`. Xem cấu hình và nghiệm thu tại [META_STAGING.md](META_STAGING.md).
3. App Meta ShopAI `1690219679401963` có Pages và Messenger, chế độ phát triển. Quan sát console: `pages_show_list` và `pages_manage_metadata` sẵn sàng thử nghiệm; `pages_manage_posts` và `pages_read_engagement` chưa thêm. Chưa xác minh quyền Messenger đầy đủ.
4. Webhook, đăng bài, lịch đăng server, nhập hộp thư và gửi tin thật chưa triển khai. Không mở các thao tác mô phỏng trên server. Các adapter còn lại chưa có.
5. Điều kiện lịch sử của adapter `facebook.js`: áp dụng migration `0002_facebook.sql` trước khi bật OAuth. App Secret chưa được thiết lập tại mốc này. Khóa mã hóa, origin callback và config Login for Business cũng chưa được thiết lập. Luồng hiện hành dùng checklist tại [META_STAGING.md](META_STAGING.md). Tài liệu đó quy định migration, bảng dữ liệu, khóa `SOCIAL_TOKEN_KEY` và callback `META_REDIRECT_URI`. Không đưa bí mật vào GitHub.

## Cổng phát hành

1. `npm ci` rồi `npm run check` trên commit sẽ phát hành. Kết quả cụ thể được ghi trong `backend/VERIFICATION.md`.
2. Sau khi có phiên Cloudflare hợp lệ, triển khai preview bằng cấu hình và database preview đã xác nhận; không đổi production để xử lý lỗi preview.
3. Đối chiếu `/health.release` với commit PR/deployment; đăng nhập Access vào đúng hostname. Kiểm tra thiếu JWT và phiên hết hạn vẫn bị từ chối.
4. Thử generate, improve, adapt, reply bằng nội dung thử nghiệm không có dữ liệu khách hàng; kiểm tra lỗi mạng và bảo toàn nháp.
5. Lưu/mở một bản nháp từ hai thiết bị hoặc hai tab; kiểm tra xung đột, refresh và tài khoản khác không thấy bản nháp đó. Không seed demo vào server.
6. Muốn production có lưu trữ: tạo DB production riêng, áp dụng migration, gắn đúng binding, xác nhận Access và kiểm chứng trước khi promote. Các tích hợp kênh cần tài khoản ứng dụng và quyền đã được cấp riêng.
