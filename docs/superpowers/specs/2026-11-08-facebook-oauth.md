# Facebook OAuth connection — stage 4 prerequisite

Reuse Meta ShopAI app 1690219679401963. First delivery is authenticated OAuth connection and Page inventory; it does not enable publishing, schedules, inbox or automatic replies. Those depend on an authorized Page and separate end-to-end verification.

- Server-only code exchange. Explicit same-origin POST starts authorization; random one-time state is hashed in D1, bound to verified Access subject and fixed callback origin, expires in 10 minutes.
- Callback verifies state, app ID, user token validity and granted scopes with Meta before loading Page inventory. No token or provider error details reach client, logs or repository.
- Page tokens encrypted AES-256-GCM with fresh nonce and owner/Page binding as authenticated additional data. Cloudflare secret holds encryption key; D1 stores only ciphertext.
- Every channel query scoped by authenticated Access subject. Existing stale connections are disabled when refreshing inventory. List API excludes secrets. Local UI never treats cached/demo channels as real.
- Feature off unless explicit enable flag, HTTPS application origin, App ID, App Secret and 32-byte encryption key are configured. No credentials added to source.
- Graph API v27.0 confirmed in official Meta documentation on 2026-11-08. Facebook Login for Business config ID supported only with explicit operator verification/declaration that its sole scope is pages_show_list. This release requests only pages_show_list; broader publishing/Messenger scopes are deferred.
- UI explains permissions before redirect. Connecting a Page does not post or send messages. Other platforms retain explicit unavailable status.

Verification: real SQLite schema plus deterministic Graph fixtures cover missing config, same-origin gate, state expiry/owner/replay, wrong app/token/permissions, pagination, ciphertext and account isolation, wrong app, expired token, denied permission, disconnect and frontend escaping. Batch rollback/later-page failure, malformed pagination and stale OAuth-start responses remain coverage gaps tracked in FACEBOOK_SETUP.md. Cloud verification requires real app configuration and user OAuth grant.

Official sources read in authenticated browser:
https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/
https://developers.facebook.com/docs/pages-api/posts/

Live prerequisites observed: app development mode; pages_show_list and pages_manage_metadata ready for testing; pages_manage_posts and pages_read_engagement not yet added. Do not publish app or grant Page data access without the user's confirmation at the actual grant step.
