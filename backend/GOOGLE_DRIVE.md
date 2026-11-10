# Google Drive Library import

This feature is separate from Google/YouTube authorization. It does not use, extend or replace `google_channels` or the YouTube callback.

## Deployment requirements

1. Enable **Google Drive API** in the Google Cloud project that owns the existing Google OAuth client.
2. Register `https://shoppost.net/api/library/drive/callback` as an authorized redirect URI for that web client. Register a separate staging URI/client if used on staging.
3. Configure `DRIVE_REDIRECT_URI` on the Worker to that exact URI. Existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SOCIAL_TOKEN_KEY` are required. Keep secrets in Cloudflare; never commit them.
4. Add `https://www.googleapis.com/auth/drive.readonly` to the consent configuration. This grants view/download of Drive files and can require Google verification; test with a permitted test account first. The user must approve the actual grant on Google. Do not bypass an unverified-app security interstitial.
5. Deploy the reviewed Worker build. Open **Kho tài nguyên → Kiểm tra Drive → Kết nối Google Drive**, authorize the appropriate account, then select files and explicitly import.

No live connection is claimed by this branch. With `DRIVE_REDIRECT_URI` absent the card reports **Chưa cấu hình** and cannot simulate success. Dropbox, OneDrive and Email remain unsupported.

## Behavior and boundaries

- Server-bound code exchange with PKCE, hashed ten-minute one-use actor/shop-bound state and encrypted access/refresh tokens in D1 (`drive_connections`, `drive_oauth_states`). Tables are initialized idempotently following the existing Google module's approach.
- Owner/manager can connect/disconnect; `drafts.create` is required to list/download. Viewer/support do not gain access through the server.
- Search names and load 50 entries per page. Folders are excluded. File bytes stream from fixed Google API URLs with redirects refused and a 50 MiB cap. Export Docs/Sheets/Slides as DOCX/XLSX/PPTX; unsupported Google types are disabled. Google can impose a smaller export limit.
- Imported originals are verified in browser IndexedDB; source/remote ID prevent importing the same file again. Imports are not a shared server-side media library. Browser-local collections retain the application's existing project/account scope; this feature does not add per-shop local storage isolation.
- Disconnect clears local encrypted credentials and pending OAuth states. It does not revoke the Google application grant globally (which could affect YouTube); use Google account permissions for global revocation.

## Verification

Automated provider responses exercise protocol/error behavior, not a real Google account. Live acceptance must cover consent, denied consent, real search/pagination, binary download, Google document export, revoked token, local quota error and a reload showing the imported original. No production credentials or account files were accessed in the implementation tests.

Official references:
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
