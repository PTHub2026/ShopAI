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

## Production verification and remaining gates

PR #87 was merged as `b5559af9dc331ed0498302d2120654003bae3735`; backend CI and CodeQL both succeeded. Cloudflare showed version `01f5e498` Ready with 100% traffic.

Production UI checks confirmed:
- All four existing Facebook posts display explicit missing-read-permission results, preserved after navigating away and returning.
- The 390px calendar is a vertical date agenda without horizontal page overflow.
- Shop settings correctly inherit ShopTrack / shoptrack.vn from the existing chatbot settings.
- Feedback creation succeeded on the server; the remaining provider gates were recorded as a real feedback item for the selected shop.

Zalo's existing OA secret was saved encrypted as `ZALO_OA_WEBHOOK_SECRET` in the existing production Worker. The webhook route was briefly changed to `https://shoppost.net/webhooks/replies/zalo` for setup testing. Reauthorization then failed with Zalo `-14068` / `User don't own any Official Accounts`; the connected OA token is expired.

Final state: the webhook URL was **restored** to `https://shoptrack.abacusai.app/webhook/zalo`, and `ZALO_REPLY_WEBHOOK_READY=false`. This preserves the existing routing until the correct OA administrator can reconnect and the ShopPost binding can be activated. Do not reset the OA secret. The first restoration check timed out (408); the second passed and the restored URL was verified in Zalo's UI.

Meta still denies interaction reads for the four existing posts. Live incoming/outgoing messaging and a new live publication are not yet accepted end to end. Automated provider tests are simulated and are not evidence of production delivery.

Zalo's developer console also warned that both Cloudflare URLs resolve outside Vietnam and some returned data may be restricted.
