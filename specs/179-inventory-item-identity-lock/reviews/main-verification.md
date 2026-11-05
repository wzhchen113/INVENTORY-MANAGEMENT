# Spec 179: main Claude verification of fix round 1b and the final gate run

Main Claude ran these checks on 2026-10-26 after fix round 1b. Fix round 1b is small (T61 scoping plus L4 wording), so main Claude checked it directly instead of asking code-reviewer and security-auditor for another full pass.

## Fix round 1b items

| Finding | Source | Check | Result |
|---|---|---|---|
| T61's absolute `count(*) = 5` | code-reviewer, fix round 1 re-review, Should-fix | `grep "c1790001-%"`: the T54 fixture snapshot (test L563) and T61 (L927) are both scoped to fixture ids | Closed |
| L4: REPEATABLE READ/SERIALIZABLE fails closed only when the other-store row was in the inserting transaction's snapshot; the created-and-deleted-after-snapshot case is a residual | security-auditor, fix round 1 re-review, Low, option (a) | Wording is present in the migration header (L68-75), the R-2c section comment (L223-230) and `comment on function` (L263), plus spec D-7 and §11 risk 6 | Closed (wording only, as the owner chose; option (b), the claim table, was not built) |

The developer reports the normalized md5s are unchanged by 1b: `0af4acdb…` (lock), `9cfb8c5a…` (check), `a00f5436…` (writer). The test-engineer independently confirmed `9cfb8c5a…` in fix round 1.

## Final gate run (main Claude, local)

| Gate | Result |
|---|---|
| `supabase/tests/inventory_items_identity_lock.test.sql` | 80/80 `ok`, none `not ok` |
| `bash scripts/test-db.sh` | 92/93 files pass, exit 1. The only red file is spec 178's untracked `supabase/tests/order_approvals_fk_set_null.test.sql`: 8/12 fail (D1a-D4b) with the `order approval is immutable` guard. It doesn't involve spec 179, and the failure was present before this spec existed. |
| `npx jest` | 267 suites / 3340 tests pass, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:test` | exit 0 |

## Not verified

- The D-7 REPEATABLE READ 40001 path. Showing it needs a committed delete in the shared local DB, so it stays reasoned and pinned by the md5.
- Prod. Nothing has been applied, and the §10 runbook is owner-gated.
