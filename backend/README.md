# Backend AI cho ShopAI

## Trạng thái

Mã backend đã được chuẩn bị; chưa chạy build, chưa kiểm thử, chưa triển khai và chưa nối giao diện. Không có endpoint hoạt động được xác nhận. Giao diện hiện tại vẫn giữ nguyên chế độ demo.

## Phương án

Cloudflare Workers chạy API, Workers AI cung cấp mô hình, Cloudflare Access xác thực người dùng. Không cần khóa nhà cung cấp AI trong frontend. Cần tài khoản Cloudflare có Workers AI; kiểm tra hạn mức và chi phí trong tài khoản trước khi bật. Không tự động đăng ký gói trả phí.

## Triển khai

Dùng Node.js bản LTS được Wrangler hỗ trợ, cài Wrangler theo tài liệu Cloudflare rồi đăng nhập bằng `npx wrangler login`. Trong thư mục `backend`, chạy `npx wrangler deploy` sau khi duyệt mã. Cấu hình `workers_dev: false` nên lệnh deploy không tạo hostname `workers.dev` có thể gọi.

Sau khi deploy, trong Cloudflare Workers & Pages, thêm Custom Domain cho Worker hoặc route từ hostname trên zone của bạn tới Worker. Tạo ứng dụng Cloudflare Access bảo vệ chính hostname đó trước khi kiểm thử `/health` hoặc `/ai`; Access chỉ bảo vệ hostname, không tự ánh xạ hostname tới Worker. Không kiểm thử qua hostname khác không được bảo vệ. Không đặt token trong mã hoặc URL.

Tạo ứng dụng tự lưu trữ trong Cloudflare Zero Trust Access bảo vệ hostname backend, với chính sách chỉ cho phép người dùng được chỉ định. Thiết lập biến `ACCESS_TEAM_DOMAIN` là hostname nhóm Access (không có https:// và dấu /), cùng `ACCESS_AUD` là mã audience của ứng dụng Access. Hai giá trị này là cấu hình, không phải khóa AI. Backend từ chối yêu cầu khi chưa cấu hình hoặc JWT không hợp lệ.

Cloudflare Access cần cho phép yêu cầu OPTIONS đi qua để xử lý CORS. Endpoint POST vẫn luôn xác minh chữ ký JWT. Chỉ khai báo nguồn frontend chính xác trong `ALLOWED_ORIGINS`; không dùng ký tự đại diện. Tắt mọi hostname không được bảo vệ; lớp xác minh JWT trong Worker vẫn bắt buộc kể cả truy cập trực tiếp.

## API

`GET /health` trả về trạng thái có đủ binding và biến cấu hình; không chứng minh AI thực sự gọi được.

`POST /ai` nhận JSON có `task` thuộc `generate|improve|adapt|reply` và các trường nội dung liên quan; trả về `{"text":"..."}`. Yêu cầu JWT Cloudflare Access hợp lệ. Giới hạn thân yêu cầu 32 KB, giới hạn theo phiên token 10 yêu cầu/phút. Đây không phải hạn mức thanh toán toàn tài khoản; cần đặt giám sát ngân sách/hạn mức trên Cloudflare.

## Công việc còn lại trước khi dùng thật

Đọc chính xác hàm gọi AI trong `index.html`, đối chiếu toàn bộ payload để tạo ánh xạ prompt phù hợp. Thêm luồng đăng nhập Access và gửi cookie bằng `credentials: 'include'` trong frontend. Do GitHub Pages và hostname Worker khác site, cookie bên thứ ba có thể bị chặn; phương án ưu tiên cho sản xuất là đưa frontend và backend về cùng site trên tên miền người dùng sở hữu. Không chỉ điền endpoint vào giao diện cũ rồi coi là hoàn tất.

Sau khi có quyền hosting, cần build và kiểm thử riêng: JWT thiếu/hết hạn/sai audience, CORS, giới hạn dung lượng/tần suất, lỗi AI, và đủ bốn tác vụ từ giao diện đã xác thực. Chỉ công bố chạy thật sau khi yêu cầu AI thực tế trả về nội dung thành công. Không bật đăng bài, hộp thư hoặc tự trả lời đa kênh trong thay đổi này.
