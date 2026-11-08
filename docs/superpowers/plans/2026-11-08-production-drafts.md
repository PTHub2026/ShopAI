# Production Drafts Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. The user authorized continuous execution.

**Goal:** Connect authenticated cloud drafts and prevent simulated results on the server application.

**Architecture:** Extend the existing Worker and D1 API; keep explicit cloud save/open controls and separate local caches per authenticated user. Preserve the offline demo.

**Tech Stack:** JavaScript, Cloudflare Workers/D1/Access, Node test runner, SQLite, jsdom, Wrangler.

**Spec:** docs/superpowers/specs/2026-11-08-production-drafts-design.md

## Global Constraints

- JSON limit 32768 bytes; draft content limit 20000 characters; channels at most 32.
- Preserve JWT verification and owner isolation; never bind production to the preview database.
- No cloud operations in QA; no simulated publishing on the server application.
- No secrets in browser, repository, logs or PR.

## Review Focus

- Account changes cannot reuse another user's local cache or cloud revision.
- Simultaneous saves must conflict rather than overwrite.
- Expired sessions, invalid JSON and unavailable DB never report a save.
- Responses after typing/navigation cannot replace the current editor.
- Drafts beyond the first page remain reachable without duplicate pages.

### Task 1: Authenticated storage contract

Files: backend/src/worker.js, backend/src/drafts.js, backend/test/storage.test.mjs.
Interfaces: GET /session -> userScope/capabilities; GET drafts -> drafts/nextCursor; GET draft by id -> draft/revision/updatedAt; PUT draft -> same.

- [x] Write failing tests with real SQLite: owner isolation, revisions, invalid payloads, unavailable DB, pagination and per-id retrieval; add JWT/session/page scope regressions.
- [x] Run tests and verify expected failures.
- [x] Implement minimal handlers and stricter draft validation; render user scope after verifying subject.
- [x] Run the full suite and commit.

### Task 2: Explicit cloud save/open and honest runtime

Files: index.html, backend/test/cloud-frontend.test.mjs, package.json/package-lock.json.
Interfaces: cloudSaveDraft(), cloudListDrafts(cursor), cloudOpenDraft(id), cloudRequest(path, options); managedApp()/demoAction() and APP_SCOPE isolate state.

- [x] Add jsdom tests loading the real HTML for empty managed boot, local account isolation, cloud save/open, conflicts, pending edits/navigation, non-JSON/session errors, unsupported payloads, QA and disabled simulated actions.
- [x] Run tests and verify missing behavior.
- [x] Implement UI controls with an accessible status; retain local draft when errors occur; fetch capability status without uploading data.
- [x] Run full suite and commit.

### Task 3: Release checks and evidence

Files: backend/READINESS.md, backend/D1_PREVIEW.md, README.md, .github/workflows/backend-checks.yml.

- [x] Lock Wrangler, run npm test and build dry-run, and exercise local Worker/D1 without touching remote data.
- [x] Update CI to include main and reproducible installs; document exact evidence and blockers.
- [x] Review the whole diff, fix important findings with regression tests, and create a PR anchored to main if main has not moved.
- [ ] Deploy and verify the authenticated preview only if the Cloudflare session becomes available; otherwise return the concrete login blocker and completed PR.
