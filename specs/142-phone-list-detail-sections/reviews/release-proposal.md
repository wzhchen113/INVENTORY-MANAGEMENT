# Release proposal — spec 142 (Phone tier for list/detail admin sections + global phone chrome)

## Verdict
verdict: SHIP_READY
rationale: All three reviewers completed a post-fix re-verification pass with zero open Critical findings, the full jest suite (156/156 suites, 1559/1559 tests) and typecheck are green, and both CI gates on `main` are green.

## Findings summary
- **code-reviewer**: 0 open Critical, 0 open Should-fix, 1 open Nit. The prior 1 Critical (AC-INV5 phone-catalog unreachable) + 4 Should-fix are all confirmed FIXED on re-review against the staged tree — including the deeper root cause (tier-change remount resetting `viewMode`), resolved by the new plain-module singleton `src/screens/cmd/lib/inventoryViewMode.ts`, which the reviewer read as fresh code and cleared. Only residual: a cosmetic leftover comment header at `PhoneWidgets.tsx:177` (should read `// ── PropertyCard` instead of a duplicate `StatPanel` header) — no behavioral effect.
- **security-auditor**: 0 findings at every severity (Critical/High/Medium/Low). Frontend-only claim verified against the actual staged diff (45 files): no `supabase/migrations/`, `supabase/functions/`, `supabase/config.toml`, `src/lib/db.ts`, or `package.json` changes; no new `supabase.from`/`.rpc`/`import supabase` call sites; role-gating boundary (`RoleRouter`/`useRole`) untouched. The `tel:` deep link is sanitized (`replace(/[^\d+]/g, '')`) and `logWaste` inherits the existing optimistic + RLS enforcement path. No post-impl backend-architect review was run — appropriate, since the spec is frontend-only and the security-auditor independently confirmed zero backend/db.ts/migration surface against the staged diff.
- **test-engineer**: All 6 previously-blocking NOT TESTED acceptance criteria (AC-INV4, AC-BOM1/2, AC-PREP1/2, AC-VEN1/2) are now closed with real content-asserting tests, plus the two partial gaps (AC-WASTE1 chip filter, AC-MI1 chips/KPI). Independently re-ran `npx jest` (156 suites / 1559 tests green) and `npx tsc --noEmit` (clean). AC-INV5 flagged as a genuine bug catch, not just a coverage fill. One AC remains jest-untested: AC-REG3 (both themes) — consistent with existing project precedent (spec 140 did not jest-test dark mode either) and covered by the dispatcher's manual browser pass; not scored as blocking.
- **backend-architect**: Not invoked (frontend-only spec; no `## Backend design` drift surface to review — §0 confirms no DB/RLS/edge/`db.ts`/store-slice changes, and the security-auditor verified this against the staged diff).

## Recommended next steps (ordered)
SHIP_READY:
1. Commit the staged changes (per project policy the user runs the commit) and deploy.
2. (optional, non-blocking follow-up) Fix the cosmetic comment header at `src/screens/cmd/sections/phone/PhoneWidgets.tsx:177` — rename the duplicate `// ── StatPanel` header to `// ── PropertyCard` (or delete it; line 179 already carries the correct header). Trivial; can ride along with the commit or a later hygiene pass.

## Residual non-blocking items (informational)
- Cosmetic comment nit at `PhoneWidgets.tsx:177` (above).
- AC-REG3 (both Light + Dark themes) has no jest assertion — covered by manual 375×812 browser verification in both themes across all seven phone surfaces, plus spec-140 precedent (dark-mode token application on Cmd UI phone surfaces has always been manual/visual, never jest-asserted).
- A handful of styling sub-details of already-behavior-tested rows rely on the manual pass rather than pixel/text assertions (Inventory par bar + right-aligned stock figure, Vendors `DeliveryPill` glyph, Waste period-total header string, Menu-items margin-pill/makeable-tag color threshold). These are untested *styling*, not untested *behavior*, and pre-date this revision.
- AC-MI3 (Menu-impact and Recipes share one `PhoneMenuItemDetail` component) is verified by source (single shared component, two call sites) rather than a rendered-equality assertion — low drift risk.

## Verification evidence relied upon
- Both CI gates green on `main` as of 2026-07-27: `test.yml` (run 30290068077) and `db-migrations-applied.yml` (run 30290067944), both `completed success` — satisfies the hard rule that neither gate may be red for SHIP_READY.
- Manual browser verification at 375×812 in Light + Dark across all seven phone surfaces, including a re-verified end-to-end repro of the catalog-mode tier-change-remount fix; desktop 1280px AC-REG1 visually confirmed.
- Nothing is committed — all changes are staged; the user runs the commit.

## Out of scope for this review
- Bottom-dock navigation, login, the full notifications sheet, store/brand-switch takeover, Dashboard, Ordering, weekly Inventory count / reconciliation, POS imports, audit log, reports, users & access, Brands, DB inspector — each explicitly deferred to later specs per the spec's Out-of-scope section.
- Phone edit/create forms for recipes, prep, vendors, catalog items — desktop-only edit actions intentionally surface an honest toast (AC-D5); the only new form is the Waste two-step log sheet.
- `app.json` slug — untouched (load-bearing per CLAUDE.md).
