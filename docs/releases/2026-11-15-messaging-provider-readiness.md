# Messaging provider readiness

Implemented Zalo OA text receive/reply through `/webhooks/replies/zalo`. Explicit channel activation verifies `/v2.0/oa/getoa` against the connected OA identifier. The callback accepts `user_send_text` only, authenticates the raw JSON with `X-ZEvent-Signature: mac=<sha256(app_id + raw body + timestamp + OA webhook secret)>`, and routes by OA recipient. Retries deduplicate by message ID. Outbound replies quote the inbound message via `/v3.0/oa/message/cs`; only a confirmed provider message ID records success. Ambiguous delivery is never retried automatically.

## Operator setup still required

- Set `ZALO_OA_WEBHOOK_SECRET` to the OA webhook signing secret (not the OAuth app secret).
- Configure the application's Zalo webhook URL as `https://<PUBLIC_ORIGIN host>/webhooks/replies/zalo` and subscribe to user text messages.
- Only after verifying that configuration, set `ZALO_REPLY_WEBHOOK_READY=true`. Existing `ZALO_APP_ID`, `ZALO_APP_SECRET`, `SOCIAL_TOKEN_KEY`, and HTTPS `PUBLIC_ORIGIN` are also required.
- Enable the connected OA from Reply channels. An unexpired current OA token and correct target are checked. This does not prove message permission/quota; those remain enforced by Zalo on each send. No real customer message was sent during implementation.
- Credential replacement/refresh intentionally invalidates active bindings. Explicitly activate again after token rotation; old queued events cannot use the replacement credential. This first implementation does not silently migrate reply authority across credential refreshes.
- Text only, maximum 2,000 characters. Zalo quick reply buttons and attachment messages are not implemented. The local reply window remains the conservative 24 hours shared by the existing reply engine (Zalo currently permits a longer window).

Facebook `credential_changed` means the saved activation refers to an older encrypted Page credential; activate the channel explicitly to verify Page identity and `pages_messaging` / `pages_manage_metadata` again. No automatic reenabling or permission expansion is performed.

Meta engagement now distinguishes invalid tokens, missing read permission, unavailable objects, rate limiting, and request failure. Missing permission is not treated as zero engagement. The Page feed documentation lists `pages_read_engagement` and `pages_read_user_content`; access must be granted through the existing Meta application/account process. This change does not request broader scopes.

## Official contracts checked 2026-11-15

- https://stc-developers.zdn.vn/docs/v2/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan
- https://stc-developers.zdn.vn/docs/v2/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-trich-dan
- https://oa.zalo.me/home/documents/guides/tin-tu-van
- https://developers.facebook.com/docs/graph-api/reference/page/feed/

Validation uses synthetic credentials and intercepted fetch with real in-memory SQLite: authentication, OA identity, target isolation, activation gating, replay deduplication, rotation revocation and uncertain delivery.
