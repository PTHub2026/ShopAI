# Shoppost — phương án hợp nhất và nghiệm thu sản phẩm

Ngày: 09/11/2026. Trạng thái: phương án triển khai; không phải xác nhận phần mềm đã hoàn thiện.

> Đồng bộ 10/11/2026: tài liệu này giữ phương án ngày 09/11 để đối chiếu. Nhánh đã hợp nhất main `a8096cd`, gồm kho `channels`, hàng đợi chung, Zalo OA và các bản sửa tiếp theo. Trạng thái mới xem `docs/releases/2026-11-10-channels-execution.md`. Các số migration và ô chưa hoàn tất bên dưới là lịch sử kế hoạch, không phải lệnh triển khai hiện hành. Dùng danh sách migration hiện tại và ledger của từng database, không áp lại các tệp social 0005–0007 cũ.

## Mục tiêu và nền tảng

Tên hiển thị thống nhất **Shoppost**, tên miền shoppost.net. Giữ repository PTHub2026/ShopAI, Worker, cookie, database, header và khóa localStorage hiện tại để không làm mất phiên hoặc dữ liệu. Đổi repository là việc độc lập, không cần để đổi thương hiệu sản phẩm.

Dùng Cloudflare Workers + D1, giao diện hiện có và backend kiểm tra quyền theo shop. Lấy main 090d727 làm nền ban đầu; luôn lấy lại HEAD mới trước khi hợp nhất. Main đã gỡ đăng nhập Zalo/Facebook: kết nối OA/Page là quyền dùng kênh, độc lập với đăng nhập Shoppost.

## Quyết định người dùng chốt — 09/11/2026

- Bỏ chức năng **đăng nhập bằng Zalo/Facebook**. Không khôi phục nút, route đăng nhập hoặc provider đăng nhập này khi hợp nhất #17/#18.
- Chỉ giữ **kết nối Zalo OA/Facebook Page** để cấp quyền quản lý kênh, đăng nội dung hoặc trả lời tin nhắn theo API/quyền được cấp. Kết nối kênh chỉ thực hiện sau khi đã đăng nhập Shoppost; callback kết nối không tạo phiên đăng nhập Shoppost.
- Bảo toàn tài khoản, shop, tư cách thành viên và dữ liệu cũ. Tài khoản đã có email/mật khẩu tiếp tục dùng phương thức đó.
- Với tài khoản trước đây chỉ có danh tính Zalo/Facebook, phải có luồng chuyển đổi được xác minh sang email/mật khẩu và giữ nguyên owner/shop. Chưa xác minh thì ghi nhận cần khôi phục, không tự gộp theo tên/email chưa xác thực và không tạo shop thay thế.
- Kiểm thử bắt buộc: login Zalo/Facebook không được quảng bá/chấp nhận; OAuth OA/Page không đăng nhập được vào Shoppost; ngắt kênh không xóa tài khoản hoặc quyền shop; tài khoản cũ sau chuyển đổi vẫn đọc đúng dữ liệu, tài khoản khác không chiếm được quyền.
- Đây là yêu cầu triển khai và nghiệm thu. Luồng chuyển đổi tài khoản cũ chưa được xem là đã xây dựng hoặc kiểm chứng chỉ vì tài liệu này được cập nhật.

## Các cách hợp nhất và lựa chọn đề xuất

| Cách | Lợi ích | Rủi ro | Kết luận |
|---|---|---|---|
| Merge toàn bộ các nhánh cũ | Nhanh | Khôi phục login đã gỡ, giao diện cũ, cấu hình production cũ | Không chọn |
| Main hiện tại + chuyển từng phần đã kiểm chứng | Giữ hành vi mới, dễ rollback | Cần sửa xung đột và kiểm thử lại | Đề xuất thực hiện |
| Viết lại toàn bộ | Kiến trúc mới | Tốn công, rủi ro dữ liệu và mất chức năng | Không cần |

## Kiểm kê đã xác minh

- PR #17: social_accounts, publish_jobs và Telegram; PR #18 xếp trên #17: Meta Page/Instagram.
- Commit 9d1670c trên #18 đã sửa Telegram phản hồi thiếu message_id: unknown, không retry. 112/112 test và dry-run đạt; CI 42609526917 thành công; Cloudflare preview version 46bfb3b1 Ready.
- Preview hiện có gắn D1 preview riêng nhưng vẫn thuộc Worker shopai-backend, không phải Worker staging riêng.
- Settings preview được kiểm tra trực tiếp chưa có SOCIAL_TOKEN_KEY hoặc cấu hình Meta. Chưa nghiệm thu gửi bài thật.
- Main 090d727 đã gỡ backend login Zalo/Facebook. Nhánh #18 còn mã cũ: không merge mù.
- Zalo hiện xuất hiện trong giao diện nhưng chưa có adapter OA trong bộ social publishing. Login Zalo cũ không thay thế OA API.

## Phạm vi Zalo đề xuất

Kết nối **Zalo Official Account** bằng API chính thức. V1 cần: cấp quyền OA, trạng thái kết nối và quyền, làm mới token, ngắt kết nối, nhận tin qua webhook và trả lời trong điều kiện API cho phép. Nội dung/broadcast chỉ bật sau khi xác minh API, quyền OA và hạn mức tương ứng; không coi API chat là API đăng bài.

Không phục hồi login Zalo/Facebook theo quyết định người dùng đã chốt. Không dùng phiên Zalo cá nhân, tự quét nhóm hoặc mô phỏng đã gửi. Đây là quyết định kỹ thuật đề xuất theo mục tiêu sản phẩm đa kênh.

## Thứ tự công việc và tiêu chí đạt

### 1. Thương hiệu và hợp nhất nền

Files: index.html, login.html, backend/src/auth.js, backend/src/worker.js, backend/test/*.test.mjs.

- [x] Chuẩn hóa tên hiển thị Shoppost trong giao diện, thư email và thông báo backend.
- [ ] Trước khi đưa #17/#18 vào nhánh release, chuyển riêng social.js, meta.js, migrations 0005/0006, routing social và giao diện accounts lên main mới.
- [ ] Giữ nguyên việc gỡ login Zalo/Facebook; bổ sung test khẳng định /auth/providers không quảng bá hai phương thức đó.
- [ ] So sánh toàn bộ schema main/nhánh; migration append-only, thử nâng cấp DB có dữ liệu và DB mới. Không sửa migration đã áp dụng.
- [ ] Kiểm tra UI: tên, nút, lỗi, trạng thái đang tải, rỗng, lỗi mạng, màn hình hẹp 360px và bàn phím.

### 2. Staging độc lập

Files: backend/wrangler.staging.jsonc (sinh từ cấu hình staging đã rà soát), backend/STAGING.md, backend/test/staging.test.mjs.

- [ ] Đối chiếu PR #10 với main mới, tạo Worker shoppost-staging, D1 riêng và Access riêng trước khi mở hostname preview.shoppost.net.
- [ ] Kiểm kê hostname/route/DB trước và sau; không dùng ID DB production hoặc thay route production.
- [ ] Khóa SOCIAL_TOKEN_KEY 32 byte và App secrets chỉ trong Cloudflare Secrets, không đưa vào PR/log.
- [ ] Kiểm tra /health.release đúng SHA, thiếu phiên bị từ chối; AI generate/improve/adapt/reply và lưu/mở nháp, refresh, xung đột 409 đều chạy thật.

### 3. Kênh Telegram và Meta

Files: backend/src/social.js, backend/src/meta.js, migrations mới nếu cần, backend/test/social-integration.test.mjs, backend/test/meta-oauth.test.mjs.

- [ ] Kiểm tra tenant/owner/manager/content/viewer, shop bị tạm ngưng, token revoked và đổi tài khoản giữa phiên.
- [ ] Sửa retry để lưu retry_after/next_attempt_at và kiểm tra nguyên tử trước gửi; không cho bấm retry vượt thời gian provider yêu cầu. Kiểm thử hai request đồng thời chỉ gửi một lần.
- [ ] Instagram lưu container ID theo job và kiểm tra lại container khi processing, không tạo mới mỗi lần retry. Unknown tuyệt đối không tự gửi lại.
- [ ] OAuth callback chống replay, hết hạn, sai actor/shop và race disconnect; không lưu lại token nếu disconnect xảy ra trong lúc đổi code.
- [ ] Thử Telegram text/ảnh trong kênh thử được phép; Meta OAuth + Page text/ảnh + Instagram ảnh trên tài khoản thử. Ghi remote ID, thời điểm, SHA và bằng chứng, không ghi token.

### 4. Adapter Zalo OA

Files dự kiến: backend/src/zalo-oa.js, backend/migrations/0007_zalo_oa.sql (chốt số sau kiểm kê), backend/test/zalo-oa.test.mjs, backend/test/zalo-webhook.test.mjs, backend/src/worker.js, index.html.

Giao diện dự kiến: POST /api/zalo-oa/start, GET /api/zalo-oa/callback, GET /api/zalo-oa/accounts, DELETE /api/zalo-oa/accounts/:id, POST /webhooks/zalo, GET /api/zalo-oa/conversations, POST /api/zalo-oa/messages. Mọi endpoint nội bộ yêu cầu phiên và quyền của đúng shop; webhook dùng cơ chế xác thực chính thức của Zalo, không dùng phiên người dùng.

- [ ] Đọc lại tài liệu Zalo OA chính thức tại thời điểm triển khai; chốt tham số authorize/callback, xác minh chữ ký webhook và điều kiện gửi tin trước khi viết adapter.
- [ ] OAuth state một lần, TTL 10 phút, actor/shop ràng buộc phía server; mã hóa access/refresh token, lưu expires_at và generation. Không trả token về browser.
- [ ] Refresh token một lần: khóa/lease theo OA, cập nhật cặp token nguyên tử và kiểm thử hai request đồng thời; mất phản hồi đặt cần kết nối lại, không lặp refresh mù.
- [ ] Webhook kiểm chữ ký trên payload theo tài liệu, kiểm OA/app, giới hạn body, chống trùng event, lưu theo shop và phản hồi nhanh. Webhook tới trước/khi ngắt kết nối không được chuyển dữ liệu sang shop khác.
- [ ] Danh sách hội thoại phân trang; reply chỉ cho nhân viên được giao/quyền phù hợp, lưu message ID và trạng thái thực tế. Hết điều kiện gửi phải báo lỗi rõ; chưa có delivery event không hiển thị đã nhận/đã đọc.
- [ ] Kiểm thử thật trên OA thử: kết nối, nhận một tin từ người thử, trả lời, refresh token, thu hồi quyền, webhook lặp; lưu bằng chứng đã che dữ liệu cá nhân.

### 5. Vận hành chuyên nghiệp và phát hành

- [ ] Đăng ký, login/logout, quên mật khẩu, mời thành viên và phân quyền kiểm thử xuyên suốt trên staging.
- [ ] Không số liệu ngẫu nhiên, không connected giả, không báo thành công từ mock; chức năng chưa cấu hình có trạng thái và hướng dẫn rõ.
- [ ] Nhật ký có request ID/job ID, không token/code/OTP; theo dõi lỗi 5xx, OAuth fail, refresh fail, unknown jobs và webhook backlog.
- [ ] Backup D1 và thử khôi phục trước migration; rollback Worker không tự rollback schema phá dữ liệu.
- [ ] npm ci && npm run check trên đúng release SHA; smoke API + UI, kiểm tra quyền chéo shop và browser mobile.
- [ ] Chỉ đề xuất promote production sau bằng chứng live từng tính năng; ghi feature matrix: đã nghiệm thu / chưa cấu hình / chưa hỗ trợ. Giữ PR draft nếu còn thiếu cổng bắt buộc.

## Thông tin cần có để nghiệm thu Zalo thật

| Mục | Dùng để làm gì | Cách cung cấp |
|---|---|---|
| OA ID và tài khoản quản trị OA thử | Chọn đúng OA và cấp quyền | Phiên dashboard người dùng |
| Zalo App ID, secret và quyền OA | OAuth, refresh, xác thực API/webhook | Secret vào Cloudflare, không gửi trong chat/GitHub |
| Callback và webhook HTTPS staging | Zalo trả code/sự kiện | Khớp chính xác dashboard và backend |
| Người thử đồng ý gửi/nhận tin | Thử hội thoại và điều kiện trả lời | Tài khoản thử, không dùng khách hàng thật |
| Hạn mức/gói OA và các quyền được duyệt | Xác định tính năng được bật | Kiểm tra dashboard/tài liệu chính thức |

## Nguồn và giới hạn

https://developers.zalo.me/docs
https://oa.zalo.me/home/documents/guides/Khoi-tao-ung-dung-va-cap-quyen_117071366476220195
https://stc-developers.zdn.vn/docs/v2/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new

Tài liệu xác thực OA mô tả refresh token dùng một lần; vì vậy phải kiểm soát đồng thời. Thời hạn/quyền/hạn mức lấy từ phản hồi API và tài liệu hiện hành, không hard-code các cam kết thương mại. Đạt unit test hoặc build không thay cho nghiệm thu OA thật.
