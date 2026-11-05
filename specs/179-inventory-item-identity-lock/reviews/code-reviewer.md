## Code review for spec 179

Scope: `supabase/migrations/20261026100000_inventory_items_identity_lock.sql` and `supabase/tests/inventory_items_identity_lock.test.sql` only. I compared them against `## Backend design` (D-1 to D-10, §2, §9) and spec 177's migration and test. I did not run anything (read-only). Architecture and security are deferred to the other reviewers.

Verdict: the migration matches the design line for line and the house style of spec 177. The test file is sound. The findings below are about test arms that don't prove what their description claims, not about the migration.

### Critical
None.

- No `supabase.from(...)` or other `src/**` change. No legacy file touched. No `app.json` change.
- No RLS policy, publication or existing-function change.
- The version slot `20261026100000` is free. The newest file on disk besides this one is `20261025000000`, and no `20261026000000` exists yet.

### Should-fix

- `supabase/tests/inventory_items_identity_lock.test.sql:739-745` and `:786-793` (T54 / T61) — the "count unchanged" snapshot is taken after the arms it is meant to guard, so T61 is vacuous for them.
  - The design put T54 (snapshot) before T55-T60. Grouping arms by role moved the snapshot to the postgres block, which runs after T57 and T59.
  - T59 (`:512-520`) runs an unfiltered `update ... set store_id = <A>` and `delete from ...` against the tombstone table as admin, and asserts only `lives_ok`.
  - If RLS stopped hiding the rows and T59 deleted them, `tomb_count` would be captured already reduced. T61 would still pass its count comparison.
  - The (B1, store B) existence check inside T61 is the only real tripwire. T30, T34, T40 and T49 also catch a wholesale wipe or re-store, because they run after T59. They don't prove "0 rows affected" for a partial change.
  - Fix: take the snapshot before T59, with a short `reset role; snapshot; set local role authenticated; claims` hop just before T59. Or assert the row counts inside T59's DO block with `get diagnostics`.
  - Keep the `> 0` anti-vacuity check, but run it at the same point.

- `supabase/migrations/20261026100000_inventory_items_identity_lock.sql:196-199` vs the test file — the "reinsert with a NULL `store_id` is refused" branch is documented but never exercised.
  - The migration comment (`:210-211`) says "different (or NULL) store_id". Design D-4 says "The reverse case is handled".
  - No arm inserts a tombstoned id with `store_id` NULL. T52 / T53 cover only the other half, a storeless delete that records nothing.
  - A mutation of `is distinct from` to `<>` would pass all 73 arms and silently let a tombstoned id come back storeless.
  - Fix: add one `throws_ok` that inserts a tombstoned id (for example iB1 or iB3) with `store_id` NULL and expects the R-2 message. It would also need a `plan(74)`.
  - This overlaps the test-engineer's coverage review. I'm raising it here because it is a stated behaviour of the shipped function.

### Nits

- `inventory_items_identity_lock.test.sql:341, 402, 529` (and throughout) — the T-numbers appear out of order in the file, because arms are grouped by role. For example, T20 is at line 341, T06 at 402 and T15 at 529. TAP output is numbered by execution order (`ok 6 - T20 ...`), so the TAP index and the label disagree. Spec 177's file is nearly monotonic. Either renumber to execution order or add a one-line note in the header that labels follow the design table, not file order.

- `inventory_items_identity_lock.test.sql:649-672` (T35-T37) — the AC-10 arms pin a pre-existing failure, a bare `delete from brands` raising 23503 on `inventory_items_catalog_id_fkey`.
  - The comment explains this well. Two risks remain. The assertion depends on RI-trigger oid ordering. When the follow-up fixes brand delete, T35 flips red and T36 / T37 need to become positive arms.
  - Add a literal marker such as `-- FLIP when hard_delete_brand() cascade is fixed: expect lives_ok + 2 tombstones` so the next person knows what to change.
  - Worth keeping the finding visible to the owner (the developer already listed it under deviation 2). The architect's post-impl review should confirm the AC-10 re-pin.

- `20261026100000_inventory_items_identity_lock.sql` header and comments (`:17-19`, `:124-127`, `:166-171`) say the tombstone writer records "store/brand cascade deletes". The developer found that the brand path never reaches `inventory_items` today (deviation 2), so only the store cascade is proven. The statement is true in design, but misleading to a reader of the migration. A short note that the brand path is reachable only once the brands to catalog_ingredients ordering issue is fixed would be more accurate. Header and `comment on` edits don't change the normalized function md5s, but re-run pgTAP anyway.

- `inventory_items_identity_lock.test.sql:751-784` (T56 / T58 / T60) — three near-identical catalog probes, and they are also covered by T64 (zero policies, RLS on, not forced). Collapse into one arm, or factor the shared predicate. The deviation itself (catalog form instead of `set role anon`, spec 067) is correct and matches existing files (`profiles_insert_hardening`, `items_last_counted`, `report_weekly_lowstock`).

- `inventory_items_identity_lock.test.sql:905-915` (T73) — only the BEFORE UPDATE order is pinned. The migration header (`:47-48`) also asserts "no other BEFORE INSERT or AFTER DELETE trigger" on `inventory_items`. That claim isn't pinned. This is cheap to add, but optional.

- `inventory_items_identity_lock.test.sql:262-266` (T05) — the alias `pi` shadows the built-in `pi()` function name. It is harmless, but `poi` would read better.

- (out-of-scope) `specs/179-inventory-item-identity-lock.md:526-531` — the design table still lists T32-T37 in their original form (T35 `lives_ok`, T37 count 2). The test now asserts something different. `## Files changed` documents it, so no action here. If the spec is archived, a one-line "superseded by deviation 2" next to the table would prevent confusion.

### Checked and fine

- Migration:
  - Wrapper (`begin; set local lock_timeout = '5s'; … commit;`) and re-run safety (`create or replace`, `drop trigger if exists`, `create table if not exists`, idempotent revokes).
  - All three EXECUTE revokes.
  - `search_path` pinning: invoker lock = `public`, definer pair = `''` with every relation schema-qualified.
  - Static messages with no row data.
  - Trigger and function names as designed (D-8), with the `_trg` suffix matching spec 177.
  - No FK and no FORCE RLS on the tombstone table, as D-6 requires.
  - TRUNCATE revoke present (D-1 Option A).
  - PROD-APPLY paragraph names the exact version, normalized-md5, `tgenabled = 'O'` and the §10 pointer, as R-4 requires.
- Test file:
  - `begin; … rollback;`, with every fixture created inside the transaction.
  - Every `throws_ok` asserts both SQLSTATE and exact message.
  - Anti-vacuity arms T01-T03 prove the two-store callers see both stores.
  - Every acceptance arm re-reads the row.
  - Per-item catalog rows avoid `(store_id, catalog_id)` masking.
  - T06 and T09 assert the design's ordering assumptions without loosening them.
  - The `pg_temp.claims` helper reduces the repeated JWT blocks from spec 177.
  - The file sits in the established pgTAP track (`supabase/tests/`, run by `scripts/test-db.sh`).

---

## Fix round 1 re-review

Scope: the "Fix round 1" entry under `## Files changed`, plus the edited migration and test file. Read-only; nothing was run, so the developer's reported results (80/80, negative controls 27/80 and 7/80) are taken from the entry.

Status of the earlier findings:

| Finding | Status | Evidence |
|---|---|---|
| Should-fix 1 (T54 / T61 snapshot) | Fixed | The snapshot now runs in a `reset role` hop (test lines 550-563) before T55, T57 and T59, which are the only admin touches of the tombstone table. T61 (908-920) compares to the snapshot and pins the exact count. See new Should-fix N1 on that pin. |
| Should-fix 2 (NULL `store_id` arm) | Fixed | T78 (890-899) inserts the tombstoned iB1 with `store_id` NULL as postgres and expects the R-2 message. T79 reads back 0 rows. The postgres-only scope is correct (RLS refuses a NULL store first for authenticated) and is explained in the comment. |
| Nit: T-number order | Fixed | The header note at test lines 42-43 says labels follow the design table. |
| Nit: T35-T37 FLIP marker | Fixed | Lines 706-708 say exactly what to flip. |
| Nit: brand-cascade wording | Fixed | Migration header (19-25), writer comment (190-195) and table comment (145-152) now say "store-delete cascades", and the header states the brand delete fails today with a pre-existing 23503. |
| Nit: `pi` alias | Fixed | T05 now uses `poi`. |
| Nit: T73 only pins BEFORE UPDATE | Partly fixed | T72 (1014-1037) now also pins "no non-internal BEFORE INSERT trigger" (`3|0`), which backs the new header claim at migration 57-61. The "no other AFTER INSERT or AFTER DELETE trigger" half of that sentence is still unpinned. Optional. |
| Nit: T56 / T58 / T60 triplicate | Open (accepted) | Not collapsed. M-2 added the owner-membership conjunct to T58 and T60, so the three blocks now differ only in the `cmd` list. A single helper or one combined arm would shrink about 40 lines. Optional. |
| File-name slip in the third nit | Fixed in this file | It now names `20261026100000_inventory_items_identity_lock.sql`, and the rambling sentence is shortened. |

New code (AFTER INSERT check, narrowed probe, T74-T80):

- Migration `inventory_items_check_tombstone()` (lines 220-243).
  - Returning `null` from an AFTER row trigger is correct. The narrowed probe (`ii.store_id is distinct from new.store_id ... for key share`) is readable and the trade-off is explained. It also keeps the probe off the statement's own new row.
  - The AFTER INSERT ordering is explained once, in the section comment (208-219). Header lines 26-35 and 63-69 restate parts of it, and the `comment on function` (245-253) repeats it again. That is three copies of the concurrency and ordering story. Consider trimming the header to one line each and pointing at the section comment. This is a nit, not a convention break.
  - Spec 177's style is followed: `security definer` + `search_path = ''`, revoke, `drop trigger if exists`, trigger name unchanged.
- Test T74-T77 (writable-CTE arms).
  - These follow the established `format($q$...$q$)` shape and use the same `message + SQLSTATE` assertions as the older arms.
  - T75 and T77 re-read state: row still in B, not in A, 0 tombstones.
  - Each uses its own fixture and catalog (iB7 / cB7, iB8 / cB8), so no unique-index collision can stand in for the trigger.
  - The master and postgres variants are split across the file by caller (T76 at 413-425, T77 at 877-888), consistent with the header note.
- T80 (zero-store caller).
  - The assertion is correct and the comment says why the RLS message is the right outcome.
  - The anti-vacuity guard is a bare `raise exception` in a DO block (533-539). If the zero-store caller ever sees A or B, the whole file aborts with an error instead of one arm failing. Spec 177 and T01-T03 use an `ok(...)` arm for the same job. It is a minor consistency point. An `ok()` arm would need `plan(81)`.
- T72 (1014-1037): the `format('%s|%s', <count>, <before-insert count>)` result compared to `'3|0'` is dense, and a `--` comment sits inside the argument list. It reads acceptably, but two separate arms would give a clearer failure message. Optional.

New findings:

### Should-fix
- `supabase/tests/inventory_items_identity_lock.test.sql:912-920` (T61) — `count(*) = 5` is an absolute count of the whole tombstone table, so it depends on the table being empty when the file starts.
  - The table persists, and the tombstone writer fires for every real item delete. A local dev stack where anyone has deleted an item or store through the app after this migration (or a developer who runs `scripts/test-db.sh` against a long-lived stack) will have extra rows, and T61 fails for reasons unrelated to the code under test.
  - CI builds fresh, so it would be green, which hides the problem until someone runs the suite locally against a used stack. Every other absolute-looking count in the file (T37, T28, T30, T34, T49) is scoped to fixture ids.
  - The snapshot comparison alone (`= test.tomb_count`) is already robust, since it is a delta. Fix: scope the "exactly 5" half to fixture rows, for example `where id::text like 'c1790001-%'`, or drop it and keep the snapshot comparison plus the (B1, store B) existence check. The BEFORE INSERT negative control would still fail T61 for the scoped form, because the extra tombstones come from fixture ids.

### Nits
- `20261026100000_inventory_items_identity_lock.sql:147-152` — the re-wrapped table comment has one line (150) much longer than its neighbours after the AFTER INSERT edit. The same applies to test header line 13. Cosmetic.
- Migration header 63-69, section comment 208-219 and `comment on function` 245-253 duplicate the ordering and concurrency explanation. See above.
- `inventory_items_identity_lock.test.sql:533-539` — T80's guard is a DO-block `raise exception`, not an `ok()` arm. See above.

Net: Should-fix 1 and 2 are closed. There is one new Should-fix (the absolute count in T61) and three cosmetic nits. No Critical.

## Handoff
next_agent: NONE
prompt: Code re-review complete (fix round 1). 0 Critical, 1 Should-fix (T61 absolute count), 3 new Nits; earlier Should-fix 1 and 2 closed.
payload_paths:
  - specs/179-inventory-item-identity-lock/reviews/code-reviewer.md
