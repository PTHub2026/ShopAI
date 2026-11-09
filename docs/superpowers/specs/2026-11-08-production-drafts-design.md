# ShopAI: bản nháp máy chủ và trạng thái vận hành

Mục tiêu: tiếp tục backend Cloudflare hiện có để người dùng đã xác thực có thể lưu và mở bản nháp văn bản từ nhiều thiết bị, không nhầm dữ liệu demo với kết quả thật.

Quyết định triển khai của Codex trong phạm vi yêu cầu tự chủ: giữ Worker, D1 và giao diện hiện tại. Không xây lại bằng nền tảng khác. Chưa có phiên Cloudflare đăng nhập hoặc tài khoản OAuth các kênh; hoàn thiện mã và PR trước, ghi rõ điều kiện phát hành.

## Phương án

1. Tiếp tục localStorage: ít thay đổi nhưng không đáp ứng nhiều thiết bị.
2. Nối API D1 hiện có vào thao tác lưu/mở rõ ràng: chọn phương án này, giữ bản cục bộ, chống ghi đè bằng revision.
3. Viết lại ứng dụng và backend: tăng phạm vi và rủi ro di chuyển không cần thiết.

## Hợp đồng

- Access JWT vẫn phải được xác minh chữ ký, issuer, audience, exp và subject. Không bỏ bảo vệ để deploy.
- Trang server có mã phạm vi tài khoản băm SHA-256; localStorage, IndexedDB và bản nháp cục bộ tách theo phạm vi này.
- Bản server khởi tạo dữ liệu rỗng, không seed bài đã đăng, chỉ số, khách hàng hoặc kết nối giả.
- GET /session trả khả năng được cấu hình, không khẳng định tích hợp đã kiểm chứng. Có DB mới hiển thị khả năng lưu trữ.
- GET /storage/drafts và GET /storage/drafts/:id chỉ trả dữ liệu của subject đã xác thực. Danh sách phân trang 50 mục, cursor theo updated_at và id.
- PUT giữ hợp đồng revision, JSON tối đa 32768 byte; lỗi 409 không ghi đè. Từ chối media/assets/custom chưa hỗ trợ và mọi trường ngoài hợp đồng có thể gây mất dữ liệu.
- Giao diện chỉ gọi lưu trữ theo thao tác người dùng; QA không gọi mạng. Không tự tải dữ liệu demo lên server.
- Lưu thành công chỉ sau phản hồi hợp lệ; lỗi mạng/phiên/DB không làm mất bản nháp. Kết quả chậm không ghi đè thay đổi mới hoặc màn hình khác.
- Bản server chặn đăng bài, lập lịch, gửi tin, kết nối giả và chỉ số ngẫu nhiên; demo offline tiếp tục dùng để thử giao diện.
- CI kiểm thử backend/frontend/SQLite và đóng gói bằng Wrangler được khóa phiên bản; không tự deploy production khi chưa chứng minh cấu hình và migration.

## Điều kiện phát hành

Chạy suite và build; review thay đổi; xác minh preview đúng commit qua Access; kiểm thử bốn tác vụ Workers AI và đọc/ghi/xung đột D1 với tài khoản thật. OAuth, webhook, lịch server, kho tệp và gửi tin thật còn cần tài khoản và tích hợp riêng, không đánh dấu hoàn thành bằng unit test.
