# BFCM Creatives module

## Privacy and architecture

This public source contains generic application code only. Brand identities, contract quantities, copy banks, research evidence, source-sheet identifiers, reference assignments and private seed SQL must remain in private storage, never in Git.

Each `bfcm_plans.config` is private JSON data with this shape:

- `brand`: `{slug,name,cap,aliases,contract}`; contract is exact category quantities, grouped static/motion caps, or flexible.
- `initialCopies`: exactly 30 `{id,text,source}` rows; source is `BF anterior`, `Recente`, or `Nova`, reflecting actual provenance.
- `motionReferences`: exactly ten `{id,title,category,format,thumbnailUrl,videoUrl}` preview references.
- `websiteFacts`: source URLs with verified facts and constraints, passed only server-side to generation.
- `sourceNotice`: concise source-coverage notice, without spend/metrics/evidence UI.

One-time private imports are idempotent by slug/source key. No Sheet polling, recurring sync or automatic ordinary-brand creation exists. Unlinked module plans remain independent from existing CRM brands.

## Security

Existing authentication, projects/offers and legacy copy-generation functions remain unchanged. New tables only: plans and append-only lock versions. Brand foreign keys use `ON DELETE SET NULL`, preserving existing delete flows.

Staff reads require `profiles.id = auth.uid()` and `can_edit`. All writes use the existing server service client after per-action authorization; direct anonymous/authenticated writes and RPC execution are revoked. Compare-and-swap saves reject conflicts. Client-supplied approval/status/history are not authoritative.

An explicit staff action may mint/rotate a module-only 256-bit capability; only SHA-256 is stored. No link is minted on mount or sent to a client. Token resolution scopes every read/write to one plan. Revocation invalidates prior links. Client responses are private/no-store/no-referrer/noindex.

AI generation uses the existing Gemini key/model, actual current offers and verified private website facts, preserving hypercare restrictions. Missing keys/provider failures are visible and never disguised as successful generation. Atomic per-plan cooldown limits billable calls. New copies remain unapproved until explicit human confirmation. Offers/copy edits revoke approval; final lock and reopen require explicit confirmation.

## Deployment and verification

Apply the generic additive migrations only after review. Private configuration/seed data is managed separately through an approved database operation; do not publish it here. Ensure all planned records and valid configs exist before release.

Required live checks: RLS/direct-write denial, token isolation/revocation, atomic conflict behavior, persistence after reload, immutable locked versions, existing app navigation and client routes. A preview-only fictional fixture may test layout without real client data or an auth bypass; it must return 404 in production.

Local implementation checks: build/TypeScript and focused lint passed before the privacy refactor; rerun for the final candidate. Full-repo lint has pre-existing errors in generated PDFjs and older components; compare baseline, do not hide them. Component JSDOM checks use mocked persistence, not live backend evidence. Real-browser playback/mobile checks and live backend verification remain separate release gates.
