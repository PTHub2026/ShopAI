# Backend AI cho ShopAI

## Trạng thái

Backend và tích hợp giao diện được phục vụ bởi Worker đã được chuẩn bị; build, kiểm thử và triển khai phải được xác nhận theo môi trường. Tệp gốc `/index.html` trong kho và trên GitHub Pages vẫn là demo với AI nội bộ. Khi build Worker, `backend/build.mjs` đóng gói tệp đó vào Worker; `backend/src/app.js` chuyển HTML cho backend để phục vụ qua hostname cùng origin được bảo vệ bởi Access. Giao diện Worker dùng endpoint `/ai` và không tạo nội dung AI mô phỏng khi yêu cầu thất bại. Các thao tác đăng bài và gửi tin vẫn chỉ mô phỏng. Chưa có endpoint hoạt động hoặc phiên gọi AI thật nào được xác nhận.

## Phương án

Cloudflare Workers chạy API, Workers AI cung cấp mô hình, Cloudflare Access xác thực người dùng. Không cần khóa nhà cung cấp AI trong frontend. Cần tài khoản Cloudflare có Workers AI; kiểm tra hạn mức và chi phí trong tài khoản trước khi bật. Không tự động đăng ký gói trả phí.

## Triển khai

Dùng Node.js bản LTS được Wrangler hỗ trợ, cài Wrangler theo tài liệu Cloudflare rồi đăng nhập bằng `npx wrangler login`. Trong thư mục `backend`, chạy `npx wrangler deploy` sau khi duyệt mã.

`workers_dev` và `preview_urls` đang bật. Trước khi deploy, xác minh Cloudflare Access bảo vệ mọi hostname production và preview đang hoạt động, bao gồm Worker Access / All traffic; không dùng hostname phụ để bỏ qua Access. Thêm Custom Domain hoặc route chỉ khi phương án Worker Access hiện tại cần chúng. Không đặt token trong mã hoặc URL.

`ACCESS_TEAM_DOMAIN` và `ACCESS_AUD` đã được khai báo trong `wrangler.jsonc`; trước mỗi lần deploy, xác minh chúng khớp team domain và audience của ứng dụng Access thực tế. Không coi các giá trị đã cấu hình là placeholder hoặc xóa chúng nếu chưa đối chiếu cấu hình bên ngoài kho. Backend từ chối yêu cầu khi chưa cấu hình hoặc JWT không hợp lệ.

Giao diện do Worker phục vụ gọi API cùng origin và dùng cookie Access; xác nhận luồng đăng nhập và chính sách Access trên hostname đã cấu hình. Bản gốc trên GitHub Pages chưa tích hợp luồng đăng nhập và không nên dùng để gọi backend khác site. Nếu dùng CORS, Access cần cho phép OPTIONS để Worker xử lý preflight; chỉ khai báo nguồn chính xác trong `ALLOWED_ORIGINS`, không dùng ký tự đại diện. API `/ai` luôn xác minh JWT, kể cả khi được gọi trực tiếp.

## API

`GET /health` trả về trạng thái có đủ binding và biến cấu hình; không chứng minh AI thực sự gọi được.

`POST /ai` nhận JSON có `task` thuộc `generate|improve|adapt|reply` và các trường nội dung liên quan; trả về `{"text":"..."}`. Yêu cầu JWT Cloudflare Access hợp lệ. Giới hạn thân yêu cầu 32 KB, giới hạn theo phiên token 10 yêu cầu/phút. Đây không phải hạn mức thanh toán toàn tài khoản; cần đặt giám sát ngân sách/hạn mức trên Cloudflare.

## Công việc còn lại trước khi dùng thật

Trước khi dùng giao diện Worker, cần xác nhận người dùng được chuyển qua đăng nhập Cloudflare Access trên chính hostname và cookie Access được gửi cùng origin. Không dùng luồng giao diện gốc trên GitHub Pages để gọi backend khác site: cookie bên thứ ba có thể bị chặn. Nếu cần GitHub Pages, cần thiết kế và xác nhận riêng luồng đăng nhập Access phù hợp; phương án ưu tiên là đưa frontend và backend về cùng site trên tên miền người dùng sở hữu.

Sau khi có quyền hosting, cần build và kiểm thử riêng: JWT thiếu/hết hạn/sai audience, CORS, giới hạn dung lượng/tần suất, lỗi AI, và đủ bốn tác vụ từ giao diện đã xác thực. Chỉ công bố chạy thật sau khi yêu cầu AI thực tế trả về nội dung thành công. Không bật đăng bài, hộp thư hoặc tự trả lời đa kênh trong thay đổi này.
