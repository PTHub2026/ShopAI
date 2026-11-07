# Hợp đồng API và điều kiện vận hành

## Trạng thái xác nhận

Mã backend và tích hợp giao diện trong bản Worker đã được bổ sung; chưa xác nhận chạy trong Workers hoặc gọi Workers AI thực tế. Không coi tài liệu này là chứng nhận sẵn sàng sản xuất. Tệp gốc `index.html` không đổi: build Worker đóng gói tệp đó để giao diện được Worker phục vụ gọi `POST /ai` cùng origin, không có fallback AI mô phỏng khi lỗi. Đăng bài và gửi tin vẫn mô phỏng. Không tự hợp nhất hoặc triển khai.

## Cấu hình bắt buộc

`wrangler.jsonc` hiện bật `workers_dev` và `preview_urls`; các hostname này là điểm vào dự kiến và không được xem là đường bỏ qua Access. Trước khi triển khai, xác minh Cloudflare Access bảo vệ mọi hostname đang hoạt động ở cả production và preview, bao gồm Worker Access / All traffic. Không yêu cầu route hoặc custom domain nếu phương án Worker Access hiện tại không cần chúng.

`ACCESS_TEAM_DOMAIN` và `ACCESS_AUD` hiện đã được khai báo trong `wrangler.jsonc`. Trước mỗi lần triển khai, xác minh chúng khớp team domain và audience của ứng dụng Access thực tế; không xóa hoặc coi các giá trị đã cấu hình là placeholder. Nếu dùng cấu hình ngoài kho mã, đối chiếu để lần deploy không ghi đè bằng giá trị không hợp lệ.

`ALLOWED_ORIGINS` là danh sách origin chính xác phân tách bằng dấu phẩy; không dùng `*`. Với preview chỉ dùng cùng origin, giá trị rỗng là có chủ ý; Worker vẫn cho phép request cùng origin và yêu cầu JWT hợp lệ. Giao diện do Worker phục vụ gọi API cùng origin và dùng cookie Access; cần xác nhận luồng đăng nhập và chính sách Access trên hostname đã cấu hình. Bản gốc trên GitHub Pages chưa được tích hợp luồng đăng nhập và không nên dùng để gọi backend khác site. Nếu dùng CORS, Access phải cho OPTIONS đi qua để Worker xử lý preflight, còn POST phải có JWT Access hợp lệ. Xác minh Access trên mọi hostname production/preview.

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
