# Release proposal — spec 160: Truthful "last counted" indicator

**Revision 2 — post-fix-pass re-review.** Revision 1 issued FIXES_NEEDED with five
must-fix items; the user authorized all five and the test-engineer applied them.
This revision re-verifies each fix against the working tree directly (the changed
source and test files, the migration, the spec's amended §0.3/§1.2 and its
"Fix pass" section), not against the fix-pass report. Where the report and the
code disagree, the code wins.

## Verdict

verdict: **FIXES_NEEDED**
rationale: four of the five fixes hold under inspection, but item 2's static
source-grep — the net I required precisely because a single-cycle call-count
assertion cannot see a new call site — misses the call idiom this codebase
actually uses for loader actions, so AC-20's future-regression protection is
weaker than the spec now claims it is.

Severity honesty, stated up front so the user can weigh the override: **no
reviewer flagged a Critical, and this finding is not one.** Nothing user-facing
is wrong, no shipped behavior is at risk, and the production code is correct.
The single open item is one mechanical edit to one test file plus a one-sentence
correction to the spec text. It is not another design round. If the user chooses
to ship as-is, the cost is precisely bounded: a future per-row `useEffect` fetch
written in the codebase's dominant idiom would not fail any suite, and the spec
would carry an overstated claim that it would — the same class of inherited-false-
premise problem that fix #5 (M1) existed to correct.

## Findings summary

Reviewer files are unchanged since revision 1 (the fix pass did not re-run them);
counts below are their originals, annotated with fix-pass disposition.

- **code-reviewer**: 0 Critical, 0 Should-fix, 5 Nits. Nit 1 (`COL_STYLE` key
  order) verified **still deferred** — `InventoryTable.tsx:121` still has
  `lastCounted` tacked on last. Its S3-adjacent copy concern was folded into fix
  #4 and is now closed. No new findings.
- **security-auditor**: 0 Critical, 0 High, 0 Medium, 4 Low. All four verified
  **still deferred, correctly** (see the ruling on Low #3 below). Its one
  ship-time precondition — the normalized-md5 drift check on prod's live
  `staff_items_updated` before the `create or replace` — is unchanged and is
  step 2 of the ship sequence.
- **test-engineer**: was BLOCK (AC-20/21/22 untested, AC-19 PARTIAL). Fix pass
  moves AC-19 to PASS (verified) and AC-21/AC-22 to PASS (verified). **AC-20 is
  PASS for the runtime path and PARTIAL for the "no other call site" claim** —
  the delta driving this verdict. Reported gates: jest 216/216 suites /
  2471/2471, `tsc` clean, `typecheck:test` clean, `test:db` 82/82 with
  `ingredient_changed_badge.test.sql` 20/20; the badge test file contains zero
  references to `items_last_counted` or spec 160, consistent with byte-unedited.
- **backend-architect** (post-impl): 0 Critical, 3 Should-fix (S1 prod apply, S2
  post-submit refresh, S3 composed copy), 5 Minor. S2 and S3 verified applied;
  M1 verified corrected in the spec at both §0.3 and §1.2; S1 remains the ship
  sequence. M4 (`counted:stale` implemented as "not fresh") verified **not
  taken** — `filterParser.ts:91` still reads `if (countedTone === 'fresh')
  return false;`. Behaviorally identical across today's four tones; recorded as a
  follow-up, not re-raised.

### Item-by-item verification of the fix pass

**1. S2 post-submit refresh — HOLDS.** `InventoryCountSection.tsx:457-478`. The
call sits inside the section-local `store-${storeId}-inv-counts` channel handler,
`filter: store_id=eq.${storeId}`, and passes that same `storeId` to
`loadItemsLastCounted(storeId)` — so it is on the right channel and structurally
cannot load another store's map. The effect early-returns on `!storeId ||
storeId === '__all__'`, and the action itself bails on `__all__` again
(`useStore.ts:4493`). **Load-storm check:** the handler is un-debounced, so it is
one RPC per `inventory_counts` row event — but the handler's pre-existing body
(`setRefreshTick`) already triggers a `fetchRecentInventoryCounts` per event, so
this doubles a bounded cost rather than introducing an unbounded one, the
subscription only exists while the section is mounted, and the RPC measured
13.2 ms against a synthetic year of history. No storm. Worth recording only as a
future caveat: a bulk write touching many `inventory_counts` rows would fan out
per row, for both the old and new work in that handler.

**2. The AC-20/21/22 lifecycle test — MOSTLY HOLDS, one real gap.**
`src/store/useStore.lastCounted.spec160.test.ts`, 12 assertions, read in full.

- **AC-21 genuinely bites.** The test hands `fetchItemsLastCounted` a
  caller-controlled deferred promise, `await`s `loadFromSupabase('store-1')`, and
  asserts it resolved with `lastCountedLoaded === false` and `storeLoading ===
  false`, then resolves the deferred and asserts the slice populates. If the tail
  were awaited the test cannot pass — it can only time out. The report's
  break-and-revert claim checks out against the fixture; this is not a test that
  cannot fail.
- **AC-22 genuinely bites** on all four arms: `__all__` clears to NOT LOADED and
  never calls the RPC; the action bails on `__all__` (removing the guard flips
  this to a real `toHaveBeenCalled` failure, as reported); a per-store cycle
  clears the previous map *synchronously* before the new fetch resolves; a
  genuine switch refetches keyed per store id.
- **Error path genuinely bites**, and asserts the exact toast
  (`text1: 'Load last counted failed'`, matching `notifyBackendError`'s
  `` `${action} failed` `` at `useStore.ts:58`) plus the non-degradation to a
  loaded-empty map.
- **AC-20 runtime arm is fine** (one call per cycle, called with the store id).
  The second arm ("does not re-fire on a second call to the action alone")
  asserts 2 calls after 2 deliberate calls — near-tautological, and would only
  fail if someone added dedupe/caching. Low value, harmless, not a defect.
- **The static source-grep is the gap.** `InventoryTable`-style regression shapes
  are what it exists to catch, and its regex is
  `/\.loadItemsLastCounted\(/g` — it requires a **member call with the paren
  attached**. That catches `useStore.getState().loadItemsLastCounted(` and
  `get().loadItemsLastCounted(`, i.e. the two call sites it enumerates. It does
  **not** catch the idiom this codebase actually uses for loader actions in
  components:

  ```ts
  const loadWeeklyCountStatus = useStore((s) => s.loadWeeklyCountStatus);   // InventoryCountSection.tsx:167
  void loadWeeklyCountStatus(todayIso());                                   // :507
  const loadLastOrderContext  = useStore((s) => s.loadLastOrderContext);    // ReorderSection.tsx:1529
  void loadLastOrderContext(...);                                           // :1552
  ```

  In that form the selector line reads `s.loadItemsLastCounted)` — no `(` after
  the name — and the call site is a bare identifier. Neither matches. So a future
  per-row `useEffect` fetch written the way two existing sections already write
  loader calls would pass this suite silently, which is exactly the regression
  the grep was added to prevent. Note also that neither reported break-and-revert
  experiment (awaiting the tail; removing the `__all__` guard) exercises the grep
  assertion at all — its bite was never demonstrated, and on inspection it is
  partial.
- **The spec's fix-pass text overstates it.** Spec line ~1568 says the grep means
  "a future per-row `useEffect` fails this suite even though a single-cycle
  call-count assertion cannot see it." As written that is true only for one of
  two call forms. Left uncorrected it is the same inherited-false-premise problem
  that fix #5 was required to fix.

**Bundled stub fix — HOLDS, and genuinely changes what runs.**
`useStore.switching.test.ts:52-87` now stubs `fetchItemsLastCounted`. Before, the
symbol was `undefined`, so the fire-and-forget tail threw a `TypeError` inside
`loadItemsLastCounted`'s own `try`, hit its `catch`, and set
`lastCountedLoaded: false` + fired a toast on every test in the file. After, the
**success** branch runs and the slice populates. That is a real change to the
executed path, not a silenced throw. The suite still asserts nothing about the
spec-160 slice — correct division of labor, since the new dedicated file owns
those assertions — and the file header now documents exactly why the stub is
load-bearing.

**3. AC-19 PARTIAL → PASS — HOLDS, both halves.** Desktop: the `FilterInput`
mock at `InventoryDesktopLayout.test.tsx:157-164` now renders
`FILTER_PLACEHOLDER=${placeholder}` and returns `null` when the prop is absent,
so the assertion at :612-613 fails on a dropped prop and fails on a swap back to
the untouched `filterPlaceholder` key. Phone: `PhoneInventoryList.test.tsx:159-165`
reads the real `TextInput`'s `placeholder` prop and asserts it `toBe`
`en.section.inventory.filterPlaceholderItems` **and** `not.toBe`
`en.section.inventory.filterPlaceholder` — real catalog content, not the key. The
two together cover both the wiring and the content half.

**4. S3 composed copy — HOLDS, three branches genuinely distinguished, and the
loading branch cannot render as "never counted".** `InventoryDesktopLayout.tsx:804-844`:

```ts
const lastCountedText = !lastCountedLoaded
  ? T('section.inventory.lastCountedLoading')
  : formatLastCounted(lastCountedAt, { …, neverLabel: T('section.inventory.neverCounted'), style: 'long' });

const metaLastCountedFragment =
  !lastCountedLoaded || lastCountedAt == null
    ? lastCountedText
    : T('section.inventory.lastCountedMeta', { value: lastCountedText });
```

`!lastCountedLoaded` is evaluated **first and independently** in both
expressions, so the loading case never reaches `formatLastCounted` and therefore
can never resolve to the never-counted phrase — the AC-9 failure mode is closed
structurally, not by ordering luck. Three jest cases at
`InventoryDesktopLayout.test.tsx:573-599` pin all three branches by distinct
strings (`…· lastCountedLoading`, `…· neverCounted`, `…· lastCountedMeta`), each
with a negative assertion against the wrapper key. The one residual edge — an
empty-string `lastCountedAt` would take the wrapper path — is unreachable:
`db.ts` maps `last_counted_at ?? null` and never coerces to `''`. Not worth an
action.

**5. M1 doc correction — HOLDS.** Both §0.3 (lines 385-392) and §1.2 (lines
466-479) carry an explicit "Post-implementation correction" callout naming the
`proconfig`/`inline_set_returning_function()` mechanics, the measured 13.2 ms /
11.9 ms, and "no code action follows". A future perf spec reading the design can
no longer inherit "one grouped scan joined once" as fact.

**Scope discipline — CLEAN.** Grepping `src/` for fix-pass markers returns hits
only in the five expected places (`InventoryCountSection.tsx`,
`useStore.lastCounted.spec160.test.ts`, `useStore.switching.test.ts`,
`InventoryDesktopLayout.tsx`, `InventoryDesktopLayout.test.tsx`) plus the phone
test. Independently confirmed untouched: Nit 1 (`InventoryTable.tsx:121`
unchanged), M4 (`filterParser.ts:91` unchanged), security Lows #1/#2/#4 (the
migration's grant block at `20260817000000_items_last_counted.sql:95-96,128-129`
is unchanged), and Low #3 (`items_last_counted.test.sql` still `select plan(16)`
with the same `set local role authenticated` / `reset role` structure — no arm
added). Nothing expanded into the deferred list.

**Ruling on deferring security Low #3 — correct call, agree.** Three independent
reasons: (a) the auditor verified the "granted store A, asks for store B"
behavior manually against the running stack and it is correct, so this is a
standing-gate gap and not a vulnerability — nothing ships broken by deferring it;
(b) it was explicitly filed in revision 1's "take now if cheap, otherwise
follow-up" tier, not in the authorized five, and the fix pass respecting that
boundary is the behavior I want, not a shortfall; (c) it is a pgTAP arm inside
the JWT-impersonation block, which means re-running `npm run test:db` and
re-deriving the plan count — mechanically small but a different file, a different
track, and a different failure surface from the JS store-lifecycle work item 2
was scoped to. Taking it opportunistically inside a fix pass would have been the
scope-creep failure mode. It belongs in a follow-up and is recorded below.

## Recommended next steps (ordered)

1. **Tighten the static call-site enumeration in
   `src/store/useStore.lastCounted.spec160.test.ts:156-180` (should-fix, one
   test-file edit, no production code).**
   Match the identifier, not the member-call punctuation, so the selector idiom
   is covered. The regex `/\.loadItemsLastCounted\(/g` becomes
   `/\bloadItemsLastCounted\b/g`, which then also matches the interface
   declaration, doc comments, and the action key inside `useStore.ts` — so the
   assertion has to change shape with it. The straightforward form: skip
   `store/useStore.ts` (the owner of the action, where declaration and
   implementation legitimately mention it) and assert the set of **other** files
   in `src/` mentioning the identifier is exactly
   `['screens/cmd/sections/InventoryCountSection.tsx']`. That keeps the property
   the net exists for — no third consumer appears anywhere in the tree, in any
   call form — while removing the punctuation dependency. Verify it bites by
   temporarily adding `const f = useStore((s) => s.loadItemsLastCounted);` to any
   component and confirming the assertion fails, then revert.
2. **Correct the fix-pass sentence in the spec (doc-only, same edit session).**
   Spec §"Fix pass" item 2 currently claims the grep means "a future per-row
   `useEffect` fails this suite". After step 1 that becomes true; if the user
   overrides and ships without step 1, the sentence must instead be narrowed to
   "…fails this suite when written as a `getState()` member call". One of the two
   must happen — the spec is what the next spec inherits.
3. **Re-run the full local gate set and stage** — `npx jest` (full, not a
   subset, per the standing memory note), `npx tsc --noEmit`,
   `npm run typecheck:test`, `npm run test:db`. Do **not** commit; the user runs
   the commit.
4. **Then execute the ship sequence below**, unchanged from revision 1 except
   that step 1 now folds in the above.

**If the user overrides and ships now:** steps 1 and 2 collapse into a single
follow-up item, and step 2's narrowing of the spec sentence becomes mandatory
rather than optional. Everything else in the ship sequence applies identically —
nothing in this finding touches the migration, the prod apply, or the gates.

## SHIP SEQUENCE (final ordered checklist — this is the part to execute)

0. **Land fix item 1 + the spec sentence correction (item 2), then re-run the
   full local gate set and stage.** `npx jest` · `npx tsc --noEmit` ·
   `npm run typecheck:test` · `npm run test:db`. Nothing is committed yet.

1. **PRE-APPLY DRIFT CHECK on prod's live `staff_items_updated` — BEFORE any
   write, and before the `create or replace`.**
   The migration `create or replace`s a **live staff RPC** consumed by
   `src/screens/staff/lib/itemsUpdated.ts`. Dashboard SQL-editor drift is a known
   hazard in this project, and `create or replace` would silently discard whatever
   is actually deployed, with no diff and no error.
   Against project `ebwnovzzkwhsdxkpyjka` via the Supabase MCP, read prod's live
   definition (`pg_get_functiondef('public.staff_items_updated(uuid)'::regprocedure)`),
   normalize it (collapse whitespace runs to a single space, trim, lowercase),
   take its md5, and compare against the same normalization of the committed
   spec-128 body in
   `supabase/migrations/20260722000000_ingredient_changed_badge.sql:101-134`.
   - **Match → proceed to step 2.**
   - **Mismatch → STOP. This is the abort point, and the rollback is "do
     nothing".** No write has occurred, so there is nothing to undo in prod.
     Concretely: do **not** run `execute_sql`, do **not** insert the
     `schema_migrations` row, and do **not** commit or push the frontend — the
     migration file and the frontend are in one commit, so pushing without
     applying turns `db-migrations-applied.yml` red on `main`. Capture prod's
     live `pg_get_functiondef` output verbatim into
     `specs/160-last-counted-indicator/reviews/` and surface it to the user with
     the diff. Deciding whether the prod drift is intentional (and therefore
     whether the migration must be re-authored to preserve it) is a user call,
     not a fix to improvise mid-ship.

2. **Apply `supabase/migrations/20260817000000_items_last_counted.sql` to prod
   via the Supabase MCP path** (`db push` has no prod password here):
   `execute_sql` on project `ebwnovzzkwhsdxkpyjka`, statements in **file order** —
   `items_last_counted` (line 67) must exist before `staff_items_updated`
   (line 106) references it — including both grant blocks (lines 95-96 and
   128-129: `revoke … from public, anon` / `grant … to authenticated`).
   Verified additive and idempotent: two `create or replace function`, **no
   `drop`**, no table DDL, no policy, no index build (so no `SHARE` lock on
   `eod_entries` and none of spec 151's off-peak caveat), and **no `alter
   publication`**.

3. **Insert the exact version string `20260817000000` into
   `supabase_migrations.schema_migrations`.** Function-only migrations still need
   this row; skipping it is precisely what `db-migrations-applied.yml` hard-fails
   on.

4. **Post-apply verification, before touching the frontend.** Normalized-md5 both
   prod functions against the committed migration; confirm the ACL on both shows
   `postgres` / `authenticated` / `service_role` and **no `anon`**; spot-check
   `staff_items_updated` row counts per store are unchanged (the auditor's local
   equivalence run was 143→143 with a 0/0 `EXCEPT` diff in both directions).

5. **Then commit and push the frontend to `main`** (user runs the commit).
   Prod-first is the correct order and the reason is specific: the migration is
   **function-only**, `items_last_counted` has no prod callers until the web
   bundle ships, and `staff_items_updated` is behaviorally identical the instant
   it lands — so there is no window in which the frontend calls a function that
   does not exist, and no window in which the staff badge changes.

6. **Confirm all three gates after the push — independent signals, all three
   required:**
   - `gh run list --branch main --workflow test.yml --limit 1` → green.
   - `gh run list --branch main --workflow db-migrations-applied.yml --limit 1` →
     green. **This is the gate steps 2-3 exist to satisfy**; a green `test.yml`
     alone is not evidence the branch is healthy. If it is red, diff repo
     migrations against `schema_migrations` before assuming drift — the gate's
     CLI is pinned to 2.108.0 and has produced false "missing from prod" before.
   - `gh run list --branch main --workflow e2e.yml --limit 1` → green, **checked
     manually**. Green as of `3ddb4a1`, but `e2e.yml` is still not promoted into
     the CLAUDE.md gate checklist, so nothing will remind you.
   If any of the three is red or in-progress, surface the run URL and stop.

7. **No realtime container restart is required.** Stated explicitly because the
   spec's project-specific notes raised it: the migration contains no `alter
   publication` (independently confirmed by grep on the migration file — zero
   hits), so the `docker restart supabase_realtime_imr-inventory` gotcha does not
   apply to spec 160.

8. **Rollback, if needed after a successful apply:** re-apply spec 128's
   `staff_items_updated` body from
   `20260722000000_ingredient_changed_badge.sql`, `drop function
   public.items_last_counted(uuid)`, and delete the `20260817000000` row from
   `supabase_migrations.schema_migrations`. No data is at risk — nothing was
   written, backfilled, or dropped.

## Out of scope for this review

Carried forward from revision 1 and re-confirmed untouched by the fix pass:

- **Security Low #3** — the missing "authenticated, granted store A, asks for
  store B" pgTAP arm in `items_last_counted.test.sql`. Deferral ruled correct
  above. Follow-up: one arm inside the existing `set local role authenticated`
  block, plan count 16 → 17.
- **M4** — `counted:stale` implemented as "not fresh" (`filterParser.ts:91`)
  rather than the enumerated `{stale, cold, never}`. Behaviorally identical
  today; a future fifth tone would silently join `stale`. One-line follow-up.
- **Nit 1** — `COL_STYLE` key order (`InventoryTable.tsx:121`), pure object-literal
  reorder, zero behavior risk.
- **Security Lows #1, #2, #4** — pre-existing project posture, not new surface.
  #2 in particular (`service_role` retains `EXECUTE` and has `BYPASSRLS`) is a
  forward-looking constraint for **whoever writes the first edge-function
  consumer of `items_last_counted`**; carry it into that spec.
- **M2 / M3 / M5 / Nits 3-5** — all cleared with reasons in revision 1; unchanged.
- **`inventory_counts` on the realtime store channel / publication.** Correctly
  refused in §7.2; fix #1 closes the practical gap without it. Own spec.
- **The un-debounced section-local counts handler.** Both the pre-existing
  `setRefreshTick` fetch and the new RPC fan out one call per row event; a future
  bulk write to `inventory_counts` would multiply both. Pre-existing shape, not
  introduced here.
- **The ultra-floor layout tier**, **test coverage for the two relabel-only
  catalog surfaces**, **the hardcoded English `'never'` in `PhoneCatalogList.tsx` /
  `InventoryCatalogMode.tsx`**, and **per-column sorting / phone Inventory list
  column / catalog.tsv / cadence-aware thresholds / stale-count alerts** — all
  unchanged from revision 1, none smuggled in.
- **`e2e.yml` promotion into the CLAUDE.md gate checklist.** Standing repo-hygiene
  item, not this spec's.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 1 item, top: item 2's static call-site grep in useStore.lastCounted.spec160.test.ts matches only `.loadItemsLastCounted(` member calls, so the selector idiom this codebase actually uses for loader actions escapes it — AC-20's future-regression net is weaker than the spec now claims. One test-file edit plus a one-sentence spec correction; no production code, no Critical, nothing user-facing at risk. The other four fixes hold under direct inspection and the ship sequence (md5 drift check → MCP prod apply → schema_migrations insert → commit/push → test.yml + db-migrations-applied.yml + e2e.yml) is ready to run immediately after.
payload_paths:
  - specs/160-last-counted-indicator/reviews/release-proposal.md
