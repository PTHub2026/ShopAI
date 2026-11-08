# Bật OAuth Facebook sau khi cấu hình được duyệt

## Phạm vi hiện tại

Chỉ kết nối OAuth và danh sách Facebook Pages được Meta xác nhận. Chưa có đăng bài, lịch đăng, webhook hoặc đọc/gửi Messenger. Token mã hóa trên server; không dùng localStorage để lưu token. Kết nối chưa được nghiệm thu cloud.

App hiện có: https://developers.facebook.com/apps/1690219679401963/dashboard/

## Cấu hình cần thiết

1. Áp dụng `migrations/0002_facebook.sql` vào DB của đúng môi trường. Preview dùng DB preview, production dùng DB production.
2. Trong Cloudflare Secrets của **đúng môi trường**, đặt `FACEBOOK_APP_SECRET` và `CHANNEL_TOKEN_KEY` (32 byte ngẫu nhiên, base64 chuẩn). Không dán vào chat, source hoặc build vars. Không thay khóa mã hóa khi còn token đang dùng; phải có kế hoạch chuyển khóa/reconnect.
3. Variables: `FACEBOOK_APP_ID=1690219679401963`, `APP_ORIGIN` là origin HTTPS của đúng preview/production, không slash cuối. Chỉ bật `FACEBOOK_OAUTH_ENABLED=true` sau khi hoàn thành các bước còn lại. Nếu app yêu cầu Login for Business configuration, đặt `FACEBOOK_CONFIG_ID` tương ứng và `FACEBOOK_CONFIG_SCOPES=pages_show_list` sau khi kiểm tra cấu hình trên Meta chỉ yêu cầu quyền này; không đoán ID hoặc tự xác nhận phạm vi. Nếu cấu hình có thêm quyền, tạo/duyệt cấu hình tối thiểu riêng trước.
4. Callback production: `https://shopai-backend.ct-3f8.workers.dev/channels/facebook/callback`. Preview có callback riêng đúng hostname. Cấu hình Valid OAuth Redirect URI trong Meta. Giữ Cloudflare Access bảo vệ callback và toàn bộ ứng dụng; callback trình duyệt tiếp tục dùng phiên Access.
5. Bước OAuth hiện tại chỉ yêu cầu `pages_show_list`, quyền đã sẵn sàng thử nghiệm trên ứng dụng. Các quyền đăng bài, tương tác, webhook và Messenger sẽ yêu cầu khi các chức năng tương ứng đã được triển khai, kiểm thử và duyệt. Không yêu cầu email, business_management, quảng cáo hoặc quyền xóa nội dung người dùng. Chế độ phát triển chỉ nghiệm thu với tài khoản/Trang có vai trò phù hợp.
6. Chủ Trang kiểm tra và duyệt quyền trong màn hình Meta. Đây là bước cấp quyền truy cập dữ liệu thật; không tự chấp thuận thay người dùng. Chưa phát hành ứng dụng công khai.

## Nghiệm thu

- Mở Kênh trong ứng dụng sau đăng nhập, bấm “Tiếp tục đến Meta”; hủy thử một lần, rồi kết nối Trang thử đã được chủ tài khoản chọn.
- Kiểm tra Page ID/tên trả về; token không nằm trong HTML, response API, URL frontend hoặc localStorage.
- Callback sai/hết hạn/dùng lại không được chấp nhận; khác tài khoản không đọc danh sách Trang của nhau.
- Khi token/quyền bị từ chối, không ghi trạng thái kết nối thành công. Token Page có thể hết hạn hoặc bị thu hồi; trạng thái UI chỉ xác nhận OAuth tại lần kết nối, chưa phải giám sát sống liên tục.
- Endpoint POST `/channels/facebook/:pageId/disconnect` chỉ bỏ token/liên kết tại ShopAI, không thu hồi quyền của Meta và không xóa lịch sử trên Meta. Có thể kết nối lại.

## Các bước tiếp theo của mục 4

Sau khi OAuth được kiểm chứng mới triển khai theo quyền đã cấp:
- Adapter đăng bài văn bản với kết quả Page Post ID thật, xử lý kết quả chưa rõ để tránh đăng trùng.
- Lịch đăng lưu máy chủ/được Meta xác nhận; không dùng đồng hồ trình duyệt.
- Webhook receiver riêng xác minh chữ ký raw-body, chống sự kiện trùng, không bỏ Access của ứng dụng để nhận webhook.
- Hội thoại theo owner/Page, xác minh thời hạn phản hồi, gửi tin có ID thật và lịch sử lỗi.
- Kiểm chứng với Trang thử, nội dung và người nhận được chỉ định trước; không tự đăng bài hoặc nhắn khách trong lúc thiết lập.
- Sau Facebook/Messenger, triển khai từng adapter còn lại theo quyền thực tế; không gộp trạng thái “đã kết nối” của các nền tảng khác.

## Tồn đọng giao diện và kiểm thử (chưa chặn bản tắt mặc định)

- API ngắt liên kết đã có, chưa có nút ngắt trong UI.
- UI chưa hiển thị riêng kết quả callback hủy/không có Trang; danh sách tải lại từ máy chủ vẫn là nguồn trạng thái.
- Chưa có regression cho rollback D1 batch, Graph lỗi ở trang sau, cursor lặp/hỏng, cờ bật bị thiếu, token/data-access expiry bất thường và đổi màn hình khi OAuth-start đang chờ. Cần bổ sung trước nghiệm thu bật cho người dùng rộng rãi.
