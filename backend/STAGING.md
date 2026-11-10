# ShopAI staging — preview.shoppost.net

## Trạng thái ngày 08/11/2026

Người dùng đã duyệt triển khai staging tại `preview.shoppost.net`, Worker riêng, Access và DB thử nghiệm riêng; giữ nguyên `shoppost.net` và `www.shoppost.net` trong nghiệm thu.

**Chưa triển khai.** Phiên Cloudflare hiện yêu cầu đăng nhập; lần đăng nhập trả `API Request Failed ... (403)`. Chưa tạo Worker, D1, Access application hoặc DNS. Bộ cấu hình này được chuẩn bị từ `main` commit `571b4f0f4ad4b958908fef648a66ddea79cfdd06`; không lấy nguyên nhánh cũ của PR #9.

Kiểm tra cục bộ: 49/49 test đạt, gồm kiểm thử D1 cục bộ và 2 test cách ly cấu hình staging. Wrangler staging dry-run đóng gói thành công với UUID/AUD giả chỉ dùng để kiểm tra build; điều đó không xác nhận tài nguyên Cloudflare tồn tại. Lỗi đường dẫn build ban đầu đã được xử lý trong các lệnh bên dưới bằng cách chạy Wrangler từ `backend`.

## Phạm vi cố định

| Thành phần | Staging | Production giữ nguyên |
| --- | --- | --- |
| Worker | `shopai-staging` | `shopai-backend` |
| Hostname | `preview.shoppost.net` — Custom Domain | `shoppost.net`, `www.shoppost.net` |
| D1 | DB mới `shopai-drafts-staging` | `shopai-drafts-production` |
| Access | Ứng dụng mới, audience riêng | Ứng dụng và policy hiện hành |
| Điểm vào phụ | `workers.dev` và preview URLs tắt | Không thay đổi |

Generator chỉ xuất JSON ra stdout, không gọi Cloudflare. Cấu hình được tạo bằng whitelist, không kế thừa routes/preview bindings production. Thiếu ID, sai định dạng hoặc dùng lại DB/audience hiện hành sẽ dừng. ID và audience hợp lệ về định dạng vẫn cần đối chiếu với tài nguyên thật trên Cloudflare.

## Thứ tự triển khai khi truy cập được Cloudflare

1. Xác minh đúng tài khoản `ct@pthub.vn` và zone `shoppost.net`. Lưu snapshot DNS của apex/www/preview, Worker version đang chạy, routes, Access domains/policies và production D1 binding. Xem có wildcard Worker route hoặc Access application bao phủ preview không; chỉ đọc, chưa sửa các cấu hình đó.
2. Nếu `preview.shoppost.net` đã có bản ghi hoặc dịch vụ, dừng để đối chiếu; không ghi đè. Kiểm tra tên `shopai-staging` và DB staging chưa thuộc công việc khác.
3. Tạo Access self-hosted application riêng `ShopAI staging` cho toàn bộ `preview.shoppost.net` (không chỉ `/`). Policy Allow chỉ `ct@pthub.vn`, thời hạn phiên 8 giờ; không thêm Everyone/Bypass hay mở rộng policy production. Lấy audience của ứng dụng mới. Dùng phương thức đăng nhập đã có, không đổi cấu hình IdP toàn tài khoản. Nếu có Access wildcard xung đột, xác minh quy tắc ưu tiên trước khi tiếp tục.
4. Tạo D1 `shopai-drafts-staging` trong đúng tài khoản, lấy UUID. Không dùng UUID `shopai-drafts-production` hoặc `shopai-drafts-preview`, không chép dữ liệu thật sang staging.
5. Đặt hai biến môi trường bên dưới bằng giá trị vừa xác minh, tạo config, dry-run và áp dụng migration chỉ cho D1 staging.
6. Triển khai bằng đúng file config staging. Workers Custom Domain sẽ tạo DNS/chứng thư cho **preview**. Không tạo CNAME thủ công tới URL PR preview, không đổi nameserver/SSL toàn zone/routes apex/www. Nếu CLI đề nghị thay tài nguyên khác hoặc domain xung đột, dừng.

Các lệnh từ thư mục gốc repository (ID và AUD không phải mật khẩu):

```bash
(
set -eu
export SHOPAI_STAGING_DB_ID='<UUID của shopai-drafts-staging>'
export SHOPAI_STAGING_ACCESS_AUD='<AUD của ShopAI staging>'
node backend/staging-config.mjs > backend/wrangler.staging.jsonc.tmp
mv backend/wrangler.staging.jsonc.tmp backend/wrangler.staging.jsonc
npm test
cd backend
npx --no-install wrangler deploy --config wrangler.staging.jsonc --dry-run --outdir dist/staging-check
npx --no-install wrangler d1 migrations apply shopai-drafts-staging --remote --config wrangler.staging.jsonc
npx --no-install wrangler deploy --config wrangler.staging.jsonc
)
```

Khối lệnh chạy trong subshell với `set -eu`: lỗi sinh cấu hình, test, build hoặc migration đều chặn bước sau, không dùng lại file config cũ để deploy. Wrangler phải chạy từ `backend` để custom build tìm được `build.mjs`. Không dùng `npm run build` để triển khai staging: script đó chỉ dry-run cấu hình mặc định. Không dùng `wrangler deploy` thiếu `--config`, không thêm `--env` hay `--name` để ghi đè target. Cấu hình staging tạm được gitignore, không tự commit UUID/AUD giả. Ghi lại UUID/AUD thật và version/commit trong biên bản sau khi triển khai được xác minh.

## Nghiệm thu trước mọi chuyển lưu lượng

- DNS authoritative và resolver công khai cùng phân giải preview; HTTPS có chứng thư hợp lệ cho hostname, không lặp chuyển hướng.
- Phiên chưa đăng nhập gặp Access; `ct@pthub.vn` truy cập được. Tài khoản ngoài policy bị chặn (chỉ thử với tài khoản được phép sử dụng). Kiểm tra token hết hạn/sai audience bị từ chối. Không tạo policy tạm bỏ qua Access.
- URL `shopai-staging.<account>.workers.dev` và preview version không phục vụ ứng dụng. Xác minh app `/`, `/session`, `/ai`, `/storage/*` cùng origin.
- `/health` và `/session` sau Access báo đúng `release`, `version`, `storageConfigured`/drafts. Kiểm tra D1 binding và migration trực tiếp; cờ cấu hình không chứng minh đọc/ghi được.
- Chạy thật 4 tác vụ AI `generate`, `improve`, `adapt`, `reply`; lưu/mở/cập nhật bản nháp mẫu `STAGING-TEST-*`, kiểm tra revision conflict. Chỉ dữ liệu giả; không đăng bài/gửi tin ra kênh thật.
- So sánh snapshot sau triển khai với trước: DNS apex/www, production Worker version, routes, Access policy/audience và D1 binding phải giữ nguyên. Chỉ khi đủ bằng chứng mới ghi ĐẠT.

## Khôi phục staging

Nếu lỗi, bỏ Custom Domain của **shopai-staging** theo snapshot để ngừng phục vụ preview; giữ Access bảo vệ hostname và giữ DB để điều tra. Không xóa DB, không đổi version hoặc route production. Khôi phục Worker staging về version trước chỉ hoàn tác mã; không hoàn tác dữ liệu/migration.

## Tài liệu tham khảo

- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/d1/reference/migrations/
