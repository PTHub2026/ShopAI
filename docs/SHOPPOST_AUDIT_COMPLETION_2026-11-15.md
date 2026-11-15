# ShopPost audit implementation — 2026-11-15

## Delivered in this change

- Meta engagement results, errors and pending requests survive navigation, isolated by shop.
- Canonical shop brand/signup settings also supply chatbot preview and delivery. Legacy chatbot values remain the fallback until a valid canonical profile exists. Shop selector includes a short ID.
- Facebook/Zalo manual inbox replies use server-selected recipients, role/assignment checks, recent inbound checks, atomic reservations and durable idempotency. Ambiguous delivery is never automatically resent. Human takeover pauses the bot.
- Channel diagnostics list missing configuration names and callback/event evidence without credentials.
- Posts/history use date ranges, server filters and keyset pagination. Calendar queries its displayed period. Background updates preserve appended pages.
- Mobile calendar uses a vertical date agenda and compact, wrapping controls.
- Feedback is stored per shop on the server with revision conflict checks. Unfinished input survives refresh; shop changes clear it.
- Owner/manager server export pages through settings, chatbot, feedback, drafts, library metadata, publish history and sanitized channels. Export excludes credentials, original file bytes and customer conversations. It is a paged export, not a transactionally consistent full restore snapshot. No server restore is implemented.

## Verification

`WRANGLER_SEND_METRICS=false npm run check`: 353 tests passed and Wrangler dry-run build passed.

Coverage includes signed webhook rejection/acceptance, automatic response processing, manual reply permissions/idempotency/uncertain outcomes, atomic lock rollback, shop isolation, feedback conflicts/export permissions, history pagination beyond 200 rows, and frontend regression cases.

Provider requests in automated tests are simulated. They do not prove live outbound delivery or publishing to production accounts. Live acceptance must distinguish provider test events, real incoming conversations, actual outgoing provider message IDs, and actual published URLs.

## Runtime configuration completed separately

Existing Zalo app webhook URL before this task: `https://shoptrack.abacusai.app/webhook/zalo`.

Updated to `https://shoppost.net/webhooks/replies/zalo`, with the existing OA secret saved as encrypted `ZALO_OA_WEBHOOK_SECRET` in the existing production Worker and `ZALO_REPLY_WEBHOOK_READY=true`. Existing Zalo `user_send_text` subscription and retry setting were already enabled.

Zalo's configuration UI warned that the Cloudflare URL resolves outside Vietnam and some returned data may be restricted. Its developer test event uses a sample recipient OA, so it cannot by itself establish delivery for the connected ShopTrack-CSKH OA.

Rollback of webhook routing, if needed, is to the former URL above; do not reset the OA secret. Cloudflare retains existing runtime secrets through `keep_vars=true`.
