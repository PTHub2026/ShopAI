# Bằng chứng kiểm chứng ngày 08/11/2026

Nguồn bắt đầu: `main` tại `7ef009b3f285a9febe863aeca1eedd0d9e816543`.

## Môi trường và lệnh

- Node.js `v24.22.1`.
- Wrangler `4.158.0`, jsdom `26.1.0`, Miniflare `5.20261104.0-beta`, esbuild `0.28.2`; khóa đầy đủ trong package-lock.
- `npm test`: **41 kiểm thử đạt, 0 lỗi, 0 bỏ qua** ở thời điểm ghi nhận trước review.
- `CI=true WRANGLER_SEND_METRICS=false npm run check`: **exit 0**; chạy cả suite 41 kiểm thử và Wrangler dry-run.
- Dry-run: **277.90 KiB**, gzip **82.98 KiB**; binding AI, rate limiter và metadata phiên bản được nhận. Đây là cấu hình production nên không có DB; không xác nhận binding preview bằng kết quả này.
- `git diff --check`: đạt.

## Chứng cứ quan trọng

1. Bộ test Node ban đầu: 21/21 đạt. Test mới đã tái hiện lỗi thiếu đọc một bản nháp, thiếu phân trang, chấp nhận payload không hỗ trợ và thiếu session/account scope trước khi sửa.
2. Test jsdom tải toàn bộ HTML đã thất bại khi chưa có lưu/mở máy chủ và khi bản server còn khởi tạo seed/kết nối mô phỏng. Sau triển khai, kiểm thử lưu/mở, revision, lỗi, bảo toàn nháp và guard đạt.
3. Test trên workerd thực ban đầu trả 401 với JWT hợp lệ. Chẩn đoán tại boundary JWKS cho thấy TypeError vì Workers không hỗ trợ fetch redirect=error. Đổi sang manual, test đạt: JWT hợp lệ mở trang, lưu D1, đọc lại, stale revision trả 409, owner khác không thấy dữ liệu.
4. Test đóng gói commit thất bại trước khi bổ sung release metadata. Sau sửa, `/health.release` trả SHA 40 ký tự của mã đã đóng gói.

## Giới hạn bằng chứng

- AI và endpoint JWKS trong test là fixture kiểm soát, không chứng minh Workers AI hoặc Cloudflare Access của tài khoản thật đã chạy.
- SQLite và D1/workerd đều cục bộ, không xác nhận migration/binding cloud.
- jsdom kiểm tra DOM và hành vi, chưa phải đánh giá ảnh chụp giao diện hoặc kiểm thử trên điện thoại thật.
- Phiên Cloudflare hiện cần đăng nhập. Chưa deploy, chưa promote production và chưa chạy kiểm thử trên dữ liệu khách hàng thật trong lượt này.

Nếu review phát hiện và sửa lỗi bổ sung, số ca kiểm thử cuối cùng và trạng thái CI được ghi trong phần bổ sung phía dưới.

## Sau rà soát độc lập

Reviewer phát hiện một lỗi Important: cache tên/email gửi góp ý chưa tách tài khoản; đã thêm hồi quy tái hiện và tách cache, đồng thời QA không ghi đè danh tính đã lưu. Một lỗi trình bày phản hồi chậm cũng được tái hiện và sửa: danh sách không tự mở lại sau khi đóng hoặc đổi trang.

- `npm ci`: cài lại đúng lock thành công.
- `CI=true WRANGLER_SEND_METRICS=false npm run check`: **43/43 kiểm thử đạt, 0 lỗi/bỏ qua**, build exit 0; **278.24 KiB**, gzip **83.10 KiB**.
- `git diff --check`: đạt.
- Chưa kiểm chứng Cloudflare runtime; giữ nguyên điều kiện phát hành trong READINESS.md.


## Kiểm tra GitHub và Cloudflare Preview

- PR #6: https://github.com/PTHub2026/ShopAI/pull/6.
- Commit đầu của PR: `fe7ff8076243bffbafe843867d520e013fcaecdb`; GitHub Actions push và pull_request đều thành công.
- Cloudflare Workers Builds xác nhận build và deployment preview thành công (deployment `1b3fb71b-5122-45e9-9577-70e2fe7c6e3c`, lúc 04:59 UTC / 11:59 giờ Việt Nam ngày 08/11/2026). Nguồn: bình luận cloudflare-workers-and-pages[bot] trong PR.
- Preview: https://fix-verified-cloud-drafts-20261108-shopai-backend.ct-3f8.workers.dev. Khi mở bằng trình duyệt điều khiển, Access hiển thị ứng dụng “ShopAI — chỉ chủ tài khoản” và phương thức đăng nhập Cloudflare; chưa có phiên ứng dụng hợp lệ để thử AI/D1.
- Review Copilot chỉ ra phản hồi đọc một bản nháp vẫn có thể thay nội dung sau khi đóng picker hoặc rời/quay lại trang. Đã tái hiện RED, bổ sung kiểm tra thế hệ modal/view, kiểm tra lại ở callback xác nhận.
- Sau sửa bổ sung: `npm run check` đạt 45/45 kiểm thử và Wrangler dry-run. Không promote production; cần kiểm chứng preview sau xác thực.


## Production đã kiểm chứng — 08/11/2026, 05:38–05:42 UTC

Phần này cập nhật các giới hạn cloud nêu trong những mốc trước.

- PR #6 merge commit `d5c0e509f06d68af4eb7f34574c2a423a4663869`; cấu hình D1 production commit `aac8980750d2962a6b39bd947e857356d5f383ce`.
- Cloudflare production branch `main`; Workers build `7c8257a4-ca43-498a-8f1e-f0195589d85a`, version `5a2507c2-5aea-409f-988a-2232220c39c6`, success. GitHub Actions backend run `42451534549` success.
- Authenticated production `/session` trả release tương ứng, `ai=true`, `drafts=true`, `publishing/scheduling/inbox=false`.
- Cloud preview: bốn task generate/improve/adapt/reply có phản hồi thật. Production: generate tạo đủ ba phương án qua UI.
- D1 production UUID `50da4192-8c86-4168-b3ff-5ef11f6e3a96`, database `shopai-drafts-production`; schema chạy thành công trong D1 Console. Không dùng database preview cho production.
- Bản nháp kiểm thử production `d_rjs4ak2c`, revision 1. Lưu từ UI, đọc lại GET /storage/drafts, mở qua UI tab thứ hai với trạng thái “Đã mở bản nháp máy chủ, phiên bản 1.”
- Bộ kiểm thử của bản production: 47/47 pass, Wrangler dry-run pass. Không đăng bài, gửi tin hay sử dụng dữ liệu khách hàng.
- Model cũ `@cf/meta/llama-3.1-8b-instruct` đã nghỉ cung cấp; lỗi HTTP502 được tái hiện. Model mới Gemma4 trả chuẩn chat completions; regression kiểm tra normalize kết quả, không dùng reasoning hoặc kết quả bị cắt. Reviewer đề nghị tắt thinking và đã sửa/kiểm thử.

## Chuẩn bị OAuth Facebook — chưa coi là tích hợp chạy thật

- Bộ kiểm thử mở rộng: 59/59 pass, Wrangler dry-run 293.75 KiB / gzip 87.00 KiB tại thời điểm trước review cuối.
- Dùng Graph fixtures cho code exchange, kiểm tra app/token/quyền, pagination và lỗi; SQLite thật cho state một lần, phân quyền và mã hóa token. Không gọi Meta bằng tài khoản thật trong các test này.
- Không cấu hình secrets, không cấp Page grant, không bật OAuth trên cloud trong bước này. Publishing, scheduling và inbox tiếp tục false.

- Sau review độc lập OAuth: đã thu hẹp quyền yêu cầu chỉ còn pages_show_list và yêu cầu khai báo đã xác minh phạm vi khi dùng Login for Business config ID. Test mới tái hiện yêu cầu quyền quá rộng trước sửa; toàn suite cuối **60/60 pass**, Wrangler dry-run exit 0. Các minor còn lại được ghi ở FACEBOOK_SETUP.md, không bật OAuth thật trong bản này.
