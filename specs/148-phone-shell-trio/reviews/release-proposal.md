# Release proposal — Phone-tier batch (spans specs 143–148)

Covers the six phone-tier specs shipped in commit `1661d54` plus the staged post-review fix round:
- 143 — Phone Ordering / Reorder
- 144 — Phone Weekly / Inventory count
- 145 — Phone Dashboard
- 146 — Phone Users & access
- 147 — Phone list screens (Reconciliation / POS imports / Audit log / Reports)
- 148 — Phone shell trio (Login / Notifications / Store & brand switch)

Synthesized from all 18 reviewer files (`code-reviewer` / `security-auditor` / `test-engineer` × 6 specs). Every finding referenced below was read from the actual reviewer file, not a summary.

## Verdict
verdict: SHIP_READY
rationale: Every Critical and Should-fix reviewers raised has been fixed and independently re-verified (tsc clean, typecheck:test clean, full jest 173 suites / 1662 tests green); security is 0-findings across all six specs; only ~15 non-blocking nits remain.

## Findings summary

- **code-reviewer** (6 files): 0 Critical, 2 Should-fix, ~10 Nits.
  - Should-fix 143 — first stepper tap discarded the fractional case suggestion (rounded before nudge). **FIXED**: stepper now nudges from the true fractional suggestion (floor/ceil on first tap), pinned in `PhoneOrdering.test.tsx`.
  - Should-fix 147 — local `StatusPill` in `PhoneReports.tsx` shadowed the shared `components/cmd/StatusPill` with a different prop shape. **FIXED**: renamed to `ReportStatePill`.
  - Nits (unfixed, non-blocking): hardcoded English strings in `PhoneOrdering` (`today`/`tomorrow`/`in N days`, mirrors pre-existing Reorder debt); `wkNum` computed once (stale week badge across midnight); duplicated `money()` / `ACTION_TONE` / `formatDayLabel` glyph + helper copies across phone files; `canResetPassword` inline in `PhoneUsers`; inherited `u.color` raw-hex demo-avatar debt in `PhoneLogin`. Catalogued per-spec in the code-reviewer files.

- **security-auditor** (6 files): 0 findings at every severity across all six specs. Verified frontend-only against `git show 1661d54 --stat` — no migration, edge function, RLS, or `src/lib/db.ts` contract change. Specifically audited the two sensitive surfaces: spec 146 destructive user actions (delete/reset/invite all reuse the shared `canDeleteUser` / last-of-role / self-guard predicates and the production `TypeToConfirmModal` + `InviteUserDrawer`; server-side guards untouched) and spec 148 pre-auth login path (auth logic lifted not forked, `secureTextEntry`, no credential logging, dev quick-login `__DEV__`-gated, super-admin brand switch has a server backstop). No `supabase.from/rpc` in any new phone file; db.ts centralization honored.

- **test-engineer** (6 files): jest track only (no DB/edge surface, no fourth framework). Acceptance criteria — AC-REG (desktop/tablet byte-unchanged) PASS for all six via the per-spec `.acReg` pins; every named pure-function boundary directly pinned (±15% weekly variance inclusive boundary, stepper clamp ≥0, spec-121 three-state badge rule, four never-the-accent tone helpers, `reportPillState` / `varianceTone` bands, deep-link payload shapes). i18n parity clean across all three catalogs (0 missing/extra keys). Layout/dimension/no-horizontal-scroll half of AC1 is manual/visual per the codebase's spec-142 precedent (dispatcher's live 375×812 browser pass covered every screen except PhoneUsers — see below).
  - **Original Critical (batch-wide): `npm run typecheck:test` broken** — 3 errors in specs 143/144/146 test files (jest passes because babel strips types, so CI Track 1a would have gone red on push — the exact local-green/CI-red asymmetry CLAUDE.md warns about). **FIXED and re-verified**: `npm run typecheck:test` now clean.
  - **Original NOT TESTED (spec 148 AC4 wiring):** `ResponsiveCmdShell` / `MobileNavDrawer` bell→sheet + `storeChip` slot had no direct mount. **ADDRESSED**: bell→sheet was already pinned in `PhoneNotifications.test.tsx`; the new `PhoneShellWiring.test.tsx` pins the `MobileNavDrawer` storeChip slot (full-shell mount is documented out of scope in that file's header).
  - **Cross-cutting housekeeping:** unowned `PhoneEodCount.tsx` change (TabStrip removal per Hard Rule 4) was in the commit but claimed by no spec and had no regression pin. **ADDRESSED**: now claimed in spec 148's Files changed and regression-pinned in `EODCountSection.acReg.test.tsx`.
  - Residual coverage note (non-blocking): spec 146 PhoneUsers is the one screen with no manual/visual pass (pre-existing no-drawer-nav-entry config gap, not introduced here), so its layout half of AC1 rests on jest + source review. Prioritize a manual pass if/when the drawer nav gap is closed.

- **backend-architect**: not invoked — batch is frontend-only (confirmed by security-auditor and test-engineer against the commit stat), no contract to review for drift.

## Recommended next steps (ordered)

SHIP_READY:
1. **Commit the staged fix round.** Commit `1661d54` is local-only and the fix round is staged but uncommitted; it must be committed (folded into or alongside `1661d54`) before push. Do not push a batch whose typecheck:test fix lives only in the working tree.
2. **Push to `main`, then run the mandatory post-push CI check.** The current latest remote runs on `main` are still the spec-142 green runs — `test.yml` run `30318331011` and `db-migrations-applied.yml` run `30318330950`, both `success`. Per the CLAUDE.md "CI status check after every push to `main`" rule, after this push confirm the newest run of BOTH gates is green via `gh run list --branch main --workflow <file> --limit 1` for each; if either is red or in-progress, surface the URL and wait for user direction. The typecheck:test fixes and the PhoneEodCount regression pin are exactly what the remote gate will exercise for the first time.
3. (optional, non-blocking follow-ups — not required to ship) Address the ~15 nits in a hygiene pass: hoist duplicated phone helpers (`money`, `ACTION_TONE`, `formatDayLabel`, glyph constants) and `canResetPassword` into shared `utils/`; localize the remaining hardcoded English strings in `PhoneOrdering`; time-bucket `wkNum`; and add a manual/visual pass for PhoneUsers once its drawer nav entry exists.

## Out of scope for this review
- **PhoneUsers drawer nav entry** — pre-existing environment/config gap (no drawer entry to browser-verify against), not introduced by this batch; belongs in a separate nav-config spec. Its absence only weakens visual evidence for one screen; the pill/role/delete/invite logic is fully jest-tested.
- **Inherited demo-account `u.color` raw-hex debt** and **pre-existing un-localized Reorder strings** — both flagged as inherited-not-introduced by code-reviewer; belong in the standing cleanup backlog, not this batch.
- **Vestigial `isPhone ? …` squeeze ternaries** in the desktop render paths below the early-return — dead code the spec-140 release-proposal already flagged and asked reviewers not to re-file.

## Handoff
next_agent: NONE
prompt: SHIP_READY — all Criticals/Should-fixes fixed and re-verified (typecheck:test clean, jest 173/1662 green), security 0 findings; commit the staged fix round, push, then run the mandatory post-push CI check on both gates.
payload_paths:
  - specs/148-phone-shell-trio/reviews/release-proposal.md
