# ShopPost: follow-up to shop-scoped storage and calendar

Baseline: PR #84, b744512. Library folders, metadata and original files are scoped to the shop, shared across its projects, with a 50 MiB per-file limit. Legacy assets require explicit assignment; do not automatically migrate them into the current shop.

This change uses the same server queue snapshot for the managed Posts list and Calendar. Each row represents one channel delivery, with the existing 200-most-recent limit. Navigation, focus and job reconciliation refresh both screens. Server rows do not expose local-history mutation controls, which cannot cancel or modify a server job. Local demo behavior remains separate.

Invitation expiry, shop creation and admin audit timestamps now convert API seconds to browser milliseconds. Draft timestamps remain unchanged. Library copy explains shop/project scope, old-data recovery and the per-file limit.

Remaining acceptance work: Meta read permissions and live messaging, server-synced groups/hashtags/settings/feedback, independent-device and role-matrix testing, provider end-to-end delivery and load testing. This patch does not claim those capabilities are complete.

Release validation: run npm test, npm run build and GitHub CodeQL. After deployment, check /health commit on both domains, compare Posts and Calendar for the same shop, switch to a shop without jobs, and verify invitation/admin dates. Do not publish content or change account permissions as part of this read-only production smoke test.
