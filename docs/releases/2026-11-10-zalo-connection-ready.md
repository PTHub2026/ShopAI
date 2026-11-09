# Zalo OA — luồng kết nối và đăng bài

## Hành vi
- Người dùng đăng nhập Shoppost, chọn đúng shop, bấm kết nối, đăng nhập tài khoản Zalo quản trị OA và cấp quyền. Không có phương thức đăng nhập Shoppost bằng OA.
- Backend tự đổi code, xác minh OA qua API, lưu token mã hóa AES-GCM gắn shop/trường dữ liệu, và làm mới token dưới khóa đồng thời.
- State có thời hạn 10 phút, actor/shop ràng buộc và dùng một lần. Callback không tạo auth session. Không kết nối nếu getOA lỗi hoặc không có OA ID đã xác minh.
- Refresh mất phản hồi hoặc thất bại yêu cầu kết nối lại, không lặp refresh token một lần và không dùng token cũ để báo thành công.
- Dữ liệu token văn bản cũ được nâng cấp khi sử dụng, với điều kiện so sánh bản ghi cũ để không ghi đè phiên đã xoay token.
- Trang Kênh phản ánh cấu hình và quyền kết nối, hướng dẫn trường hợp -14068 và quay về đúng mục Kênh sau cấp quyền.

## Đăng bài
- Dùng POST /v2.0/article/create và POST /v2.0/article/verify theo tài liệu Zalo chính thức được kiểm tra ngày 10/11/2026.
- Bài viết cần ảnh bìa. Ảnh tải từ thiết bị được lưu D1 dưới đường dẫn /media/zalo/<256-bit-random-id> khi người dùng gửi đăng, để Zalo có thể đọc photo_url. Đây là ảnh được đưa vào nội dung công khai, không phải kho tài nguyên riêng tư. Không có API liệt kê công khai; chỉ GET/HEAD ảnh hợp lệ, nosniff và CSP sandbox. Ảnh đã đưa vào bài viết được giữ để bài không hỏng liên kết.
- PUBLIC_ORIGIN production là https://shoppost.net; preview muốn đăng ảnh cần đặt origin trỏ đúng DB/Worker của preview. Không tự dùng URL production cho ảnh preview.
- Chỉ báo đã đăng khi Zalo trả ID bài viết. Nếu không có ID, báo chưa xác nhận và yêu cầu kiểm tra OA trước khi thử lại.
- Giữ cơ chế claim lịch nguyên tử, không tự replay bài processing.

## Thay đổi DB và cấu hình
- Migration 0011 thêm channel_oauth_states, channel_refresh_locks và channel_public_media; runtime cũng tạo các bảng theo cơ chế hiện có. Không xóa dữ liệu/shop/phiên.
- Cần giữ nguyên SOCIAL_TOKEN_KEY; đổi khóa sẽ khiến token mã hóa cũ không đọc được. Không in khóa hoặc token vào log/GitHub.
- ZALO_APP_ID / ZALO_APP_SECRET và callback đã cấu hình trên ứng dụng Shoptrack. Callback: https://shoppost.net/auth/zalo/callback.

## Kiểm chứng
129/129 test và Wrangler dry-run PASS. Các regression gồm: OA info bị từ chối, callback replay/sai actor/hết hạn, token mã hóa/tách shop, refresh đồng thời, refresh mất phản hồi, token cũ, media public và API article đúng phiên bản/thiếu ID.

## Chưa thể nghiệm thu thật
Phiên Zalo hiện tại đã được kiểm tra trên OA Manager và không có OA. Chưa có OAuth thành công hoặc bài thử trên OA thật. Cần tài khoản quản trị OA, quyền Article được duyệt và điều kiện dịch vụ phù hợp. Không hứa chỉ có một tài khoản Zalo bất kỳ là có thể dùng OA.

Nguồn:
https://developers.zalo.me/docs/official-account/noi-dung/noi-dung-dang-bai-viet
https://developers.zalo.me/docs/official-account/noi-dung/noi-dung-dang-bai-viet/kiem-tra-ket-qua-tien-trinh-tao-noi-dung

## Rà soát độc lập trước phát hành
- Đã tái hiện refresh cũ ghi đè token sau khi kết nối OA mới; sửa bằng CAS trên token/identity snapshot cho callback, cập nhật refresh thành công và đánh dấu lỗi refresh. Nếu kết nối đổi, không gửi bằng kết quả cũ.
- Đã tái hiện dữ liệu legacy thiếu OA ID vẫn hiện connected; nay không hiện connected. Token legacy có OA ID chỉ được nâng cấp sau getOA xác minh đúng ID; nếu không phải cấp quyền lại. Không xóa dữ liệu cũ.
- Hai regression đã chạy đỏ trước sửa và xanh sau sửa; full suite 129/129 và dry-run đạt.
