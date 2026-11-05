# Release proposal: spec 179 (inventory item identity lock)

Author: release-coordinator, 2026-10-26. Advisory only.

**Round 2 sources (this update).** I re-read every file in `specs/179-inventory-item-identity-lock/reviews/`:
- the "Fix round 1 re-review" sections of `code-reviewer.md`, `security-auditor.md` and `test-engineer.md`;
- the new `main-verification.md`, which covers fix round 1b and the final gates;
- `backend-architect.md`, which is unchanged since its post-impl pass. The architect's fix-round-1 amendment lives in the spec's `## Backend design`, which I read (D-3, D-5, D-7, D-8).

I also read the "Fix round 1" and "Fix round 1b" entries under the spec's `## Files changed`, and spec 177's `reviews/prod-apply.md`.

The round-0 proposal (FIXES_NEEDED) is kept at the bottom of this file for the record. It is superseded by the verdict below.

## Verdict
verdict: SHIP_READY (conditional on the owner-gated path below; nothing is applied to prod or pushed yet)
rationale: Every Should-fix and Medium finding from round 0 and fix round 1 is closed. No reviewer has an open Critical, High or Medium. All three vectors are now refused for every caller at READ COMMITTED, which covers every app path. The two open security Lows and the reasoned-only concurrency path are explicitly accepted residuals, and every gate spec 179 owns is green.

**Conditions on this verdict:**
- **The CLAUDE.md `main` CI rule.** I have no shell in this pass, so I did not check the latest `test.yml` / `db-migrations-applied.yml` runs on `main`. The rule applies at push time. If either latest run on `main` is red or in progress when the push is about to happen, this verdict does not hold until it is green.
- **SHIP_READY does not authorize a commit or a prod apply.** The user runs the commit, and the prod apply needs the owner's explicit go-ahead.

## Fix round 1 outcome

### Round-0 findings: all closed

| Finding | Severity | Fix | Verified by |
|---|---|---|---|
| Security **M1**: a single-statement writable CTE (delete + reinsert) bypassed R-2 | Medium | The check is now **AFTER INSERT** and returns null. AFTER row events fire in queue order, so the DELETE's tombstone exists before the INSERT's check reads it. | security-auditor re-probe, refused as `postgres` and as an `authenticated` master; T74-T77; §10 probe 4 |
| Security **L1**: a deleted-id oracle for zero-store callers | Low | Closed as a side effect: the check now runs after RLS WITH CHECK. D-5's reasoning was corrected. | security-auditor re-probe (4 identical RLS answers); T80 with an anti-vacuity guard |
| Security **L3**: the runbook's "expect 0" tombstone count | Low | Step 5 compares against the N4 count recorded in Step 4 | security-auditor |
| Code-reviewer **SF-1** / architect **M-3**: T54/T61 snapshot ordering | Should-fix | The snapshot hop now runs before T55/T57/T59, and T61 asserts the delta plus an exact count | code-reviewer, test-engineer |
| Code-reviewer **SF-2**: the NULL `store_id` reinsert branch was untested | Should-fix | T78/T79 run as `postgres` (an `authenticated` caller is stopped by RLS first, as predicted) | code-reviewer, test-engineer |
| Recommended nits | Nit | FLIP marker on T35-T37, softened brand-cascade wording, owner-membership check added to T58/T60, a label-order note, `pi` alias renamed to `poi` | code-reviewer |

**The REPEATABLE READ question (round-0 step 1).** The architect re-ruled D-7 instead of dropping the probe. The `FOR KEY SHARE` probe is kept in a narrower form (other-store rows only), so:
- it takes no extra lock on a normal insert. The security-auditor verified this through `xmax`;
- it fails closed with 40001 under REPEATABLE READ / SERIALIZABLE when the deleted other-store row was visible to the inserting transaction's snapshot.

### Fix round 1 findings: closed or accepted

| Finding | Severity | Status |
|---|---|---|
| Code-reviewer **N1**: T61's absolute `count(*) = 5` would fail on a long-lived local stack | Should-fix | **Closed in fix round 1b.** The count is scoped to the fixture ids (`c1790001-%`), and the whole-table delta is kept. The developer showed that 80/80 pass with two foreign tombstones pre-seeded, and the BEFORE-INSERT timing control still fails 7/80. Main Claude confirmed the scoping (`main-verification.md`). This was not an independent code-reviewer re-pass. That is acceptable, because it is a test-only scoping change and its behaviour is pinned by the controls. |
| Security **L4**: under REPEATABLE READ / SERIALIZABLE, a row both created and deleted after the inserting transaction's snapshot is missed | Low | **Accepted residual, option (a), owner's choice.** The wording was corrected in the migration header, the R-2c section comment, the `comment on function`, spec D-7 and §11 risk 6. Option (b), an id-to-store claim table, was not built. |
| Code-reviewer cosmetic nits: triplicated ordering/concurrency prose, a long comment line, T80's guard is a `raise` and not an `ok()` arm, T72's dense `'3\|0'` form, T56/T58/T60 not collapsed, the "no other AFTER INSERT/DELETE trigger" claim unpinned | Nit | Open, optional, not blocking. The long line was wrapped in 1b. |

### Accepted residuals (non-blocking; record them with the ship decision)

1. **Security L2.** `anon` and `authenticated` keep TRIGGER, REFERENCES and MAINTAIN on `public.inventory_item_tombstones`.
   - This comes from the project-wide default ACL.
   - It is unreachable: those roles are NOLOGIN, and PostgREST can't run DDL.
   - Tracked in the spec 170 L4 sweep (see Out of scope).
2. **Security L4, option (a) residual.** Under REPEATABLE READ / SERIALIZABLE, an other-store row that was created **and** deleted entirely after the inserting transaction's snapshot is invisible to both the probe and the tombstone read. A cross-store reinsert of that id then succeeds.
   - Only a raw `postgres` / `service_role` session can reach it, by holding an RR/SERIALIZABLE transaction open across the row's whole lifetime and learning its uuid some other way.
   - PostgREST runs READ COMMITTED, and no `public` function raises its isolation level in `proconfig`.
   - Revisit with option (b) only if RR writers are ever introduced.
3. **The D-7 REPEATABLE READ 40001 path is reasoned, not demonstrated.** A demo needs a committed delete in the shared local DB.
   - The security-auditor, the architect and the test-engineer all reasoned it the same way.
   - The check function's md5 `9cfb8c5a…` pins the probe body, and §10 Step 4 rechecks it on prod.
   - The READ COMMITTED path, which is every app path, is reasoned too. Its single-transaction equivalents are covered by T41/T43 and T74-T77.

## Findings summary (current)

- **code-reviewer:** 0 Critical. Round-0 SF-1 and SF-2 fixed, and fix round 1's N1 closed in 1b. The remaining items are optional cosmetic nits.
- **security-auditor:** 0 Critical, 0 High, 0 Medium. M1, L1 and L3 resolved. Two Lows open and accepted: L2 (out of scope, spec 170 L4) and L4 (option (a) residual).
  - Re-verified:
    - upsert behaviour on a live id;
    - the narrowed probe takes no lock;
    - §10 probe 4 raises on every path;
    - the definer hygiene is unchanged (`prosecdef`, `search_path ""`, `proacl`).
- **test-engineer:** 23/23 AC PASS, 0 FAIL, 0 NOT TESTED.
  - AC-11, AC-12 and AC-16 strengthened; AC-18 updated (the check is AFTER INSERT, and no BEFORE INSERT trigger remains).
  - The new file passes 80/80.
  - Negative controls, both reproduced independently:
    - **three triggers disabled:** 27/80 fail;
    - **check re-attached BEFORE INSERT:** 7/80 fail. The test-engineer also used the real pre-fix body (md5 `b8abd897…`), which proves the new arms catch the actual M1 bug.
  - The first full run had two transient reds (`missed_order_audit_rpc`, `profiles_locale`). Neither references `inventory_items`. Both passed alone and were clean in run 2, so they are attributed to shared-DB interference from concurrent sessions.
- **backend-architect:** 0 Critical, no contract drift (post-impl review). The fix-round-1 amendment (D-3/D-5/D-7/D-8, §2.4, §9, §10 Steps 4-5, §11) was implemented as designed, according to all three re-reviewers.
- **Final gates** (`main-verification.md`, local, after 1b):
  - the new file passes 80/80;
  - `scripts/test-db.sh` passes 92/93. The only red is spec 178's untracked `order_approvals_fk_set_null.test.sql` (8/12 fail on the `order approval is immutable` guard). It is unrelated and predates spec 179;
  - jest passes 267 suites / 3340 tests;
  - `npm run typecheck` and `npm run typecheck:test` exit 0.
- **Normalized md5s**, unchanged by 1b:
  - lock `0af4acdbda17cdab680f113f7378946a`;
  - check `9cfb8c5a2e02129e7ec9c1917c33d4d3`, which supersedes `b8abd897…`;
  - writer `a00f5436b51e1550023d51cabb96c55e`.

## Recommended next steps (ordered): the owner-gated path

1. **Spec 177's prod apply comes first.** It is already done: spec 177's `reviews/prod-apply.md` records `20261025000000` applied verbatim and recorded in `schema_migrations` on 2026-10-26, after the owner's go-ahead. §10 Step 1 of this spec re-confirms it on prod (expect `20261025000000`, plus spec 177's three triggers `O`). If that pre-check doesn't show it, STOP.
2. **§10 M-1 local recheck.**
   - Re-apply the committed file locally (`db reset`, or `migration up --local`).
   - Recompute the three normalized md5s. They must equal **`0af4acdb…` (lock), `9cfb8c5a…` (check), `a00f5436…` (writer)**.
   - A mismatch means the file changed after testing: STOP and re-run pgTAP.
3. **Prod apply, only on the owner's explicit go-ahead (§10 Steps 1-5, project `ebwnovzzkwhsdxkpyjka`):**
   - **Step 1:** the read-only pre-check. STOP on any unexpected value.
   - **Step 2:** `execute_sql` of the committed migration file verbatim, in one call. Do not use `apply_migration`.
   - **Step 3:** insert the exact version `'20261026100000'` into `schema_migrations`, then run the confirm select.
   - **Step 4:** verify the md5s against the three values above, the trigger presence and event lists (the check must be **AFTER INSERT**), the privileges and the table posture. Record the tombstone count as N4.
   - **Step 5:** run the four raise-always probes, including probe 4 (the writable CTE). Expect `PROBE OK` from each, and the tombstone count to equal N4 afterwards. `PROBE FAILED` means STOP and do not push.
4. **Commit by pathspec.** The user runs the commit.
   - The spec 179 paths are:
     - `supabase/migrations/20261026100000_inventory_items_identity_lock.sql`;
     - `supabase/tests/inventory_items_identity_lock.test.sql`;
     - `specs/179-inventory-item-identity-lock.md`;
     - `specs/179-inventory-item-identity-lock/`.
   - Use `git commit -- <179 paths>`, or commit 176 and 177 first in their own commits. A bare `git commit` sweeps up the staged 176/177 changes.
   - **Never stage spec 178's `supabase/tests/order_approvals_fk_set_null.test.sql`.** It turns `test.yml` red until spec 178 lands its migration.
   - Also leave out the other sessions' unstaged `src/**` work (i18n, staff EOD) that the test-engineer saw in the tree. It is not part of spec 179.
5. **Push only after the prod apply (Steps 2-4) succeeds.**
   - The push carrying `20261026100000` must also carry spec 177's `20261025000000`, or come after it on `main` (spec 177 M-3).
   - It must not carry a spec 178 migration that isn't on prod yet.
   - Before pushing, confirm the latest `main` runs of both gates are green (the CLAUDE.md rule and this verdict's condition).
6. **After the push:**
   - confirm the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green (`gh run list --branch main --workflow <file> --limit 1`);
   - check `e2e.yml` by hand (project memory);
   - if any run is red or in progress, surface the run URL and wait for the user;
   - CI's first run of T35 also confirms the RI-trigger order (architect M-5). A failure there reports a pre-existing ordering fact, not a spec 179 regression.
7. **Optional, non-blocking follow-ups:**
   - the remaining cosmetic nits from code-reviewer's fix-round-1 re-review;
   - option (b), the claim table, if REPEATABLE READ writers are ever introduced.

## Out of scope for this review
- **S-3: the brand and store cascade-order bugs** (backend-architect S-3, developer deviation 2). These should become a new spec. Both predate spec 179:
  - `hard_delete_brand()` can't purge a brand whose stores own items (23503 on `inventory_items_catalog_id_fkey`);
  - a direct store delete fails while any of its items has a `po_items` line. `eod_entries` and `inventory_count_entries` are probably affected too, which is unverified;
  - `deleteStore` (db.ts L185-191) swallows the error.

  T35-T37 carry a FLIP marker: when that spec lands, they flip to positive tombstone assertions.
- **Security L2: the TRIGGER/REFERENCES (and MAINTAIN) grant sweep.** Fold it into spec 170 L4, the project-wide default-ACL / 47-table TRUNCATE sweep. The optional per-table widening of the tombstone table's revoke was not taken.
- **Spec 178's red `order_approvals_fk_set_null.test.sql`.** It is in-flight and unrelated, and stays untracked until spec 178 lands its migration.
- Already recorded in spec §11 and out of scope as written:
  - TRUNCATE on `inventory_items` itself (N6);
  - tombstone retention;
  - non-canonical uuid spellings in approval lines;
  - an FK on `order_approvals.lines[].item_id`.

---

## Round 0 proposal (superseded by the verdict above; kept for the record)

Round 0 sources: the spec (including `## Backend design`, §10, §11 and `## Files changed`), all four reviewer files, and the migration's header and R-2 section (L1-60, L160-224), read to check M1 against the shipped code.

### Round 0 verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical, and every gate spec 179 owned was green. But security M1 showed that vector 3 (delete, then re-insert under another store) was still open for every caller when both happen in one statement. That broke R-2's "applies to every caller" promise and the owner's "close all three vectors" request. A tested fix existed, it stayed inside the scope fence, and that was the cheapest moment to apply it: the migration was not yet on prod or pushed.

### Round 0 findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix, 6 Nit.
  - SF-1: the T54/T61 snapshot was taken after the arms it guards.
  - SF-2: the NULL `store_id` reinsert branch was untested; a `<>` mutation would have passed all 73 arms.
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 3 Low.
  - M1: the single-statement CTE bypassed the BEFORE INSERT check.
  - L1: a deleted-id oracle for zero-store callers.
  - L2: the TRIGGER/REFERENCES/MAINTAIN default ACL.
  - L3: the runbook's "expect 0" count, fixed by the architect.
- **test-engineer:** 23/23 AC PASS with qualifiers on AC-10, AC-20 and AC-23. 73/73. Negative control 21/73.
- **backend-architect:** 0 Critical, no drift. S-1 and S-2 (runbook commit and staging hygiene) fixed in §10. S-3 is the out-of-scope cascade bugs. Five Minors.

### Round 0 weighing of M1
- M1 was not Critical: it was unreachable from any untrusted surface.
- It was still worth fixing:
  - it broke an owner-approved requirement and the migration header's own claim;
  - the fix was small and tested, and also closed L1;
  - the migration was not yet applied, so the fix cost only new md5s.
- The alternative, documenting the residual instead of fixing it, needed the owner's sign-off.
- Round 0 also raised a REPEATABLE READ concurrency question about dropping the `FOR KEY SHARE` probe, for the architect to rule on.

### Round 0 fix plan (all executed in fix rounds 1 and 1b)
1. backend-architect: amend the design for the AFTER INSERT check and rule on REPEATABLE READ.
2. backend-developer: implement M1 in place, and add the CTE arms (as `postgres` and as `authenticated`) plus an optional L1 arm.
3. backend-developer: add the NULL-store reinsert arm, run as `postgres`.
4. backend-developer: fix the T54/T61 snapshot.
5. backend-developer: nits (FLIP marker, header wording, the T58/T60 conjunct).
6. backend-developer: bump the plan, recompute the md5s, re-run the negative control and all gates.
7. Parallel re-review, then release-coordinator.
8. The owner-gated path.
