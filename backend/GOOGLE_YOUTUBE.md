# Google / YouTube

This connects a YouTube channel to an existing ShopPost shop. It does not create a ShopPost login or request Gmail, Google Drive, contacts or Google profile access.

## Configuration

Use an existing Google Cloud project owned by the organization where possible. Enable **YouTube Data API v3**. Configure the OAuth consent screen with ShopPost's homepage `https://shoppost.net`, privacy `https://shoppost.net/privacy`, and terms `https://shoppost.net/terms`.

Create a **Web application** OAuth client with the exact authorized redirect URI:

`https://shoppost.net/api/social/google/callback`

Worker configuration:

| Setting | Storage |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Worker variable, from the Web application OAuth client |
| `GOOGLE_CLIENT_SECRET` | Worker secret; never commit it or paste it in chat |
| `GOOGLE_REDIRECT_URI` | Worker variable, configured in wrangler.jsonc |
| `SOCIAL_TOKEN_KEY` | Existing Worker secret; preserve the current encryption key |

Scopes: `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/youtube.upload`. Testing-mode apps need the intended Google users registered as test users. Any consent-screen verification and publishing requirements remain Google's decision; a local test does not establish approval.

## Behavior

- Owners/managers connect or disconnect; users with channel-operation or publishing permission upload. Viewers can only read connection/history metadata.
- OAuth uses PKCE and a hashed, ten-minute, one-use state bound to the signed-in actor and shop. Callback verifies one channel from `channels.list(mine=true)` and requires both scopes and an offline refresh token. No synthetic connection is saved.
- Access/refresh credentials are encrypted together with AES-GCM. Refresh writes use compare-and-swap. Disconnect invalidates outstanding consent states and removes local tokens; videos already uploaded remain on YouTube. To revoke the entire app grant, use Google account permissions.
- Video uploads are immediate and separate from the text/photo scheduling queue. MP4/WebM/MOV, up to 50 MiB; title, description, audience and visibility are user-selected. Default visibility in the UI is private. Video bytes are streamed to a Google resumable-upload session without retaining the file on the server.
- A durable upload ID and idempotency key prevent duplicate sends. If the final response is lost, the state is `unknown`, never automatically retried; inspect YouTube Studio before starting another upload. A resumable session is used for transfer; resuming interrupted byte ranges is not implemented.
- Inactive provider data and upload-result metadata expire after 30 days. Cron and authenticated requests perform cleanup. Audit entries retain only internal references, not YouTube titles/descriptions or tokens.
- Migration `0014_google_youtube.sql` creates independent tables without rebuilding existing channels. The runtime also performs idempotent table initialization.

## Verification and live acceptance

`npm test` includes real SQLite, jsdom and Miniflare/workerd checks: state replay/actor isolation, encrypted secrets, scope/offline-token rejection, callback/disconnect race, upload idempotency, uncertain results, forbidden upload-session destinations and fixed-length streaming. Existing Telegram adapter has a workerd regression test for redirect handling.

Live acceptance still requires an actual Google OAuth client/secret and the channel owner's consent. After connecting, confirm the actual channel name, upload a user-approved test video, verify its returned ID/visibility in YouTube Studio, and disconnect/reconnect if authorized. Do not use test fixtures as live acceptance evidence.

## Official references

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/youtube/data/guides/authentication
- https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.cloudflare.com/workers/runtime-apis/request/
