# ShopPost interface design specification

User authorizes autonomous redesign and deployment of all screens, using Product Design and the selected option 2 as the existing visual target.

- Keep the existing violet navigation, white surfaces, readable typography, one clear primary action per task and separate account session from channel grants.
- Use plain Vietnamese, action-specific buttons, clear scope (browser-local/server/platform), truthful loading/error/empty states and no fabricated success or metrics.
- Preserve existing backend endpoints, shop isolation, permissions, OAuth, token handling, idempotency, draft protection and user data. Never publish, disconnect or grant access while testing.
- Cover create, video, AI, library, posts, calendar, analytics, inbox, response, bot, accounts, groups, hashtags, settings, members, feedback and admin.
- Retain offline demo workflows. In managed mode unsupported inbox/analytics capabilities must be explicit rather than appearing live.
- Preserve the existing single-file frontend architecture for this pass. Use common screen metadata/layout/accessibility helpers rather than duplicate new page implementations.
- Match approved account/channel hierarchy; correct inconsistent mock states (unconnected providers belong to Available tab; one management disclosure open at a time).
- Public app changes deploy through reviewed PR/CI and Cloudflare. No secrets in git; no visibility changes or destructive DB operations.
