# Release proposal — Spec 158: In-app Guide

## Verdict

verdict: SHIP_READY
rationale: Zero Criticals from any reviewer, all 18 ACs + 4 AC-REGs pass, the one Should-fix
plus the actionable security Low were applied in fix round 1, and the owner-approved OQ-1
round that followed was a pure two-entry registry + catalog change that landed exactly
inside the seam the architect designed for it — 210 suites / 2340 tests green, both
typechecks clean.

## Findings summary

- **code-reviewer** — 0 Critical / 1 Should-fix / 2 Nits.
  - Should-fix (**RESOLVED in fix round 1**): the `?` affordance was not suppressed when
    the active section was `Guide` itself, so pressing it opened `GuideSheet`'s index
    fallback on top of `GuideSection`'s own always-visible index — a redundant popup and,
    worse, two live trees emitting identical `cmd-guide-index-<id>` testIDs (a latent trap
    for the next integration test). Fixed by passing `undefined` for
    `TitleBar.onHelpPress` / `MobileTopAppBar.onTitlePress` when `section === 'Guide'`
    (suppression, not a dead button) plus an effect that clears an already-open sheet if
    `section` becomes `Guide`.
  - Nit 1 (deferred, deliberate): index-row markup duplicated between `GuideSection.tsx`
    and `GuideSheet.tsx`. Reviewer flagged it as awareness-only; factoring a shared row
    would touch both files and re-plumb testIDs — not zero-cost mid-round.
  - Nit 2 (no action, confirmed intentional): `GUIDE_CHROME_KEYS` ships every group label
    to both catalogs for parity-test simplicity, per §8 R-9 / Deviation #6.
  - Also affirmatively verified: zero backend surface, spec-063 staff isolation holds, the
    compile-time `NavItem` / `Record<Exclude<...>>` seam has no `as`-cast defeats,
    `GuideTopicBody` is genuinely the single body renderer, AC-11 holds.

- **security-auditor** — 0 Critical / 0 High / 0 Medium / 2 Low. Explicit "nothing blocks
  merge".
  - Low #1 (**RESOLVED in fix round 1**): `GuideSheet`'s seed path used the ungated
    `findGuideTopic` while its index view used the role-gated `visibleGuideTopics`. Judged
    practically unreachable (`section` is fed only by the role-filtered sidebar, by
    `applySidebarOverride` which cannot resurrect a gated id, and by the ⌘K palette which
    contains neither `Users` nor `Brands`) and worth three lines of static prose if it
    were. Now both paths share exactly one gate; `findGuideTopic` is no longer imported
    there.
  - Low #2 (no change requested): staff catalogs carry admin-oriented *group labels*
    ("Admin", "Brands") via the shared flat `GUIDE_CHROME_KEYS`. Chrome, not topic strings;
    no staff view renders group labels at all. Noted so a future reader does not mistake it
    for a leak.
  - Structural findings: AC-15 separation is enforced by three independent mechanisms
    (separate arrays, separate catalogs, literal `'staff'` audience at every call site) and
    pinned in CI, not by convention; crafted `topicId` deep links fall back to the index and
    cannot render attacker text; catalogs contain no secrets, PII, URLs or `{var}`
    interpolation surface; the new optional props expose nothing privileged and render
    nothing when absent.

- **test-engineer** — 21 AC/AC-REG entries: 20 PASS, 1 PARTIAL. Zero failures.
  - Full `npx jest` reproduced independently at 210 suites / 2325 tests green (pre-fix);
    `npx tsc --noEmit` and `npm run typecheck:test` both exit 0.
  - Independently **falsified** the compile-time drift gate: injecting a fake sidebar id
    into the `NavItem[]` array produced `TS2322` at `cmdSelectors.ts`, confirming Layer 1
    genuinely fires. Edit reverted, tree confirmed clean.
  - Independently confirmed zero backend surface per-file against the spec's
    "explicitly not in the diff" list, and confirmed the staged `supabase/**` +
    `DBInspectorScreen` files are spec-157 work by reading their content.
  - **AC-REG2 PARTIAL** — the "no `sidebarLayout.ts` change" half is verified directly, but
    the *behavioral* half (a user with a saved `profiles.sidebar_layout` override actually
    sees `Guide` appended via `applySidebarOverride`'s default-group fallback) has no
    automated pin. Test-engineer's own assessment: a **pre-existing** coverage gap on an
    unchanged code path that spec 060 already shipped through (`MenuImpact`), explicitly
    recommended as a follow-up rather than a release blocker. I concur — nothing in this
    diff touches that path.
  - Two further non-blocking notes: no `TitleBar.test.tsx` renders the real component with
    `onHelpPress` (the wiring is pinned in the shell suite, which mocks `TitleBar` to the
    prop), and the AC-6 / AC-8 pixel-overflow claims are manual-only, which the spec's own
    "Manual check (not CI)" section explicitly carves out.

- **backend-architect (post-impl drift)** — not invoked, correctly. Zero backend files were
  touched, and that claim is not self-reported: security-auditor and test-engineer each
  verified it independently by grep and per-file `git diff --cached --stat` against the
  full prohibited list (`supabase/**`, `src/lib/db.ts`, `src/store/useStore.ts`,
  `src/screens/staff/store/useStaffStore.ts`, `src/lib/sidebarLayout.ts`, `jest.config.js`,
  `package.json`, `app.json`, `vercel.json`, `eas.json`, `CLAUDE.md`). There is no contract
  to drift from — the architect's own §3 records "zero network requests of its own". The
  OQ-1 round below did not change this: it touched only `src/lib/guide.ts`, six catalogs
  and four test files.

## Did the fix round need re-review?

**No.** My own read of `## Review fix round 1 (2026-08-10)`, not just the developer's
summary:

- **Blast radius is two source files** — `ResponsiveCmdShell.tsx` (one derived handler
  constant + one effect) and `GuideSheet.tsx` (swap one lookup for the already-audited
  gated one, drop an import). Neither touches the model, the catalogs, the staff subtree,
  or any file a reviewer flagged as load-bearing.
- **Both changes move in the safe direction.** Suppression via `undefined` on an optional
  prop is the *removal* of a control, and the gated seed is strictly narrower than the
  ungated one — neither can widen exposure. The one behavior worth checking (that the fix
  is not over-tight and a legitimately-privileged user still gets their topic) was
  explicitly re-verified in the browser as master on `Users`.
- **The fixes are test-covered, and the tests pin the hazard, not just the fix.** +11 tests:
  7 suppression pins across desktop / tablet / collapsed-tablet-rail / phone including
  "already-open sheet closes" and "leaving Guide does not resurrect it"; 2 co-mount pins in
  `GuideSection.test.tsx` that assert testID uniqueness *and* document the collision when
  the guard is removed; 2 role-gate pins on the seed path (`Users` plain-admin vs. master,
  `Brands` master vs. super-admin). That is the shape a re-review would have asked for.
- **Both gates re-ran green after the change** — 210 suites / 2336 tests at the time of that
  round (2340 after the OQ-1 round below), both typechecks clean — plus a 17-assertion
  browser pass with 0 console errors and 0 failed requests that specifically confirms zero
  duplicate `cmd-guide-index-*` testIDs in the live DOM.
- The two deferred Nits are the *only* unapplied reviewer items, and both were explicitly
  characterized by the code-reviewer as awareness-only / confirmed-intentional.

## Addendum — OQ-1 round (2026-08-10): SHIP_READY reaffirmed

The owner approved OQ-1 after the review round and the developer built the "how a normal
day flows" overview topic. I re-read the spec's `## OQ-1 build` section **and** the actual
changed code (`src/lib/guide.ts`, `navGuideParity.test.tsx`, both `en.json` guide subtrees)
rather than judging from the account of it. **No new review pass is warranted.**

**What makes this low-risk is structural, not just small:**

- **It is a data change, not a code change.** Two `GuideTopic` object literals — one in
  `ADMIN_STANDALONE_TOPICS`, one first in `STAFF_TOPICS`, both
  `{ id: 'Overview', group: 'overview', actions: 4, gate: null }` — plus catalog strings.
  Zero new components, zero navigation change, zero test-infrastructure change. `guide.ts`
  remains pure (no store, no `.tsx`, no `react-native` import), so every property the
  security audit rested on is untouched.
- **The seam absorbed it exactly as designed.** The architect's OQ-1 ruling pre-shipped the
  reserved `'overview'` `GuideGroup` member and the `guide.groups.overview` strings in all
  six catalogs *specifically* so this would be one entry per surface, and instructed that
  AC-1 be written as exact id-array equality so the later change would be one line per
  test. That is precisely what happened — 11 one-line test updates. This is the design
  working, not a design being bent.
- **Ordering needed no code.** `guideTopics('admin')` already returned
  `[...ADMIN_STANDALONE_TOPICS, ...sectionTopics]`, so the overview reads first with no
  ordering logic added; the staff twin is simply first in its array.

**The one genuinely new mechanism, checked directly:** the nav-parity test's
reverse-direction orphan check now exempts standalone topics. An exemption is where a drift
guard usually goes soft, so I read it. It does not: the exemption keys off
`ADMIN_SECTION_IDS` rather than the group name (so a future standalone topic in a different
group is still handled exactly), and it is paired with a **new positive pin** —
`navGuideParity.test.tsx` asserts the standalone set is exactly `['Overview']` *and* that
every standalone topic is absent from the super-admin sidebar. Net, the guard is tighter
after this round than before it, not looser.

**AC-15 re-checked against the new shared id.** Both surfaces now have a topic with id
`Overview` and key `topics.overview`, so the shared-key situation that already existed for
`EODCount` now has a second instance. The i18n leak suite derives its expectations from
`guideTopics('staff')` rather than hard-coding 5 subtrees, so it still binds — and the
verbatim-purpose leak grep is satisfied non-trivially: the two copies are genuinely
different voices ("A first-day tour of how the pieces fit together…" for managers vs. "A
first-day tour of what you are being asked to do and why it matters…" for staff), not a
paste. Separation still rests on separate arrays + separate catalogs + literal `'staff'`
audience, all unchanged.

**The content deviation is the right call and I endorse it.** The brief's sketch included a
"deliveries are received" beat; the developer refused it because spec 138 retired
Receiving, this spec's own Findings say so, and `## Out of scope` forbids documenting
dormant surfaces. Bullet 3 instead reads "When the delivery arrives it lands on the books
at the next count — there is no separate receiving step," which is both true of the product
and pre-empts the exact question a new manager asks. Writing "go to Receiving" would have
sent a day-one manager hunting for a page that does not exist — a documentation bug worse
than an omission. Bullet count is 4, inside the documented `actions` 1-4 range pinned by
`guide.test.ts`. Wording remains an owner-correctable catalog-only edit per §Content.

**Gates after this round:** full `npx jest` **210 suites / 2340 tests green** (+4);
`npx tsc --noEmit` and `npm run typecheck:test` both clean; 12 browser assertions across
desktop / phone 375 / staff 375 with 0 console errors and 0 failed or 4xx requests,
covering that the overview row is present, reads first, preselects on desktop, drills in on
phone, renders 4 bullets and no 5th, and re-selects after visiting another topic.

Housekeeping worth noting: the "OQ-1 is NOT built" test was **inverted** into "OQ-1 IS built
and reads first on both surfaces" rather than deleted, so the assertion budget did not
shrink.

## Recommended next steps (ordered)

1. **Commit spec 158 on its own.** The staged diff also contains the already-SHIP_READY
   spec-157 files (`supabase/migrations/20260809000000_super_admin_policy_parity.sql`,
   `supabase/tests/super_admin_policy_parity.test.sql`, `src/screens/DBInspectorScreen.tsx`
   + its test, `specs/157-*` — separate proposal at
   `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/157-super-admin-rls-parity/reviews/release-proposal.md`).
   Ship the two as **separate commits** so the spec-157 migration is bisectable on its own.
   Per your standing preference, staging is done — you run the commits.
2. **Confirm both CI gates after the push.** `test.yml` **and**
   `db-migrations-applied.yml` on `main` must both be green
   (`gh run list --branch main --workflow <file> --limit 1` for each). Spec 158 itself adds
   no migration, so `db-migrations-applied` is trivially green *for 158* — but spec 157
   lands a migration in the same push, so that gate is a live signal for the combined push
   and the CLAUDE.md rule applies. If spec 157 goes to prod via the Supabase MCP path, the
   `schema_migrations` row must be inserted or the gate goes red.
3. *(Optional, non-blocking)* Deploy. Frontend-only, additive, no migration to sequence and
   no backend rollout ordering.

## Follow-ups (do not block ship)

- **AC-REG2 behavioral pin** — a direct `sidebarLayout.test.ts` unit test on
  `applySidebarOverride`: pass a synthetic saved override missing `Guide`, assert it lands
  in the Help group at its default position. Covers the general fallback mechanism, which is
  currently exercised only incidentally through the spec-137/138 remap case in
  `OrderingSection.test.tsx`. Pre-existing gap, shared with spec 060's `MenuImpact`.
- **`TitleBar.test.tsx` addition** rendering the real component with `onHelpPress`, to pin
  the `cmd-guide-entry` testID position ("before the bell") and the a11y label
  independently of the shell suite's mock.
- **Nit 1** — factor a shared index-row component if a third index consumer ever appears.
- **Stale AC text (two bullets, documentation only).** The implementation is correct in both
  cases; the AC prose was never amended to match owner-approved changes:
  - **AC-7** still reads "a `?` control renders in the `TitleBar` cluster on desktop and
    tablet" without the fix-round's Guide-page suppression exception.
  - **AC-1** still reads "exactly **17**" admin topics and "exactly **5**" staff topics;
    after OQ-1 it is 18 and 6. The tests were updated; the AC bullet was not.

## Out of scope for this review

- **Spec 157** (super-admin RLS parity migration, pgTAP test, `DBInspectorScreen`). Already
  has its own SHIP_READY proposal; all three reviewers verified attribution by reading the
  diff content rather than assuming, and correctly excluded it.
- **OQ-5 — the CLAUDE.md convention bullet** ("a new Cmd sidebar destination ships with its
  guide topic in the same PR"). CLAUDE.md is owner-owned; proposed text sits in the spec's
  §7 table for you to apply if you want it. Note the OQ-1 round makes this slightly more
  valuable: the guide now has both destination topics *and* standalone topics, and only the
  former are compiler-guarded.
- **Security Low #2** (admin-oriented group labels in the staff catalogs). No change
  requested by the auditor; changing it would mean splitting `GUIDE_CHROME_KEYS` per
  surface, which trades parity-test simplicity for two unrendered words.
- **es / zh-CN overview translations** are machine-assisted, consistent with OQ-4's upheld
  default for the other 22 topics. Corrections are catalog-only edits later.
- **Rewriting existing section copy to match Guide wording** — explicitly out of scope per
  the spec; a separate cleanup if the owner wants it.
