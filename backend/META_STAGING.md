# Kết nối Meta / Facebook Pages / Instagram Professional — staging

**Nhánh hợp nhất dựa trên main có Zalo OA; phần đa kênh lấy từ PR #20. Không chạy migration hoặc Wrangler deploy lên production khi chưa kiểm thử staging.**

## Kiến trúc

- Đăng nhập ShopPost (Facebook Login trước đây) **khác** với ủy quyền quản lý tài khoản mạng xã hội.
- `POST /api/social/meta/start` xác thực phiên và quyền `channels.configure_token`; trả về URL Facebook OAuth (không bao giờ gửi App Secret đến frontend).
- `GET /api/social/meta/callback` xác thực cùng người dùng + shop dựa trên state hash SHA-256, TTL 600 giây và xóa state nguyên tử trước khi đổi code. Sau đó lấy Page tokens, thêm từng Facebook Page và Instagram Professional liên kết Page.
- Token mã hóa AES-256-GCM tại D1; `GET /api/social/accounts` chỉ trả tên, provider, targetId, status.
- Đăng text/ảnh Facebook Page; đăng ảnh Instagram qua tạo media container rồi publish.
- Dùng chung `POST /api/social/jobs`, lịch sử và idempotency của Telegram. Khi kết quả gửi chưa rõ, không tự gửi lại để tránh đăng trùng.

## Cấu hình staging Cloudflare

1. Tạo D1 staging riêng. Dừng Worker/cron ghi vào DB trong cửa sổ nâng cấp, sao lưu và kiểm tra ledger. Chạy preflight bên dưới trước khi áp các migration chưa có đến 0015. Dùng đúng config và binding staging.
2. `wrangler secret put SOCIAL_TOKEN_KEY`: base64 của 32 byte ngẫu nhiên (không commit, không đưa secret vào URL/log). Cần khóa ổn định qua các lần deploy.
3. Dùng `FACEBOOK_APP_ID` và `FACEBOOK_APP_SECRET` **nếu Meta App hiện có được quyền Pages + Instagram**; nếu không, cấu hình `META_APP_ID` và `META_APP_SECRET` tách riêng. Secret chỉ đặt trong Cloudflare Secrets.
4. Cấu hình `META_REDIRECT_URI=https://<staging-host>/api/social/meta/callback`. Thêm URI này *chính xác* vào Valid OAuth Redirect URIs trong Meta App Dashboard. Có thể dùng `META_GRAPH_VERSION=v26.0` để pin version sau khi kiểm chứng.
5. App scopes bắt buộc theo use case: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Các tài khoản Instagram phải Professional (Business/Creator) và liên kết Page.
6. Chỉ khi App Review / Business Verification / Advanced Access đáp ứng mới cho phép các shop khác sử dụng; nếu không chỉ test bằng tài khoản Role tester/developer được Meta cho phép.

## Nâng cấp DB từng được Worker khởi tạo

Các migration 0010 và 0014 thêm cột có thể đã tồn tại do runtime. Không chạy lại ALTER hoặc sửa migration cũ.
Preflight xác minh kiểu, nullability và default của từng cột trước khi bổ sung tên migration tương ứng vào `d1_migrations`.
Nếu cột chưa có, preflight để Wrangler chạy ALTER bình thường. Schema không khớp sẽ bị từ chối.

Từ thư mục gốc repository, với config staging đã tạo:

```bash
node backend/reconcile-runtime-migrations.mjs --config backend/wrangler.staging.jsonc --database DB --remote
npx wrangler d1 migrations apply DB --config backend/wrangler.staging.jsonc --remote
```

Dùng `--local` ở cả hai lệnh khi kiểm tra DB local. Script bắt buộc config, binding và chế độ rõ ràng.
Script chỉ sửa bookkeeping cho 0010/0014, không hòa giải các migration khác hoặc đổi dữ liệu job/token.
0014 lưu `instagram_container_id`. 0015 lưu generation đi kèm OAuth state. Kiểm tra schema và ledger sau nâng cấp rồi mới bật lại Worker/cron.
Giữ nguyên các cột mới khi rollback Worker. Không phục hồi job `unknown` thành job chờ gửi.

## QA bắt buộc

- OAuth start/callback bằng tài khoản test; state sai, hết hạn, dùng lại và khác shop phải bị từ chối.
- Page chỉ hiển thị trong shop đã kết nối; viewer không cấu hình hoặc đăng.
- Facebook đăng văn bản + ảnh; Instagram đăng ảnh HTTPS công khai; kiểm tra permalink và remote ID trên nền tảng thật.
- Kiểm tra token revoked, mất quyền Page, rate limit, lỗi mạng, trạng thái `unknown`; không đăng lại khi chưa xác nhận kết quả.
- Ngắt kết nối khi callback Meta hoặc xác minh Telegram đang chờ. Kết quả cũ phải bị từ chối, token vẫn rỗng.
- Instagram `IN_PROGRESS` dùng lại container trên cùng job. Hai retry đồng thời chỉ được publish một lần.
- Tab cũ sau đổi tài khoản phải nhận `ACCOUNT_CHANGED`. Đổi shop/trang không được nhận nội dung hoặc lỗi của màn trước.
- Gửi bài phải do người dùng xác nhận, không tự đăng khi OAuth hoàn tất.
- Không lấy quyền đăng bài Facebook profile cá nhân hoặc Instagram Personal.
- Chỉ sau khi được duyệt mới tính đến merge từng PR và deploy production.

## Lưu ý

Nếu bảng `social_accounts` đã tạo với CHECK chỉ cho `telegram` từ bản thử nghiệm cũ, đừng thay trực tiếp ràng buộc bằng `CREATE TABLE IF NOT EXISTS`. Phải lập migration rebuild có kiểm chứng sao lưu dữ liệu, hoặc dùng database staging mới. Bản PR #17 đang draft, nên chưa được xem là một schema production chính thức.
