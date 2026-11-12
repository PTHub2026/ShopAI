# Live Replies Implementation Plan

Goal: real server persistence and execution for reply scripts, with authenticated messaging ingestion and an audit of every screen.
Architecture: reply configuration/matcher module, separate messaging ingestion module, managed-mode frontend; existing authentication, permissions, encrypted channels and D1 reused.
Spec: docs/superpowers/specs/2026-11-11-live-replies.md

1. Implement /api/replies/config GET/PUT and /preview POST, typed bounded configuration, revision conflict, shop isolation and matcher. Test RED→GREEN using sqlite fixture.
2. Implement incoming Telegram/Meta adapters, per-channel activation, deduplication and real conversation/outbound state. Validate auth, revoked token, duplicate delivery, human handoff and uncertain delivery.
3. Wire the Bot screen to backend CRUD/preview/settings/activation; keep safe empty and failure states and preserve draft on errors.
4. Audit every route and button handler in source and browser; repair independently demonstrated defects and run all required tests/build.
5. Review whole change, deploy, live-create and update a disposable script; preview without external sends; verify reload/shop isolation and report platform blockers.
