# PR #19: xử lý tám nhận xét review

Nền: main `f7299c4`. Nhánh: `feat/shoppost-release-plan-20261109`.

| Nhận xét | Thay đổi | Bằng chứng |
|---|---|---|
| 1. Runtime và migration trùng cột | Giữ migration cũ. Preflight xác minh schema rồi hòa giải ledger cho 0010/0014 | DB runtime-first, migration-first, schema sai và Wrangler local |
| 2. Token hồi sinh sau unlink | Meta và Telegram lưu credential có điều kiện generation. Unlink tăng generation trong transaction | Pause provider, unlink, resume bị từ chối |
| 3. Instagram tạo lại container | Lưu container trên publish_jobs, dùng lại khi polling/retry | Hai retry đồng thời chỉ publish một lần. Unknown không replay |
| 4. Thiếu user scope | socialRequest dùng cloudRequest với scope được nhúng | Tab cũ, cookie thành viên khác cùng shop nhận ACCOUNT_CHANGED |
| 5. Loader ghi đè trang khác | Chỉ render khi route/view còn khớp | Disconnect đang chờ rồi chuyển trang |
| 6. Phản hồi sai shop/view | Chờ shopInit. Guard shop, view và request generation cho cả success/error | Direct accounts với shop đã lưu, đổi shop và rời/quay lại cùng shop |
| 7. Không ngắt được kênh lỗi | Hiện unlink cho trạng thái chưa revoked và đúng quyền | active/error/reauth_required đều có nút |
| 8. Idempotency key bị giữ sai | Theo dõi riêng từng shop/account/payload, hòa giải theo job ID, giữ qua reload trong tab | Retry lịch sử, giữ form, đổi payload/account/shop và unknown |

Đường dẫn `0007_publish_retry_after.sql` trong nhận xét đã được thay bằng `0010_publish_retry_after.sql` khi đồng bộ main.
Việc đổi tên chưa giải quyết runtime-first. Preflight trong lần sửa này xử lý nguyên nhân đó.
Guard success theo shop đã có trước. Nhánh error và lifecycle của view vẫn cần sửa.
Các bản sửa Meta/Instagram ở nhánh PR #30/#31 được đối chiếu và thích nghi với mã hiện tại.

## Kiểm chứng

- Tái hiện lỗi trước khi sửa bằng regression backend và UI.
- `WRANGLER_SEND_METRICS=false npm run check`: 175 tests đạt, 0 lỗi, Wrangler dry-run đạt.
- Reviewer độc lập không tìm thấy lỗi Important/Critical trong diff đã rà soát.
- DB local riêng: preflight nhận diện 0010/0014, Wrangler áp các migration còn lại thành công. Chạy lại preflight trả danh sách rỗng.
- `git diff --check` sạch.

## Nâng cấp

Thực hiện preflight và migration theo [META_STAGING.md](../../backend/META_STAGING.md).
Migration mới: 0014 thêm checkpoint Instagram, 0015 thêm fence OAuth state.
Không sửa migration đã áp dụng. Không áp migration hoặc deploy production trong lần sửa PR này.
