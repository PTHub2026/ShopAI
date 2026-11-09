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

## Follow-up production verification and automatic review
- PR #25 merged as 5ef0977a07a89516e3e81a395962a3dadbd57581. Cloudflare build ready; live /health matches this release, version 548fb439-899c-4aa4-9dda-1d640330f483. Authenticated channels UI loads with no console errors; real long-poll requests return OK. Anonymous channel and job-event GETs return 401.
- Automatic review found three additional issues, each reproduced RED then fixed: cloudRequest discarded idempotency headers; immediate retryable posts lost the job ID; an OAuth callback already exchanging tokens could restore a disconnected channel.
- Preserve custom headers and combine cancellation with timeout. Persist Zalo draft keys, retain common job IDs for immediate outcomes, and run/retry tracked posts through their existing job. Unknown outcomes stay visible for reconciliation.
- Add durable disconnect generation bound into the signed connect cookie. Atomic conditional credential INSERT checks generation, so a callback paused during unlink cannot restore credentials afterward.
- Actual Cloudflare settings showed no Cron trigger despite the repository declaration. Added every-five-minute trigger in the dashboard. Persisted logging was disabled after deployment; enable observability in Wrangler configuration to retain it on releases.
- Follow-up validation: **147 tests pass**, Wrangler dry-run build succeeds. Includes tests for lost idempotency header, immediate rate-limit reconciliation, in-flight callback unlink, and running an existing scheduled job only once.
- Automatic approval review blocked a proposed unauthenticated DELETE production smoke test because it targets a destructive endpoint. Did not retry it. Used read-only authenticated UI/anonymous GET checks; unlink behavior is verified against SQLite in automated tests.
