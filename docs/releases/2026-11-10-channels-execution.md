# Channels implementation ledger — 2026-11-10

Plan: user supplied eight tasks, three phases.

## Evidence
Cloudflare production Observability (10 Nov, Asia/Ho_Chi_Minh) shows cron invocations at 04:00:58, 04:05:58, 04:10:58 failing with "Handler does not export a scheduled() function". Logs already enabled. Source worker exports scheduled, deployed entry app.js does not forward it. No evidence yet attributing all 95 historical errors to token expiry.

## Phase 1
Added regression tests: missing deployed scheduled handler, missing DELETE Zalo, token SELECT. Watched all three fail before implementation. Forwarded scheduled, added transactional disconnect/invalidation/audit, removed token read from channel listing. Runtime failures logged as structured codes without credentials.

Ruling: preserve existing 5-minute trigger; fix deployed handler rather than creating duplicate triggers.

## Phase 2
- Canonical credential store: `channels` (provider, external_id, encrypted token, status). Runtime upgrade and migration 0012 copy both old credential formats without decrypting or losing IDs. A durable marker prevents reimport after unlink. Legacy source tables remain recovery snapshots; explicit Zalo unlink also removes its old source row.
- Common API: `/channels/{provider}/accounts`, `/publish`, `/schedule`, `/jobs`, `/jobs/:id/retry`; `all` provides aggregate accounts/jobs/providers. Zalo OAuth connect/callback retained. `/api/social/*` remains a compatible alias into the same store and engine.
- Common `publish_jobs` for Zalo/Telegram/Facebook/Instagram. Provider validation and publishing dispatched by adapters. Existing 5-minute trigger runs the shared queue. Legacy scheduled metadata receives result ID/URL/error from common jobs.
- New jobs snapshot external target. Legacy schedules are imported before an OAuth replacement so they retain their original OA. A target change fails the job rather than publishing to a different OA.

## Phase 3
- Authenticated, shop-scoped long-poll `/channels/{provider}/jobs/events?cursor=...&wait=20`. Cursor hashes metadata; no content or credentials returned. Membership rechecked while waiting. Browser cancels on shop change/hide/page exit and updates history without replacing typed form content.
- Shared exponential backoff with jitter and provider retry_after minimum, maximum five attempts. Explicit 429/pre-send contention may retry. Ambiguous network/create/verify results stay unknown and are not replayed. Cron processes due retries.

## Final review and verification
- Fresh read-only reviewer found one Important issue: legacy schedules initially took their target at first cron, allowing an intervening reconnect to change destination. Added failing regression, imported before replacement, verified green.
- Additional regression verifies unified Zalo account deletion invokes full unlink/invalidation.
- `WRANGLER_SEND_METRICS=false npm run check`: **143 tests passed; zero failed; Wrangler dry-run build succeeded**.
- Tested: migration preserves encrypted credentials/IDs and cannot resurrect unlink; shop isolation and permissions; concurrent cron claim; Zalo token rotation/reconnect race; common scheduled delivery; rate-limit backoff; no retry after uncertain send; feed cursor/isolation; editor preserved during feed updates; built entry exports scheduled.
- Live provider posting is not used as a smoke test because that would publish content on real accounts. Production acceptance still requires observing the deployed release and next cron invocation.

Ruling: keep old API aliases and encrypted credential formats during migration to preserve existing OAuth integrations; all active reads/writes use the canonical store.
Ruling: select the requested long-poll alternative; backend waits up to 20 seconds, frontend stops when hidden or shop changes.
