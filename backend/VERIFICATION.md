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
