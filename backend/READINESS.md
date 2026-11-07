# Trạng thái kiểm chứng ngày 08/11/2026

Bản sửa phát triển từ `feat/same-origin-access` (PR #2), không từ nhánh backend có cách chèn HTML bằng thay chuỗi. Cấu hình Wrangler đóng gói HTML trực tiếp, giữ xác thực Access ở cả trang và API.

## Đã kiểm tra

- `node --test backend/test/*.test.mjs`: 16 kiểm thử đạt tại thời điểm bản sửa đầu tiên; chạy lại để lấy số lượng mới nhất.
- `npx --yes wrangler@4 deploy --dry-run`: đóng gói thành công; đây không phải triển khai hoặc xác nhận gọi Workers AI thật.
- Lỗi HTTP, trang đăng nhập HTML và phản hồi AI rỗng không chuyển sang mẫu nội bộ khi endpoint AI đã cấu hình.
- QA demo dùng mẫu riêng, không gọi AI thật.
- Cải thiện nội dung giữ bản nháp khi lỗi và không ghi đè bản nháp đã thay đổi trong lúc chờ.
- Các đầu vào AI được kiểm tra theo tác vụ: generate cần topic/brief/product/text; improve/adapt cần text; reply cần text/message. Tên thương hiệu không thay thế nội dung.
- CI chạy cả kiểm thử frontend và backend.

## Chưa xác minh hoặc chưa triển khai

- Bản Cloudflare đang chạy và cuộc gọi Workers AI thật: phiên điều khiển trình duyệt trả HTTP 401; chưa thể kiểm tra giao diện và deployment bằng phiên đó.
- Chưa có cơ sở dữ liệu server hoặc đồng bộ nhiều thiết bị. IndexedDB/localStorage vẫn là nơi lưu dữ liệu.
- OAuth, webhook, đăng bài, lịch đăng server và gửi tin đa kênh chưa triển khai. Các thao tác tương ứng hiện vẫn là mô phỏng.
- Không dùng việc vượt qua unit test hoặc build thử làm bằng chứng cho các tích hợp trên.

## Tiếp tục vận hành

1. Xác minh preview đúng commit qua Cloudflare Access và thử bốn tác vụ AI bằng nội dung thử nghiệm, không chứa dữ liệu khách hàng.
2. Kiểm tra lỗi phiên hết hạn, mất mạng, chuyển màn hình khi đang tạo nội dung, và bảo toàn bản nháp.
3. Đối chiếu deployment/commit trước khi promote. Không ghi đè production bằng nhánh khác chỉ vì build thành công.
4. Bổ sung cơ sở dữ liệu, tài khoản ứng dụng nền tảng, quyền OAuth và webhook được xác nhận trước khi bật các chức năng đa kênh thật.
