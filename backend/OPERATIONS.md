# Hợp đồng API và điều kiện vận hành

## Trạng thái xác nhận

Đã bổ sung mã xử lý backend vào PR. Chưa chạy build hoặc bộ kiểm thử tự động; chưa xác nhận chạy trong Workers và chưa gọi Workers AI thực tế. Không coi tài liệu này là chứng nhận sẵn sàng sản xuất. Frontend không thay đổi. Không tự hợp nhất hoặc triển khai.

## Cấu hình bắt buộc

`wrangler.jsonc` hiện tắt cả `workers_dev` và `preview_urls`. Trước khi triển khai, người vận hành phải khai báo route hoặc custom domain thực tế thuộc tài khoản của mình và bảo vệ hostname bằng Cloudflare Access. Không tự bật lại hostname công khai để bỏ qua bước này.

Điền `ACCESS_TEAM_DOMAIN` bằng hostname dạng `ten-nhom.cloudflareaccess.com` (không chứa giao thức hoặc đường dẫn) và `ACCESS_AUD` bằng audience thực tế. Giá trị trống là chủ ý: backend trả 503 thay vì bỏ qua xác thực. Không dùng các ví dụ làm cấu hình thật. Nếu dùng cấu hình ngoài kho mã, đối chiếu để lần deploy không ghi đè bằng giá trị trống.

`ALLOWED_ORIGINS` là danh sách origin chính xác phân tách bằng dấu phẩy; không dùng `*`. Access phải cho OPTIONS đi qua để Worker xử lý preflight, còn POST phải có JWT Access hợp lệ. Cookie Access trên trình duyệt cần luồng đăng nhập phù hợp; ưu tiên frontend và backend cùng site. Việc tích hợp này nằm ngoài phạm vi backend.

Binding `AI` và `AI_RATE_LIMITER` phải có mặt. Giới hạn cấu hình là 10 yêu cầu/phút theo phiên JWT; đây là giới hạn cục bộ của cơ chế Cloudflare, không phải trần chi phí toàn cục hoặc theo người dùng. Token được băm trước khi dùng làm khóa giới hạn; không ghi JWT vào log. Cần thiết lập giám sát ngân sách riêng trước khi dùng thật.

## Giao thức

`GET /health` trả `{"service":"shopai","configured":true}` với 200 khi có cấu hình hợp lệ theo kiểm tra cục bộ; thiếu cấu hình trả 503. Endpoint này không gọi AI, không xác nhận audience có tồn tại hoặc Access đã được thiết lập đúng.

`POST /ai` yêu cầu `Content-Type: application/json`, JWT Access do Access chuyển vào header `Cf-Access-Jwt-Assertion`, thân UTF-8 tối đa 32768 byte và một đối tượng JSON. `task` phải là `generate`, `improve`, `adapt` hoặc `reply`. Ngoài `task`, cần ít nhất một trường chuỗi không rỗng chứa nội dung. Các trường bổ sung được đưa vào dữ liệu tham khảo cho mô hình; đây chưa phải ánh xạ payload frontend.

Ví dụ tạo nội dung: `{"task":"generate","brief":"Viết giới thiệu sản phẩm từ dữ kiện được cung cấp","product":"Tên sản phẩm và đặc điểm thực tế"}`.

Ví dụ cải thiện: `{"task":"improve","text":"Nội dung cần cải thiện"}`.

Ví dụ điều chỉnh kênh: `{"task":"adapt","text":"Nội dung gốc","channel":"Facebook"}`.

Ví dụ soạn trả lời: `{"task":"reply","message":"Tin nhắn cần trả lời","context":"Thông tin đã được xác nhận"}`.

Thành công trả `{"text":"..."}`; lỗi trả `{"error":"..."}`. Mã lỗi: 400 cho JSON/payload sai, 401 cho JWT thiếu hoặc không xác minh được (kể cả khi không lấy được khóa xác minh), 403 cho origin/preflight không được phép, 404 cho đường dẫn không tồn tại, 405 cho phương thức không hỗ trợ kèm Allow, 413 cho thân quá lớn, 415 cho kiểu nội dung sai, 429 kèm Retry-After khi vượt giới hạn, 502 cho lỗi hoặc nội dung AI không hợp lệ, 503 cho cấu hình hoặc dịch vụ giới hạn chưa khả dụng. Phản hồi không tiết lộ chi tiết lỗi nội bộ.

## Cổng kiểm tra trước sản xuất

Cần chạy build bằng Wrangler tương thích và kiểm thử riêng các trường hợp: JWT đúng chữ ký; thiếu JWT; JWT sai chữ ký, sai issuer/audience, hết hạn hoặc nbf không hợp lệ; endpoint/phương thức sai; origin hợp lệ và không hợp lệ; preflight sai method/header; JSON lỗi, mảng và nội dung rỗng; biên 32768 byte và vượt biên; hết hạn mức; binding giới hạn lỗi; AI lỗi hoặc phản hồi rỗng; đủ bốn tác vụ trả nội dung thành công. Kiểm tra hostname phụ không thể vượt bảo vệ Access.

Chỉ xác nhận vận hành sau khi có bằng chứng chạy thật. Không bật đăng bài, gửi tin hoặc tự trả lời đa kênh trong thay đổi này.
