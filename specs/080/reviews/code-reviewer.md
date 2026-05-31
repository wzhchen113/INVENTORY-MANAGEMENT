## Code review for spec 080

Spec: E2E — dashboard attention-queue weekly-window guard (FULL)
Files reviewed:
- `e2e/dashboard-window.spec.ts` (NEW)
- `e2e/global-teardown.ts` (EXTENDED)
- `e2e/fixtures/constants.ts` (EXTENDED)
- `src/screens/cmd/sections/DashboardSection.tsx` (2 testID additions)
- `tests/README.md` (Track-4 section extended)

Reference reads: `src/utils/weekWindow.ts`, `src/lib/cmdSelectors.ts:876-904`,
`src/lib/db.ts:3487-3514` (`fetchOrderScheduleForStores`), `src/store/useStore.ts:518`
(timezone default), `src/components/TimezoneBar.tsx` (only caller of `setTimezone`).

---

### Critical

None.

---

### Should-fix

- `e2e/dashboard-window.spec.ts:95` — `outWindowISO` is accessed with `[0]` on
  the result of `isoDateRange(beforeMonday, mondayStart)` without a guard. The
  comment says "single ISO" and the arithmetic guarantees a non-empty result
  (`beforeMonday` is always one UTC day before `mondayStart`, so `start < end`
  holds), but `isoDateRange` returns `string[]` not `[string, ...string[]]` — a
  future refactor of the date math that accidentally produces `start >= end` would
  silently set `outWindowISO = undefined`, and the `${undefined}` interpolations on
  lines 228 and 248 would produce testIDs that never match rather than a loud
  failure. The defensive fix is a single assertion:
  ```ts
  const outWindowISOs = isoDateRange(beforeMonday, mondayStart);
  if (outWindowISOs.length !== 1) {
    throw new Error(`[e2e dashboard-window] expected exactly 1 out-of-window ISO, got ${outWindowISOs.length}`);
  }
  const outWindowISO = outWindowISOs[0];
  ```
  This is cheap, self-documenting, and turns a silent wrong-testID into a loud
  fixture failure — the same posture the `beforeAll` already applies to the store
  and schedule upserts.

---

### Nits

- `e2e/dashboard-window.spec.ts:172` — `inWindowISO as string` is a type
  assertion used to silence a `string | null` → `string` widening. The
  surrounding `isMonday` guard makes the cast correct at runtime, but it is the
  pattern CLAUDE.md flags ("`as` assertions used to suppress type errors instead
  of fix them"). The minimal fix is a non-null assertion `inWindowISO!` (which at
  least conveys intent) or, cleaner, a local narrowed variable:
  ```ts
  const inWindowISOStr = inWindowISO as string; // already guarded by !isMonday branch
  ```
  Neither changes behavior; the cast is safe here. Flag for consistency with
  project style.

- `e2e/dashboard-window.spec.ts:85-95` — The `now`, `mondayStart`, `weekISOs`,
  `inWindowISOs`, `isMonday`, `inWindowISO`, and `outWindowISO` constants are
  computed at **module top-level** (Playwright collection time), before
  `test.beforeAll` runs. In CI, the gap between collection and execution can be
  tens of seconds (setup project runs first). If CI is extremely slow and the
  test collection straddles midnight in `America/New_York`, the fixture seeds
  different dates than the assertions target. This is the same accepted class of
  risk as spec 079's EOD persistence test (documented in the spec as Risk 2,
  "sub-second flake window"). It is noted in the spec and is intentional — no
  action required, but the existing Risk 2 comment should explicitly mention
  "collection vs execution gap" in addition to "sub-second midnight straddle" so
  a future flake debugger has the right search term. (out-of-scope for a one-line
  comment tweak.)

- `e2e/global-teardown.ts:117` — Early `return` after the store delete error
  suppresses the success `console.log` on line 121 when the store delete fails.
  This is correct behavior (no success to log), but it creates an asymmetry with
  the Towson cleanup block above, which does NOT `return` on error and falls
  through to its success log unconditionally. The asymmetry is harmless — the
  Towson block's log is slightly wrong-on-error, while this block's log is
  correct-on-error — but a reader diffing the two blocks could be confused.
  Cosmetic; no action required.

- `e2e/fixtures/constants.ts:52` — `e2eWindowStoreId: 'e2e00000-0000-0000-0000-000000000080'`
  — the UUID is not a valid v4 UUID (the `e2e00000` prefix is a mnemonic sentinel,
  not RFC 4122 compliant). Postgres `uuid` columns accept any 8-4-4-4-12 hex
  string regardless of version, so this works, but the shape diverges from the
  other SEED UUIDs (which are v4). A comment alongside would help a future dev who
  wonders whether the non-v4 shape is intentional: e.g. `// sentinel, not v4 —
  easy to grep; Postgres uuid accepts any 8-4-4-4-12 hex`. No behavior impact.

- `tests/README.md:497` — The Track-4 bullet for `dashboard-window.spec.ts` notes
  the spec is "Un-blocked by spec 081" in the middle of a "what it covers" list.
  The historical context is accurate and useful for developers, but it makes the
  bullet read as a changelog entry rather than a stable capability description. A
  future cleanup pass (out-of-scope) could move the "un-blocked by 081" note to a
  parenthetical at the end so the lead sentence reads as forward documentation.

---

## Resolution (post-review fix-pass — main Claude)

- **Should-fix (unguarded `outWindowISO = isoDateRange(...)[0]`)** — **fixed.** Replaced the bare `[0]` with a guard that throws loud if `isoDateRange(beforeMonday, mondayStart)` doesn't yield exactly 1 ISO. Without it, a future date-math refactor producing `start >= end` would set `outWindowISO = undefined` → `${undefined}` testIDs that never match → the absence assertion (`toHaveCount(0)`) would pass VACUOUSLY. Now it's a loud fixture failure, matching the `beforeAll` posture. Re-verified: e2e tsc exit 0; `dashboard-window` spec still passes (4/4; fixture log confirms out-of-window=2026-05-24, in-window=2026-05-30, isMonday=false).
- **Nits (5)** — deferred (all cosmetic): the `inWindowISO as string` cast (safe under the `!isMonday` guard), the collection-vs-execution comment wording, the teardown success-log asymmetry, the non-v4 sentinel UUID comment, and the README "un-blocked by 081" phrasing. None affect correctness or determinism.

Full suite re-confirmed green post-fix-pass: Playwright 15/15 (incl. this spec), pgTAP 38/38 (anchors undisturbed — both teardowns fire), jest 397, tsc (base + e2e) exit 0.
