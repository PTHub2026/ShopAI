# ShopPost

Ứng dụng nội dung ShopPost × ShopTrack, dùng Cloudflare Workers, Workers AI và D1. Bản HTML offline là demo. Bản server có xác thực Access, AI và thao tác lưu/mở bản nháp văn bản; các tích hợp đăng bài, lịch đăng và gửi tin đa kênh thật còn chưa triển khai.

## Phát triển và kiểm chứng

Cần Node.js 24 trở lên và Git (hoặc biến `SHOPAI_RELEASE_SHA` gồm 40 ký tự hex).

```sh
npm ci
npm test
npm run build
```

`npm run build` chỉ đóng gói/dry-run, không phát hành. `npm run check` chạy cả kiểm thử và dry-run. Không cần khóa AI hoặc quyền Cloudflare để chạy bộ test; AI và JWKS trong test là fixture, D1 integration chạy trên workerd cục bộ.

Xem [trạng thái hiện tại](backend/READINESS.md), [bằng chứng kiểm chứng](backend/VERIFICATION.md) và [phạm vi database preview](backend/D1_PREVIEW.md).

Trước phát hành, đối chiếu commit với `/health.release`, xác minh Access, Workers AI và D1 trên preview. Không dùng unit test hoặc dry-run thay cho kiểm chứng cloud runtime.
