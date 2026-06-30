# Spec 103 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Scope: staged tree (`git diff --cached`), verified against the `## Backend design`
in `specs/103-count-screen-custom-sort-per-user.md`.
Verdict: **no Critical findings.** Both forced deviations are sound and are
hereby blessed. 0 Critical / 1 Should-fix / 4 Nit.

---

## The two deviations — both BLESSED

### Deviation 1 — `saveCountOrder` is delete-then-insert, not `.upsert({ onConflict })`. BLESSED.

The diagnosis in the frontend notes is correct and I confirm it as a real
PostgREST limitation, not a workaround for a self-inflicted bug: PostgREST's
`?on_conflict=` parameter emits `INSERT … ON CONFLICT (cols) DO UPDATE` with no
way to attach the index's `WHERE` predicate, so a **partial** unique index can
never be the inferred arbiter — Postgres raises `42P10`. My design §1.2 named
`onConflict: 'user_id,screen'` / `'user_id,screen,vendor_id'` as "the lower-risk
path," which was wrong for the no-vendor (partial) branch specifically. The
design's own §1.2 already listed "delete-then-insert within one statement" as the
sanctioned alternative ("Backend-developer's call which"), so this is a
within-design fallback, not a contract break.

**Delete-then-insert is the right call here. Keep it.** Rationale:

- **Atomicity loss is immaterial for this data.** The row is a *private,
  per-user, single-screen view preference*. The only reader of a given
  `(user, screen, vendor?)` row is the same user's own next screen-open. A torn
  write (delete succeeds, insert fails) leaves zero rows → the screen falls back
  to default order, and the very next drop re-saves the full array. There is no
  cross-user, cross-row, or financial invariant that a non-atomic two-call write
  can violate. Contrast with the count-submission RPCs (which are correctly
  untouched) where atomicity *does* matter — this is deliberately not that.
- **It is not data-losing.** `item_ids` is the *entire* ordering, rewritten whole
  on every drop (the array-per-key shape from §1, chosen precisely so a drop is
  one row). The delete removes exactly the one key being rewritten; the insert
  re-supplies it in full. Nothing else is touched. The per-screen-key and
  per-vendor independence is preserved because both the delete and the insert pin
  `(user_id, screen, vendor?)`.
- **RLS still holds on both legs.** DELETE is gated by the "delete own" USING
  clause and INSERT by the "insert own" WITH CHECK — a cross-user
  `saveCountOrder` deletes 0 rows and then fails the WITH CHECK (`42501`). Both
  helpers additionally pin `.eq('user_id', userId)` on the delete as
  defense-in-depth. No RLS gap is introduced.
- **The two partial unique indexes are correctly KEPT** as the duplicate guard
  (both files' comments say so explicitly; the pgTAP `23505` arm proves they fire
  as constraints). That is the right invariant to retain — they stop a concurrent
  double-insert from duplicating a NULL-vendor row.

I explicitly considered and **rejected** the two cleaner-on-paper alternatives:

- *A `SECURITY INVOKER` RPC running raw `INSERT … ON CONFLICT (…) WHERE …`* would
  give a real atomic upsert, but it adds a migration-coupled function signature
  and a SECURITY-DEFINER-adjacent surface for a private view pref — exactly the
  RPC surface my §3 argued against ("an RPC would add a … surface … for zero
  benefit"). Not worth it for a preference row.
- *A COALESCE'd non-null sentinel column for a total unique index* still can't be
  targeted by PostgREST's column-name `on_conflict` (it's an expression index, or
  a redundant column to maintain), so it would *also* need delete-then-insert or
  an RPC on the client. Strictly worse. The frontend notes reached the same
  conclusion.

Net: delete-then-insert is the minimal, correct shape. **No change requested.**

### Deviation 2 — `@dnd-kit` (web) + ▲/▼ (native), not `react-native-draggable-flatlist`. BLESSED.

Confirmed sound, and confirmed **no new dependency landed**:
`package.json` already carries `@dnd-kit/core`, `@dnd-kit/sortable`,
`@dnd-kit/utilities` (spec 008), and `react-native-draggable-flatlist` is
**absent** from `package.json` (grep: no match). My §9 recommended the RNDFL lib
but flagged it as a *new dependency for review* and named the fallback path
explicitly. The frontend empirically proved RNDFL no-ops on this project's
reanimated@4 web build; reusing the already-blessed, already-jest-allowlisted
`@dnd-kit` SidebarEditMode pattern is the better outcome — it avoids a new
dependency, a new EAS native-build risk, and the bundle-size review my §9 asked
for. This is the storage/apply contract being honored while the UI mechanism
improved; §9 itself said "the UI mechanism is orthogonal to the storage/apply
contract."

Native safety (the Critical bar in the prompt — "if the drag deviation breaks
native"): the wrappers gate the `@dnd-kit` import behind
`Platform.OS === 'web'` + `React.lazy(() => import('./CountOrderDragListWeb'))`
(admin `src/components/cmd/CountOrderDragList.tsx:27-30`, staff
`src/screens/staff/components/CountOrderDragList.tsx:19-22`), so the native bundle
never resolves `@dnd-kit` (a DOM-only package that would crash on native). Native
gets the ▲/▼ `TouchableOpacity`/`Pressable` path over a plain mapped `View`
column — pure RN primitives, no web-only API. The reorder math is the pure
`nudge(ids, index, delta)` helper, unit-tested
(`src/components/cmd/CountOrderDragList.nudge.test.tsx`). Native does not break.

The grip-handle-only drag surface (the `⠿` div carries the dnd listeners, the row
body does not) correctly keeps each row's decimal-pad inputs clickable/focusable —
important because these rows are data-entry rows, not static list items.

---

## Verification against the rest of the design

All PASS. Detail where it's load-bearing:

**Table + indexes + RLS + grants (§1.1/§1.2/§2)** — `20260630000500_user_count_orders.sql`
matches the design exactly: 6 columns, `screen` CHECK on the four OQ-7 keys,
`item_ids` jsonb with `jsonb_typeof = 'array'` CHECK, the two partial unique
indexes (`…_vendor_uq` WHERE vendor_id is not null / `…_novendor_uq` WHERE
vendor_id is null), no PK (correct — a PK can't treat NULLs as equal). Four
owner-scoped policies, all `auth.uid() = user_id`, single permissive policy per
command, **no `auth_is_admin` / `auth_can_see_store` / super_admin arm** (US-2
honored). Explicit grants to `anon, authenticated` (no TRUNCATE) + `service_role`
ALL, per spec-097. Not added to `supabase_realtime` (§11) — so the publication
restart gotcha correctly does NOT apply, and the migration header says so.

**No cross-user access (the Critical bar):** the pgTAP suite
(`supabase/tests/user_count_orders_rls.test.sql`, 13 assertions) asserts B cannot
SELECT/UPDATE/DELETE A's rows and cannot INSERT-as-A (`42501`), AND that a
super_admin JWT reads 0 of A's rows (assertion 7 — the no-bypass proof). RLS is
correct and tested. No cross-user leak.

**Pure module single-sourced (§5.1):** `src/lib/countOrder.ts` is dependency-free
(no supabase/React) and is imported by BOTH the admin path (`db.ts` type-imports
`CountOrderScreen`; the four screens import `applyCountOrder`/`firstUncounted`)
and the staff carve-out (`src/screens/staff/lib/countOrder.ts` re-exports them).
The ordering logic is not forked. `src/lib/countOrder.test.ts` (16 assertions)
pins OQ-3 partition, deleted-id ignore, null/empty identity, de-dup, AC-14
never-drop, and the AC-12 "jump follows custom order not default" regression.

**AC-9 render-only / submission scope (the Critical bar — "if a prior invariant
regressed"):** verified on all four screens that submission and the gate's COUNT
derive from the FULL set, never the ordered/searched view:
- admin EOD — `buildSubmission` and the gate's `missing` iterate `filteredItems`
  (EODCountSection.tsx:600, :690); the custom order only re-points the *render
  list* and the gate's *first-resolution*.
- admin Inventory — entries + `nonBlankCount` + the negative-value guard iterate
  `storeInventory` (InventoryCountSection.tsx:399, :216, :224); the C-FE-1 guard
  is intact; **no gate added** (line 864 comment + verified — correct per spec
  line 262).
- staff EOD — entries + the completeness count iterate `items`
  (EODCount.tsx:566, :539).
- staff Weekly — entries + the completeness count iterate `items`
  (WeeklyCount.tsx:465, :546).
No count RPC was changed (grep: the admin sections have zero `supabase.from/rpc`
call sites; they route through `db.ts`).

**AC-12 gate-jump follows custom order on the three gated screens:** admin EOD
(:693-697), staff EOD (:547-549), staff Weekly (:553-561) each resolve "first
uncounted" via `firstUncounted(applyCountOrder(fullItems, savedIds, idOf), …)`
when `viewMode === 'custom'`, else the screen's prior default ordering, after
clearing the search. Admin Inventory has no gate and none was added. Correct.

**Staff Weekly Custom view stays UN-WINDOWED (spec 102 / the Critical bar):** in
custom view the `SectionList` is replaced by a `ScrollView` whose children are a
plain mapped column via `CountOrderDragList` (WeeklyCount.tsx:906-930) — every row
mounted, no virtualization — so the gate jump's DOM-focus-scroll reaches any row.
The blocked-submit focus effect branches for custom view to skip
`scrollToLocation` and just focus the (already-mounted) target (:408-427). Sound.

**Search composes (AC-10):** all four screens filter the survivors and render
them in custom relative order, and **disable the drag affordance while a search
is active** (rendering plain mapped rows instead of `CountOrderDragList`) — a
necessary correctness choice I did not specify but endorse: reordering a filtered
subset would drop the hidden ids from the saved array. Good catch by the frontend.

**Migration additive + prod-apply pending:** additive, non-destructive, no
backfill; the dev correctly did NOT push to prod (flagged for the Supabase MCP
apply per §12). The `db-migrations-applied` gate will go red until the prod-apply
lands — that is the expected, designed state, and is the user's action.

---

## Should-fix (1)

**SF-1 — pgTAP does not exercise the app's actual delete-then-insert write path.**
The RLS/key-independence/uniqueness suite uses raw SQL
`INSERT … ON CONFLICT (…) WHERE …` (e.g. lines 229, 271) — the path the app does
NOT take after deviation 1. The 42P10 that broke the original upsert was *only*
caught by the frontend's live supabase-js probe, not by CI; if a future refactor
reintroduces a PostgREST `.upsert({ onConflict })` against these partial indexes,
nothing in the committed test suite fails. This is the same class of asymmetry
CLAUDE.md calls out (local-green / real-path-red). The screen-level jest does
exercise `saveCountOrder` through a mocked supabase channel (staff EOD/Weekly
tests with a `user_count_orders` builder), so the *helper contract* is covered —
but the *PostgREST-vs-partial-index* incompatibility is not regression-guarded.
Recommend (follow-up, non-blocking): a small jest or scripted assertion that
`saveCountOrder` issues a delete+insert (and NOT an `?on_conflict=` request), or a
comment in the migration + helpers explicitly forbidding `.upsert({ onConflict })`
against these two indexes. Not blocking — the current code is correct and the
inline comments already explain the 42P10; this only hardens against regression.

---

## Nit (4)

- **N-1 — stale comment in `db.ts:saveCountOrder`.** The doc comment (db.ts:1969-1970)
  still reads "`updated_at` is bumped … explicitly here on update so the row
  reflects the latest drop," but after deviation 1 there is no UPDATE leg — it's
  delete + insert, and `updated_at` is set on the insert only. Harmless, but the
  "on update" phrasing is now inaccurate. (The staff copy's comment is correct.)

- **N-2 — `created_at` column is write-only dead weight.** The table carries both
  `created_at` and `updated_at`, but delete-then-insert resets `created_at` to
  `now()` on every drop (the row is recreated), so `created_at` no longer means
  "first created" — it tracks the latest write, identical to `updated_at`.
  Neither column is read by any helper (the read selects only `item_ids`).
  Not worth a migration to drop; just flagging that `created_at` carries no
  meaning under the delete-then-insert write path.

- **N-3 — admin error surface bypasses `notifyBackendError`.** The admin sections
  use `console.warn(...)` + a direct `Toast.show(...)` on save/reset failure
  (e.g. EODCountSection.tsx:387-388) rather than the `notifyBackendError` helper
  the design referenced. This matches the surrounding admin-section style (the
  sections toast at the call site) and the optimistic-revert still fires
  correctly, so behavior is fine — but it is a minor divergence from the
  "surface via notifyBackendError" wording in §3/§10. Staff screens correctly use
  their `notifyBackendError`. No action needed unless you want symmetry.

- **N-4 — `.abortSignal(signal)` on the admin write legs can surface as a thrown
  error on unmount mid-drop.** `saveCountOrder`/`resetCountOrder` thread the
  inflight `signal` into the delete/insert (db.ts:1993, :2004, :2029). If the
  section unmounts between optimistic-set and the network resolving, the abort
  rejects the promise → the `.catch` reverts `savedIdsByVendor` on an unmounting
  component (a no-op React warning at worst) and toasts. The write to the server
  may have already committed the delete. In practice the next open re-reads truth
  and a torn state self-heals (per deviation-1 reasoning), so this is benign — but
  it's the one place the non-atomic write + abort interact. The read path
  aborting is fine; only noting the write+abort combination for completeness.

---

## Bottom line

Both forced deviations are correct and within the design's own stated fallbacks.
The storage shape, RLS (owner-scoped, no super_admin bypass), grants, the
single-sourced pure module, the AC-9 submission-scope invariant on all four
screens, the AC-12 gate-jump on the three gated screens, and the staff-Weekly
un-windowed Custom view all match the design. No new dependency landed; native is
not broken. No Critical findings. SF-1 (regression-guard the delete-then-insert
path) and the four Nits are all follow-up / cosmetic.
