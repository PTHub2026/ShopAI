# Kho bản nháp D1 – phạm vi preview

## Thay đổi tối thiểu

Frontend hiện lưu S.posts trong localStorage/IndexedDB, dùng các trường id, type, content, channels, status, media, assets, custom. Mã trước thay đổi chỉ có AI và health, không có D1 hoặc migration. Bổ sung kho bản nháp văn bản theo đúng phần mô hình này, không thiết kế lại ứng dụng.

GET /storage/drafts trả tối đa 100 bản nháp mới nhất của người dùng hiện tại. PUT /storage/drafts/:id nhận {draft, revision}; bản mới dùng revision=0, cập nhật dùng revision đã đọc. Trùng phiên bản trả 409, không ghi đè mù. Chỉ nhận status=draft, type=post hoặc video, channels là mã kênh. Chưa lưu tệp, assets hoặc custom khác rỗng; trả 422 thay vì mất dữ liệu. Payload được chọn trường rõ ràng, không lưu thông tin OAuth.

JWT được xác minh bằng mã Access hiện hữu trước khi dùng sub làm owner; SQL dùng bind tham số và khóa (owner,id). Ghi chỉ cùng Origin, JSON tối đa 32 KB; không có endpoint công khai bỏ qua JWT. Không có chức năng gửi tin, đăng bài hoặc lịch chạy thật.

## Hạ tầng riêng, không tác động production

Database: shopai-drafts-preview, UUID 543ddfdd-8b74-4a2b-8b41-f9a2c4ba5306. Binding DB chỉ nằm trong previews.d1_databases của wrangler.jsonc; không có binding D1 ở cấp production. Không đổi nhánh production hoặc tự merge PR.

Migration backend/migrations/0001_drafts.sql đã được thực thi qua Console của chính database preview mới tạo; Cloudflare báo truy vấn thành công. Chỉ tạo bảng drafts và index, không INSERT dữ liệu mẫu. Nếu triển khai môi trường khác sau khi duyệt, phải tạo DB riêng và áp dụng chính migration này, không trỏ production vào DB preview.

## Giới hạn và bàn giao

Đây là nền tảng API lưu trữ thực, CHƯA tự đồng bộ frontend. Giao diện và cơ chế lưu cục bộ được giữ nguyên để tránh vô tình đẩy seed/demo, tin nhắn mẫu hoặc trạng thái giả lên máy chủ. Cần bước tích hợp thao tác lưu bản nháp rõ ràng sau khi Access được mở khóa và PR được duyệt; không coi việc tạo schema là đã lưu dữ liệu người dùng từ UI.

Không chạy QA/kiểm thử ứng dụng trong lượt triển khai này. Build/Ready chỉ chứng minh đóng gói và deploy, không chứng minh đọc/ghi qua phiên đăng nhập. Chưa xác minh runtime D1 hoặc AI thật.

Access vẫn đang chặn theo kết quả lượt trước; không thử lại đăng nhập, không tắt Access/JWT. Thao tác cụ thể cần chủ tài khoản: gửi Cloudflare Support yêu cầu sửa ánh xạ ứng dụng Access 8ee4c404-d0e6-42b8-94da-2203ee87f5ad cho hostname feat-same-origin-access-shopai-backend.ct-3f8.workers.dev trong team restless-butterfly-687f.cloudflareaccess.com (cổng nhóm báo không tìm thấy ứng dụng); cung cấp mã yêu cầu hỗ trợ để tiếp tục theo dõi. Không cần gửi OTP hoặc bí mật vào PR.

## Đối soát PR

Nhánh này phát triển từ PR #2 (feat/same-origin-access), không từ PR #1 đang gắn luồng production. PR D1 phải nhắm base feat/same-origin-access để diff chỉ gồm D1 và không lặp toàn bộ thay đổi PR #2.

Giữ kiến trúc đóng gói Text src/app.js của PR #2 và previews binding. Không ghép cơ chế build dist/app.js/node build.mjs hoặc cấu hình preview khác của PR #1. Chưa có sửa nhỏ nào bảo đảm an toàn cho nhánh PR #1 đang tự deploy production; không sửa hoặc merge nhánh đó trong lượt này. Người duyệt cần chọn một hướng tích hợp trước khi merge vào main; không merge tuần tự cả hai như các PR độc lập.
