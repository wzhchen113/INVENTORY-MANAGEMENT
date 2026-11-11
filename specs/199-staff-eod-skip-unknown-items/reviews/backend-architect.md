# Spec 199: backend-architect post-implementation drift review

Reviewer: backend-architect, 2026-11-10. Reviewed against the spec's "## Backend design" section (§0 to §10).

## What was checked

- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql`, compared with spec 193's wrapper at `supabase/migrations/20261109190000_staff_eod_date_bound.sql` L320-433.
- `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (plan 57).
- `supabase/tests/admin_submit_eod.test.sql` arm (16), L325-328.
- `src/screens/staff/lib/types.ts`, `src/screens/staff/hooks/useEodSubmit.ts`, `src/screens/staff/hooks/useEodSubmit.test.ts` (L115-128 and L538-836), `src/screens/staff/screens/EODCount.tsx` (L894-936), `src/screens/staff/screens/EODCount.test.tsx` (L1272-1321), and the three i18n catalogs.
- The md5 record in "## Files changed", cross-checked against spec 193's recorded values.
- Callers outside the staff subtree: `scripts/smoke-staff-eod.sh`, `e2e/eod.spec.ts`, `src/lib/db.ts` and the edge functions, checked for envelope key-set pins.

Limitation: this review had no shell access, so I couldn't run `git diff`, `psql` or the md5 queries. Byte-equality claims below come from line-by-line reads plus one exact-match grep. The md5 values are the developer's, cross-checked for consistency only.

## Verdict

**No Critical findings.** The implementation matches the design contract. There is 1 Should-fix and 4 Minor findings.

### Contract conformance (design section, result)

| Design item | Result |
|---|---|
| D-1: only the wrapper changes; the writer gets the filtered array | Conforms. The migration has a single `create or replace`, for `public.staff_submit_eod` (L138). It never mentions `eod_write_submission` except in the pre-flight and comments. It never touches `admin_submit_eod` or the trigger. No grants, no publication change. |
| Wrapper diff vs 193 | Conforms. L138-237 match 193's L320-413 line for line (signature, `security definer`, `set search_path = public`, steps 1, 1.5, 3, 4, O-1 and the date window, every comment). The only changes: five new `declare` variables (L154-158), the inserted R3 → R2 → R4 → filter block (L238-286), the writer's 5th argument `v_entries` (L296), and `v_result :=` plus the `||` return (L291, L304). The writer call keeps the "(5)-(7)" comment. |
| Function comment | Conforms. A leading spec 199 sentence, then 193's comment text. An exact-match grep of the full 193 comment tail hits once in each file. |
| D-2: `skipped_item_ids` always present on a non-replay success, absent on replay | Conforms (L304; the replay return at L200-204 is unchanged). Pinned by arms (13), (14) and (31). |
| D-3 / D-4: R3 and R4 messages, 22023 | Conforms. The strings are byte-equal to the design (L244, L276). There is no interpolation, DETAIL or HINT. Arms (20) and (21) lint them against the 42501, network and store-gate patterns. |
| D-5: one `FOR KEY SHARE` statement, ordered by id, in a FROM sub-select | Conforms (L263-269). |
| D-6: no skip audit | Conforms. |
| D-7: no writer change; Count cleared judged against the written entries | Conforms. The writer's NULL-branch `NOT EXISTS` (193 L185-189) reads `p_entries`, which is now `v_entries`. Arms (25) to (28) prove it. |
| §2.2 pre-flight: three conditions, 55000 | Conforms (L112-132). The `America/New_York` marker is 193-only, so the check tells 193 apart from 189 even though `not exists` is a weak marker on its own. |
| §2.1 header content | Conforms. It covers what changes, the R10 residuals (a), (b) and (c), the 185 sequencing note, the no-realtime-restart note, PROD-APPLY, ROLLBACK, the 193-rollback interaction and the test list. |
| R6 order: vendor → gate → replay → O-1 → date → R3 → R2 → R4 → writer | Conforms. Arms (30) and (34) to (36) pin each earlier gate winning over a stale payload. |
| SR-1: arm (16) of `admin_submit_eod.test.sql` | Conforms (L327-328: key array gains `skipped_item_ids`; the description says "plus spec 199's skipped_item_ids"). I couldn't run `git diff` to confirm no other hunk. The developer states there is none. |
| Writer, `admin_submit_eod` and trigger untouched (md5) | Consistent. The developer's normalized md5s (writer `f3ba9ae8…`, `admin_submit_eod` `27e88465…`, wrapper before `a32251eb…`) equal spec 193's recorded post-apply values (193 spec L898, L666) and spec 189's prod-apply record. The normalizer matches the one in 193 and in the MCP prod-apply procedure. |
| §5.1 types | Conforms. `skipped_item_ids?: string[]`; `success` gains `skipped_count?: number`. |
| §5.2 `isForbidden` | Conforms (`useEodSubmit.ts` L69-82). `STORE_GATE_TEXT` is the full prefix, a 42501 code beats a status, and the bare "message contains 42501" fallback is gone. The header comment cross-references the pgTAP pin by file. |
| §5.3 / §5.4 online | Conforms. The hook omits `skipped_count` at 0 (L333-336) and shows no toast. EODCount folds the notice into the single success toast as `text2` (L925-935); the no-skip call is unchanged. |
| §5.5 drain | Conforms (L149-152, L198-201, L239-263). It uses a ref accumulator, one rescheduled debounced toast, `showAllSynced` captured at scheduling time, and the byte-identical allSynced toast when n = 0. |
| §5.6 i18n | Conforms. There is one `{count}` token in each of en, es and zh-CN. |
| db.ts / useStore / realtime / edge functions | No change, as designed. The staff subtree is a documented carve-out. No direct Supabase call was added outside it. |
| Other callers | `scripts/smoke-staff-eod.sh` and `e2e/eod.spec.ts` read only `submission_id` and `conflict` with jq or the UI. Neither pins the key set, so neither is affected. |
| Prod-apply text (header L67-81 vs §7) | Accurate. It covers the pre-check versions `20261109120000` and `20261109190000`, the normalized md5 pre-check for wrapper and writer, recording `admin_submit_eod`'s md5, `execute_sql` of the full file, the 55000 stop, the exact version and name insert, the post-checks (md5s, `prosecdef`, `proconfig`, `proacl`, writer ACL not NULL, comment prefix), no `db push`, apply before push, and both gates plus e2e. The expected post-apply wrapper md5 (`dce41928…`) lives in the spec, not the header, which is fine. |
| Rollback text (header L83-93 vs §8) | Accurate. A forward migration restores 193's body and comment; the test file and arm (16) are reverted together; 199's data is kept; the client should roll back with the server; and a 193 rollback must restore this body minus the date block. |

## Findings

### Critical

None.

### Should-fix

**SF-1. The R10 structural pin passes on a comment, so it doesn't pin the lock.**
- Where: `supabase/tests/staff_submit_eod_skip_unknown.test.sql` L713-716, arm (55); `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql` L258-259.
- Arm (55) asserts `prosrc ilike '%for key share%'`. `prosrc` includes comments, and the migration's own comment at L259 reads `-- because FOR KEY SHARE is not allowed alongside an aggregate.` If a later edit (spec 185's wrapper rewrite is the named candidate) dropped or weakened the locking clause but kept the comment, arm (55) would still pass. R10's race would then quietly come back as a trigger 42501.
- Fix (test-only; no migration change): match the code, not the text. For example, strip line comments first and pin the clause with its alias:
  `regexp_replace(prosrc, '--[^\n]*', '', 'g') ~* 'for\s+key\s+share\s+of\s+ii'`.
  Update the arm description to match. The plan count is unchanged.

### Minor

**M-1. R9's legacy cross-store row has no arm.**
- §2.5 and R9 promise that a legacy (pre-2026-05-14) cross-store row whose item is skipped is deleted *with* a truthful `Count cleared` row. It must never be removed silently.
- The behaviour follows from the writer's unchanged NULL branch, so this isn't drift. But no AC covers it and no arm proves it.
- Optional follow-up arm: as `postgres`, inside the suite's transaction, `alter table public.eod_entries disable trigger eod_entries_check_store_trg`, insert X under a Frederick submission S, re-enable the trigger, then send `[I1]`. Assert one `Count cleared` row whose `item_ref` is X's name. The `alter table` lock is scoped to the test transaction.

**M-2. The online locked view briefly synthesizes skipped items.**
- Where: `src/screens/staff/screens/EODCount.tsx` L894-907.
- `enterLockedAfterWrite` sets `existing.entries` to the full submitted `entries`, skipped items included, before the confirmation refetch replaces it. If the refetch fails (the swallowed `catch` at L908), the locked view keeps showing a skipped item as counted until the next load.
- Only an item still in the in-memory catalog list renders at all, so the exposure is small. The `text2` notice tells the staff member the truth.
- Optional: filter `entries` by the skipped ids before synthesizing. That would need the ids, not just the count, on `Outcome`. Not required by any AC. Note it for the spec 193 / 185 queue follow-up.

**M-3. The jest suite's `beforeAll` 500 ms sleep stands in for a hook cleanup.**
- Where: `src/screens/staff/hooks/useEodSubmit.test.ts` L574-579.
- The hook never clears `allSyncedTimerRef` on unmount (pre-existing). The spec 199 describe therefore sleeps 500 ms so earlier describes' debounced toasts fire before it starts asserting on `Toast.show`.
- This is timing-coupled to `DRAIN_TOAST_DEBOUNCE_MS = 400`. If the debounce is raised, it becomes an order-dependent flake.
- Not drift. A future cleanup could add an unmount effect that clears the timer, or use fake timers. Out of scope here (§5.7 "Not changed").

**M-4. The `admin_submit_eod.test.sql` diff scope wasn't independently verified.**
- Arm (16)'s new content matches SR-1 exactly. That file also carries spec 193's uncommitted edits, and I had no shell access, so "only arm (16) changed for 199" rests on the developer's statement.
- Before committing, the owner or release-coordinator should eyeball `git diff supabase/tests/admin_submit_eod.test.sql` and separate the 199 hunk (two lines at L327-328) from 193's.

## Notes (no action)

- **Lock semantics.** These are correct as built:
  - The `ORDER BY` sits below `LockRows`, so locks are taken in id order.
  - Cross-store rows are filtered out by `store_id = p_store_id` before they are locked, so a foreign store's items are never locked.
  - The writer's own `current_stock` UPDATE (NO KEY UPDATE) is compatible with the KEY SHARE taken in the same transaction.
- **`'{}'` versus `[]` for an empty skip list.** `to_jsonb(array(select … where false))` gives `[]`, not `null`. Arm (14) pins this.
- **Installed (pre-199) clients.** A NULL `ingredient_id` now gets 22023 instead of the trigger's 42501, so an old client would retry it instead of dequeuing it. The shipped client can't produce that payload (`entriesForRpc` maps a typed `item_id`), so this is theoretical.
- **Sequencing.**
  - The migration's version `20261110130000` is the latest on disk.
  - Spec 193 (`20261109190000`) sorts before versions that are already on prod (`20261109191000` … `20261110120000`). That is expected under the MCP apply procedure (§7 forbids `db push`).
  - The 55000 pre-flight blocks a 199-before-193 hand apply.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (SF-1: arm (55)'s FOR KEY SHARE pin is satisfied by a comment in prosrc; tighten to a comment-stripped regex), 4 Minor (M-1 legacy cross-store Count cleared arm, M-2 locked view synthesizes skipped items on refetch failure, M-3 timing-coupled beforeAll sleep, M-4 confirm the admin_submit_eod.test.sql diff scope by hand).
payload_paths:
  - specs/199-staff-eod-skip-unknown-items/reviews/backend-architect.md
