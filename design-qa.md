# ShopPost design QA — 10 November 2026

**Result scope:** redesigned desktop UI and safe interaction flows across 17 managed screens. This is not certification of every backend integration or a mobile-device audit.

## Findings and comparison history

- **Resolved P2 — excessive outer channel container and weak page title.** Initial PR44 comparison (`account-ux-comparison.png`) showed an extra card around the workspace and a smaller title than selected option 2. Removed the outer border/surface and set the channel title to 32px. Post-fix evidence: `ux-final-design-comparison.png`, `ux-final-controls-comparison.png` and `ux-final-accounts.png`. The page now has a clear heading/action/tab/row hierarchy.
- **Resolved P2 — inaccessible nested and repeated controls.** Live DOM inspection found unnamed password inputs, composer channel selectors, per-asset selectors and video scene textareas. Explicit password label associations and contextual channel/asset/scene names were added in PR46, including adjacent scene duration inputs. Post-deploy DOM checks of settings/create/library/video found no visible unnamed form fields. Post-fix screenshots: `ux-final-settings.png`, `ux-final-video.png`; rendered regressions cover both library views and escaping.
- **No remaining actionable P0/P1/P2 observed in the desktop review.** Mobile and tablet visual behavior remains unverified and is a test gap, not a claimed pass.

## Source and implementation evidence

Evidence root (internal captures, not committed because they contain account and business content): `/workspace/scratch/89e1bf2b1070/`.

Source visual truth: `/workspace/scratch/89e1bf2b1070/generated_images/exec-c75236c7-9a79-466f-b362-4c1de6fac16a.png` — selected option 2, 1374×1145 pixels. The selected concept establishes the white workspace, violet navigation, black primary action, account dropdown, connected/available tabs and per-channel management.

Implementation: https://shoppost.net/. PR45 introduced the whole-screen update; PR46 completed the names found during live QA. Verified application release: `39e948e50ecd88c573c12b4c8d0ca147dedadcb3`, Cloudflare version `a5d3e3b4-7255-4bbd-83b0-7e2ad7bbde09`; `/health` reports configured and storageConfigured true.

Full-view combined comparison: `ux-final-design-comparison.png` contains the source and actual channel view together. Focused combined comparison: `ux-final-controls-comparison.png` shows heading, primary action, tabs, provider row, management and disconnect action together at readable size. Both images were opened and inspected; they are not comparisons inferred from code.

Additional before/after comparisons opened: `ux-compare-create.png`, `ux-compare-library.png`, `ux-compare-ai.png`. Original settings capture was scrolled differently, so its before/after pair is supporting evidence only, not a pixel-fidelity claim. Representative implementation screenshots inspected: `ux-after-posts.png`, `ux-after-calendar.png`, `ux-after-analytics.png`, `ux-after-bot.png`, `ux-after-settings.png`, `ux-final-video.png`, `ux-final-accounts.png`.

### Viewport and normalization

The connected Chrome viewport varied between 1172×971 and 1187×983 CSS pixels during the user's session. Matching screenshot pixel dimensions indicate 1 image pixel per CSS pixel for these captures; devicePixelRatio was not independently verified. `ux-final-account-menu.png` is 1187×983. PR45 create/library/AI/settings/calendar captures are 1172×971; posts/accounts/analytics/bot captures are 1187×983. Source density is unknown because it is a generated concept.

Combined images preserve aspect ratio and fit each full screenshot into equal display-width bounds; they are layout comparisons, not exact pixel overlays. Focused crops align the content heading, tabs and management regions. Sidebar scroll position, live timestamps and the number/order of account rows differ and are excluded from pixel-level judgment. Attempts to set a mobile viewport returned success without changing the actual Chrome dimensions; the override was reset. No mobile/tablet screenshot or full mobile accessibility pass is claimed.

## Required fidelity surfaces

| Surface | Observed result |
| --- | --- |
| Fonts and typography | Existing sans-serif stack retained; clear 28px screen titles and 32px channel title, readable body/help hierarchy and consistent button weight. Selected concept does not specify a font file, so exact family matching is not claimed. Visible Vietnamese wraps without collisions at tested widths. |
| Spacing and layout | Consistent page heading, explanatory copy, action groups, white cards and restrained borders. Channel outer frame removed after comparison. Existing sidebar width and route structure retained. Tables scroll within their containers rather than expanding the viewport. |
| Colors and tokens | Violet navigation/focus, black primary actions, quiet secondary controls, pale green confirmed connections and red disconnect treatment preserve the approved direction and semantic distinctions. No new decorative gradients introduced by this UI update. |
| Image quality and assets | Real user media preserved. Provider logos use the attributed official Simple Icons assets; caret asset uses Phosphor. No replacement brand imagery was drawn. Mockup chrome and illustrative provider styling were not copied as fake account data. |
| Copy and content | Action labels state the action: connect/add/reauthorize/disconnect, create folder, compose, save feedback. Local settings, browser library, history and simulations are identified. Unavailable live analytics/inbox/reply integrations do not display fabricated metrics or working connection controls. |

## Intentional product differences from the concept

- Connected tab contains only confirmed linked accounts; unconnected providers appear under Available. The concept showed both in one selected tab.
- At most one per-channel management menu opens; the concept had two open simultaneously.
- Retained the existing sidebar, shop selector and safe connection/publishing tools instead of replacing application navigation.
- Included a refresh control and timestamp so connection state has a visible source/update context.
- Preserved existing backend capability limits. The redesigned UI does not make Zalo ownership, analytics, inbox, cloud-drive import or automatic replies available by itself.

## Browser and interaction verification

Visited all 17 existing navigation routes after deployment: create, video, ai, library, posts, calendar, analytics, inbox, response, bot, accounts, groups, hashtags, settings, members, feedback and admin. Each exposed the expected screen heading. DOM checks found no document horizontal overflow at the tested desktop width.

Safely exercised account disclosure and Escape, both connection tabs, per-channel management menus, Connect channel navigation to available providers, library Add text dialog opening/cancellation, initial input focus, Shift+Tab wrap to the final dialog action, Escape dismissal and focus return. Existing composer text/media remained present across navigation and reload. Real publication, disconnection, credential changes and external grants were not performed for verification.

Console: Chrome error/warning log reads returned an empty list after the route walkthrough and again after the final fix checks. This covers the observed session, not all possible runtime requests.

## Automated verification

- `npm test`: 216 passed, 0 failed.
- `npm run build`: production Wrangler dry-run passed.
- `git diff --check`: clean.
- GitHub PR45 and PR46 required backend checks: success before merge.
- Whole-change review: no critical or important regressions. Scoped review of live-QA fixes: all four findings addressed, no new important breakage.
- The 17-route render test asserts clear screen hierarchy and zero writes. Canvas drawing is mocked in JSDOM because it checks navigation and decoration, not video rendering.

## Residual test gaps and P3 polish

Mobile/tablet rendering, screen-reader end-to-end operation, comprehensive contrast measurement, video export across browsers and provider-side posting are not established by this design QA. Existing AI planning actions have not all received the same async guards as the edited generation/rewrite paths. Longer nested controls may benefit from future plain-language copy refinement; no observed desktop collision blocks use.

## Implementation checklist

- [x] Apply selected visual direction and consistent screen hierarchy.
- [x] Clarify account versus channel operations and actual connection state.
- [x] Preserve drafts, safe publish-history semantics and output-bound AI selection.
- [x] Label nested/repeated controls; verify safe dialog and menu interactions.
- [x] Pass tests/build/reviews and deploy to the actual application.
- [x] Inspect combined source/implementation and representative desktop screens.
- [ ] Verify real mobile/tablet layouts in a browser capable of changing its viewport.

final result: passed
