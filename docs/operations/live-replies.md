# Live reply setup and operational limits

The implementation is opt-in per connected channel. Saving scripts, connecting a publishing account, importing local scripts, or deploying the application does not activate automatic replies. Existing channels start inactive. An owner or manager must explicitly enable the channel in Reply Scripts; activation performs real provider checks and may configure the provider's inbound webhook/subscription.

## Shared prerequisites

- D1 binding `DB`, the existing 32-byte base64 `SOCIAL_TOKEN_KEY`, and the `AI_RATE_LIMITER` binding.
- `PUBLIC_ORIGIN` must be the public HTTPS application origin. The provider must be able to reach `/webhooks/replies/*` without an interactive login, Cloudflare Access login or challenge.
- A saved shop reply configuration with enabled scripts matching the provider. No browser configuration is silently copied into another shop.
- The deployed Worker must retain its cron trigger. Webhooks durably enqueue before acknowledgement; `waitUntil` dispatches promptly and cron recovers queued work.
- Tokens remain encrypted in the existing channels store. Do not place them in webhook payloads, logs, screenshots or setup documents.

## Telegram

Connect a Telegram bot and the intended private chat, group or supergroup using the existing channel connection flow. Telegram broadcast channels are unsupported. The bot must have the provider permissions and visibility needed to receive messages in the chosen chat; the application cannot grant Telegram membership or adjust BotFather privacy settings.

Explicit activation calls `getMe`, `getChat` and `getWebhookInfo`, checks the immutable chat identity, then sets the bot webhook to:

`PUBLIC_ORIGIN/webhooks/replies/telegram/{botId}`

The `secret_token` is derived server-side using HMAC-SHA256 with `SOCIAL_TOKEN_KEY` and `reply-telegram:{botId}`. Never hand-write a customer-facing token. A bot with a webhook owned by another integration is rejected; the application does not overwrite it. Disabling automatic replies stops local dispatch but leaves the provider webhook in place. Uninstall or move the bot through an explicit operator-controlled provider configuration change when needed.

Only messages addressed to the connected chat can trigger dispatch. Telegram replies use that same chat ID and the received message ID; there is no arbitrary recipient field. Bot messages are ignored. One provider/chat target can be active in only one shop.

## Facebook Page Messenger

These steps require the operator's Meta app dashboard and appropriate Page/app authority. They are external prerequisites, not actions silently completed by deployment.

1. Configure the app's Page webhook callback as `PUBLIC_ORIGIN/webhooks/replies/meta`, with the same verify token stored as `META_REPLY_VERIFY_TOKEN`.
2. Configure Page messaging webhook fields `messages` and `messaging_postbacks`, and complete the applicable Meta app/permission requirements for the intended Page and users.
3. Configure Worker secrets `META_APP_SECRET` and `META_REPLY_VERIFY_TOKEN`, and variable `META_APP_ID`. `META_GRAPH_VERSION` defaults to `v26.0` to match the existing integration.
4. Connect/reconnect the Page with both `pages_messaging` and `pages_manage_metadata` permissions. The existing publishing OAuth fallback does **not** request these permissions. Use the configured `META_LOGIN_CONFIG_ID` business-login configuration with the required permissions, or explicitly update the OAuth permission flow before expecting Messenger activation to succeed. Publishing access alone is insufficient.
5. Set `META_REPLY_WEBHOOK_READY=true` only after the dashboard callback and field configuration have actually been completed. This flag is an operator attestation; the application cannot inspect the app dashboard.
6. Explicitly activate the individual Page in Reply Scripts. The server validates the Page token's app ID and required scopes with `debug_token`, verifies the Page identity, and requests the Page subscription to the configured messaging fields. Missing permissions or readiness remain visible blockers.

Inbound POST requests require a valid `X-Hub-Signature-256` HMAC over the original request bytes using `META_APP_SECRET`. Messages must name the connected Page as recipient; echoes are ignored. Outbound requests use `messaging_type: RESPONSE` and are limited to a matching inbound message received within the preceding 24 hours. This implementation does not send promotional or unsolicited messages outside that window.

## Safety, recovery and access

- Payloads are capped at 1 MiB and 50 Meta events per request. Old messages, invalid signatures/secrets, wrong recipients, bot messages and echoes do not trigger replies.
- Events deduplicate by channel plus provider event ID. A compare-and-set claim and per-conversation lock prevent duplicate workers from delivering the same event.
- Credentials, channel opt-in, shop status, conversation state and configuration revision are checked again before sending. Reconnecting a channel invalidates its old credential fingerprint. A configuration revision that changes during matching causes the stale reply to be skipped.
- A rejected or interrupted send is conservatively `unknown` if provider delivery may have occurred. Unknown events are never retried automatically. Stale `processing` events become `unknown`; cron processes only `queued` events.
- Provider text limits are checked before send: Telegram 4096 characters and Messenger 2000 characters. Oversized expanded replies fail with `response_too_long`; there is no automatic chunking.
- Handoff pauses the actual conversation. Close marks it closed. Tags update the stored conversation. Unknown delivery of a handoff response still leaves the conversation paused for a human.
- Owners/managers can read and assign all shop conversations. Support can read/update only conversations explicitly assigned to them. Content/viewer roles do not receive private conversation bodies. Reports expose aggregate counts and response timing only.
- Response metrics are based on stored inbound/outbound messages; empty timing samples are null. There are no fabricated views, satisfaction scores or historical provider-message imports.
- There is currently no manual send API. The inbox supports reading, pause/status/tag updates and assignment; this does not imply an agent-composer send capability.
- Automated tests use real SQLite and mock only external provider calls. They do not configure real provider webhooks or send messages to actual customers. Any live customer message requires a separately authorized recipient and exact content.

Run local verification with `node --test backend/test/reply-messaging.test.mjs` and the repository's full test/build checks. Actual provider delivery, app review and external dashboard configuration remain unverified until deliberately tested against an operator-controlled recipient.
