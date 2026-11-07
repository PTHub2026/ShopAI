# Tích hợp frontend và AI cùng origin

## Quyết định triển khai

Nhánh này phát triển từ PR #1, không merge và không thay đổi site GitHub Pages/main. Wrangler dùng src/app.js để đóng gói index.html dạng Text. Lõi src/worker.js vẫn độc lập với trình nạp HTML. GET / và /index.html yêu cầu xác minh JWT Access, chỉ sau đó mới trả HTML có meta shopai-ai-endpoint=/ai. POST /ai giữ nguyên xác thực chữ ký, issuer, audience, thời hạn, hạn mức và giới hạn payload. Không lưu khóa AI hoặc token trong repository.

Frontend ưu tiên endpoint được Worker quản lý, gửi credentials same-origin, timeout 45 giây, không tự theo redirect đăng nhập. Endpoint khác origin bị chặn thay vì dựa vào cookie bên thứ ba. Chỉ generate/improve/adapt/reply đi Workers AI; các tiện ích cục bộ khác được giữ nguyên. Lỗi AI được thông báo rõ khi dùng mẫu nội bộ, không được coi đó là bằng chứng AI thật hoạt động. Khi 401/403 có liên kết đăng nhập lại Access. Bản GitHub Pages không có meta quản lý nên vẫn là giao diện độc lập như trước.

## Cấu hình đã quan sát trên Cloudflare

Worker shopai-backend có Workers AI và AI_RATE_LIMITER; không có D1 binding. Thẻ Access hiển thị Worker Access / All traffic, yêu cầu đăng nhập trên mọi URL production và previews, chính sách chỉ cho ct@pthub.vn. Vì Access gắn trực tiếp Worker, workers.dev không phải hostname bỏ qua chính sách trong cấu hình này. Không tắt Access hoặc JWT. Nếu chuyển sang Access chỉ bảo vệ hostname/custom domain, phải đánh giá lại mọi đường workers.dev và preview, đóng đường phụ hoặc bảo vệ tương đương trước khi triển khai.

## Preview không đụng production

Ưu tiên Worker Previews nguyên bản của Cloudflare, cùng Worker Access hiện hữu. Bật Builds for Preview branches ở Settings > Builds > Previews Base, root backend, lệnh preview npx wrangler preview; không đổi production branch feat/cloudflare-ai-backend hoặc lệnh deploy production. Preview URLs phải bật và toàn bộ preview phải có Access. Chỉ cho phép tạo bằng hạn mức/gói hiện tại, không nâng gói hay mua dịch vụ. URL phải lấy từ build thành công, không tự suy đoán.

Sau khi tạo PR, theo dõi Cloudflare build của chính nhánh feat/same-origin-access, không dùng build thành công của nhánh khác làm bằng chứng. Chỉ promotion sau duyệt PR và kiểm thử riêng. Hoàn tác preview bằng cách ngừng build/xóa preview của nhánh, không rollback production đang phục vụ nhánh khác.

## Thứ tự duyệt và triển khai

Đọc PR #1 cùng PR này. Nhánh này chứa nền tảng PR #1 tại thời điểm tách; nếu PR #1 có commit mới sau đó, cần đồng bộ và duyệt xung đột trước merge. Không merge cả hai mù quáng. Không đổi production branch trong công việc preview.

Trước promotion, người có quyền duyệt xác nhận Worker Access vẫn bảo vệ mọi URL, AUD/domain đúng ứng dụng, hai binding AI và hạn mức hiện hữu, preview build chính xác commit và không có secrets trong diff. Sau đó thực hiện kiểm thử riêng: đăng nhập top-level bằng tài khoản được phép, gọi bốn tác vụ, phiên hết hạn, tài khoản không được phép, hạn mức và lỗi AI. Không dùng phản hồi health configured hoặc nội dung mẫu làm bằng chứng gọi AI thành công. Công việc trình duyệt này chỉ đọc mã/cấu hình và ghi mã/PR/build/deploy, không chạy QA ứng dụng.

## Giới hạn chưa hoàn thành

Chưa có DB server; trạng thái và file vẫn lưu trong trình duyệt. Kết nối kênh, OAuth mạng xã hội, webhook, đăng bài, lên lịch và tin nhắn thật chưa được triển khai trong thay đổi này. Cần thiết kế DB/migration, quản lý token bằng secrets, quyền ứng dụng kênh và kiểm thử riêng trước khi có thể gọi đây là full stack vận hành thực tế.

Nếu cần cấp quyền cho AbacusAI GitHub App, dùng https://github.com/apps/abacusai/installations/select_target và giới hạn repository ShopAI, không cấp toàn bộ repository khi không cần.


## Bàn giao cấu hình và điều phối hai PR

Cập nhật ngày 07/11/2026: đã bật lại Preview URLs trong Worker > Domains; dashboard báo Access áp dụng cho cả production và preview. Worker Access vẫn yêu cầu đăng nhập trên mọi URL, chính sách Allow chỉ ct@pthub.vn. Đã lưu bổ sung chính xác hostname feat-same-origin-access-shopai-backend.ct-3f8.workers.dev vào cùng ứng dụng Access hiện hữu; dashboard xác nhận Application successfully configured. Không thay AUD, không mở rộng danh sách người được phép và không tắt JWT.

Bản mã tích hợp đã có deployment Ready phiên bản 788c3749, commit 9ad040cb3faee397b9c741cc9621169ff9088e23. Tuy nhiên, việc truy cập để đến cổng đăng nhập vẫn bị chặn: hostname preview trả thông báo cần đăng nhập; /cdn-cgi/access/login trả 404; cổng nhóm Access báo không tìm thấy ứng dụng. Đây chưa phải preview dùng được. Việc lưu hostname chưa đủ chứng minh Access đã thực thi đúng trên preview. Không gọi AI hoặc chạy QA ứng dụng để suy diễn trạng thái.

PR #1 đã thay đổi sau khi tách nhánh: có app.js tải HTML từ GitHub và thay chuỗi lúc chạy; PR #2 dùng HTML đóng gói trong bundle. Hai cách triển khai không được ghép tự động. Khuyến nghị duyệt PR #2 làm phương án tích hợp cùng origin; PR #1 chỉ dùng làm nguồn đối chiếu các sửa lỗi backend/CI độc lập. Trước merge, người duyệt phải đối chiếu worker.js, hợp đồng frontend và bộ kiểm thử; không chép đè app.js hoặc Wrangler từ PR #1 sang PR #2. Chưa đồng bộ toàn bộ các commit phát sinh của PR #1.

Production hiện được build từ nhánh PR #1; một lần deploy nhánh đó với preview_urls:false có thể ghi đè việc bật Preview URLs trong dashboard. Để tránh triển khai production ngoài phạm vi được duyệt, lượt này không sửa nhánh PR #1, không đổi production branch và không tắt build production. Người vận hành cần thống nhất preview_urls và khối previews giữa cấu hình sẽ được duyệt với dashboard trước khi promote. Không bật/tắt lặp lại khi có build khác đang chạy.

Nếu Access vẫn không nhận hostname preview sau khi cấu hình đã lưu, kiểm tra ứng dụng Access gắn Worker, phạm vi preview và khả năng hỗ trợ hostname preview trong tài khoản; liên hệ Cloudflare nếu cần. Chỉ dùng hostname cùng origin đã được Access bảo vệ thực sự. Không lấy JWT thủ công, không dùng service token trong frontend, không bỏ xác minh JWT để né lỗi đăng nhập. Chưa cấp hostname tên miền riêng vì chưa có lựa chọn tên miền được duyệt.

Điều kiện bàn giao tiếp theo: cổng Access phải mở trang đăng nhập hợp lệ; chủ tài khoản tự xác thực khi được yêu cầu; một lượt kiểm thử riêng ngoài công cụ trình duyệt này xác nhận phiên, /ai và hạn mức. Sau đó duyệt PR cụ thể rồi mới promote. D1/DB và OAuth/webhook/kênh đăng bài, lên lịch, tin nhắn thật vẫn chưa được triển khai; không coi bản này là full stack vận hành.
