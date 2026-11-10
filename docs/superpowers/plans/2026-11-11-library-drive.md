# Library Google Drive Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the disabled Drive import with real OAuth, listing and selected-file import.
**Architecture:** A separate Drive module behind existing authenticated same-origin Worker routing, with encrypted credentials in D1 and browser-local asset storage.
**Tech Stack:** Workers, D1, Google Drive API v3, existing vanilla UI and Node tests.
**Spec:** docs/superpowers/specs/2026-11-11-library-drive.md

## Global Constraints
- Keep YouTube grants and routes unchanged. No token reaches browser, logs or repository.
- Imports are browser-local, max 50 MiB/file, no background import or Drive mutation.
- Separate per-shop owner/manager connect privilege and content import privilege.

## Review Focus
- State replay, wrong actor/shop, disconnect during OAuth or refresh.
- Revoked credentials and incomplete OAuth grants must not show connected.
- Large files, unknown sizes, redirects and Workspace export errors.
- Shop switching during import must not save into the next shop.
- Duplicate selection, interrupted import and stale connection status.

### Task 1: Drive API
- [x] Write backend tests for status/configuration, OAuth, state replay/actor/shop isolation, list/search/pagination, download/export, limits and revoked access.
- [x] Run tests RED, add backend/src/drive.js and authenticated /api/library/drive/ routing, run tests GREEN.
### Task 2: Library UI
- [x] Add UI tests for configured/unconfigured status, connect, selected-file import and shop switching.
- [x] Wire production Drive card to API, render file chooser with pagination and search, import selected bytes via makeAsset, keep demo branches intact.
- [x] Run full npm test and npm run build; inspect changes; publish a draft PR with live configuration limitations.

## Verification and decisions
- Native execution in isolated feature branch under existing autonomous implementation authorization.
- Final reviewer found three important UI issues (cancel deadlock, Escape/backdrop cancellation, unverified metadata persistence); regression tests were added, observed RED, and fixed GREEN.
- Final checks: npm test 232/232; npm run build passed; git diff --check passed.
- Google Drive is implemented first; other providers remain disabled. Drive access requires account-holder consent.
