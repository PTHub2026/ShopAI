# ShopPost UX completion Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task by task.

**Goal:** Complete clear, consistent and truthful UI flows across ShopPost without rebuilding its backend.
**Architecture:** Preserve index.html and existing routes; introduce common screen layout/accessibility treatment, then fix scoped screen behavior and semantics. Integrate isolated worker commits and review each task, then verify the whole app in the browser.
**Tech Stack:** Existing HTML/CSS/JavaScript, Cloudflare Worker, D1, Node test/JSDOM.
**Spec:** docs/superpowers/specs/2026-11-10-shoppost-ux.md

## Global Constraints
- Preserve backend endpoints, shop permissions, scopes, OAuth, idempotency and drafts.
- Do not publish, disconnect, grant permissions or change real business data during verification.
- Reuse the selected option 2 visual direction and existing product design system.
- Keep offline demo behavior, but never label local/demo data as confirmed platform data.

## Review Focus
- Changing shops or routes while requests are pending must preserve the active draft and page.
- Local history deletion must not imply remote deletion or cancel scheduled jobs silently.
- Unsupported capabilities must not show fake live controls or zero analytics as verified results.
- Modal open/close, Escape, labels and tab focus must remain keyboard usable.
- Narrow screens must retain controls without horizontal viewport overflow.

### Task 1: Posts and calendar semantics
Files: index.html postCard/filterBar/V.posts/V.calendar/delPost; frontend tests.
Interfaces: existing S.posts, channels, socialRequest, applyPublishJobs and modal helpers unchanged.
- [x] Add regressions for no fabricated metrics, local delete warning and unknown/processing status filtering.
- [x] Clarify history vs remote publication, preserve unknown result handling, show safe result links.
- [x] Improve empty histories and schedule controls using clear Vietnamese and action-specific labels.
- [x] Run relevant frontend tests; commit; task review.

### Task 2: Capability truth and workspace screens
Files: index.html V.analytics/V.inbox/V.response/V.bot/V.groups/V.hashtags/V.settings and tests.
Interfaces: managedApp(), existing V routes and backend contracts unchanged.
- [x] Test unsupported managed capabilities and keep offline demo working.
- [x] Make analytics/inbox/response unavailable states explicit with useful navigation; label local bot preparation and avoid pretending it is enabled remotely.
- [x] Improve group/hashtag/settings empty/help text and labels without changing persistence.
- [x] Run relevant tests; commit; task review.

### Task 3: Shared visual and accessibility foundation
Files: index.html CSS/render/modal helpers/screen metadata; tests.
Interfaces: screen metadata helper applied after synchronous/asynchronous rendering, preserving node identity and inputs.
- [x] Give every route a clear screen title, purpose and consistent action hierarchy.
- [x] Normalize form accessible names, modal roles/focus/return focus and meaningful empty states.
- [x] Make existing inline grid layouts, toolbars, tables and calendars usable at narrow widths.
- [x] Preserve draft state on re-renders and never trigger external writes from design decoration.
- [x] Run full test suite/build; commit; task review.

### Task 4: Whole product review and deployment
- [x] Review all task changes and required checks; fix important findings.
- [ ] Merge reviewed PR after CI succeeds, verify Cloudflare release.
- [ ] Visit all routes, inspect representative screenshots and primary safe interactions; compare account/channel target with implementation.
- [ ] Save design-qa.md with actual evidence, intentional differences and honest limits.
