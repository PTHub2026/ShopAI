# ShopAI release sequence

User authorized completion in order: align deployment, fix/verify AI, verify D1, then real channel integrations.

## Decisions and evidence
- Continue reviewed PR #6 instead of duplicating its cloud storage implementation. Local base d025edb maps to remote 061b182; compare blobs before uploading.
- Baseline 45/45 tests passed. Authenticated preview /session returns release 061b1824e551ecdd9e56f2cd973422dca631c26e; AI and drafts bindings present.
- Preview cloud save succeeded, revision 1; GET storage and a second UI tab read it. No customer data used.
- AI generate/reply return HTTP 502. Configured llama-3.1-8b-instruct was retired May 30 2026 (Cloudflare changelog). Use currently supported gemma-4-26b-a4b-it with completion output normalization. Preserve Access and no mock fallback.
- New regression failed 502 != 200 before repair; full suite after repair 47/47 plus dry-run passed.

## Remaining gates
- [ ] Deploy preview model fix, verify generate/improve/adapt/reply in UI.
- [ ] Merge reviewed release and align production build branch only after functional verification.
- [ ] Create separate production D1; apply existing schema and verify cloud save/open.
- [ ] Connect official channel APIs only with verified app credentials/scopes. No simulated success or unsolicited messages/posts.
- [ ] Record exact final deployment, tests and blockers.
