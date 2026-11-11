# Spec 189: prod apply record

Applied by main Claude on 2026-11-09 to project `ebwnovzzkwhsdxkpyjka` through the Supabase MCP. The owner gave the go-ahead with "Apply to prod". This followed spec §14. Nothing was pushed before the apply.

## 1. Read-only pre-checks (all passed)

| Check | Result |
|---|---|
| 193's version absent from `schema_migrations` | Absent. Latest applied: `20261108000000`, `20261108120000` |
| AC-32 duplicate pairs (with the NULL filter) | 0 |
| Role drift (admin/master `profiles.role` vs JWT `app_metadata.role`) | 0 |
| DELETE or ALL policy on `eod_entries` / `eod_submissions` | None |
| `staff_submit_eod` body is the expected pre-189 one | Whitespace-normalized md5 `4c7e739463491fa9ff25a967bdbe9668`, the same value local had before 189 (checked 2026-11-08) |
| New objects absent | `admin_submit_eod`, `eod_write_submission` and the unique index were all absent |
| Row counts before | 3,470 entries, 229 submissions |

## 2. Apply

- The migration file `supabase/migrations/20261109120000_admin_eod_replace.sql` (file md5 `cc18b25bd85dd7bbb6b5397cf01cb577`, with the §3.4 Rule C edit) was sent verbatim, including its `begin; set local lock_timeout = '5s'; … commit;` wrapper, in one `execute_sql` call. No error, so the pre-flight found no duplicates.
- Recorded `insert into supabase_migrations.schema_migrations (version, name) values ('20261109120000','admin_eod_replace')`. It reads back as present.

## 3. Verify (prod matches local exactly)

Comment-stripped, whitespace-normalized md5 of `pg_get_functiondef`:

| Function | Normalized md5 (prod = local) | prosecdef | proconfig | proacl | EXECUTE anon / authenticated / service_role |
|---|---|---|---|---|---|
| `admin_submit_eod` | `27e88465eeb798aa751e485d9416fc2c` | true | `{search_path=public}` | `{postgres=X/postgres,authenticated=X/postgres}` | f / t / f |
| `eod_write_submission` | `610bd4b0fca6aeeb9181fbf9bc8190aa` | false | `{search_path=public}` | `{postgres=X/postgres}` | f / f / f |
| `staff_submit_eod` | `1e86fe304c78a7971850bbe9b92388a6` | true | `{search_path=public}` | `{postgres=X/postgres,authenticated=X/postgres}` (unchanged) | f / t / f |
| `report_last_order_context` (body not re-created) | `14089d52ea76975751871cbb57a852b1` | false | `{search_path=public}` | unchanged | f / t / t |

- Unique index: `CREATE UNIQUE INDEX eod_entries_submission_item_uidx ON public.eod_entries USING btree (submission_id, item_id)`.
- `eod_entries` table comment md5 `c0efbcbd6cc284b81ff23cbe82f190ab`, the same as local.
- Row counts after: 3,470 entries and 229 submissions, unchanged. Still 0 DELETE or ALL policies.

No live write probe was run on prod. Function fidelity rests on the md5 match with the local functions that passed pgTAP (`admin_submit_eod.test.sql` 101/101) and the security re-check.

## 4. Remaining (§14 steps 4-5)

- Push, then confirm `test.yml` and `db-migrations-applied.yml` green on `main`, and check `e2e.yml`. Until the push, `db-migrations-applied` only warns, because prod now has a version the repo's `main` doesn't.
- The owner does one EDIT on prod through the UI and re-runs the duplicate query.
- The web client (Vercel) still runs the old `submitEODCount` until the push deploys. In that window an admin re-submit of an existing pair gets the error toast (23505) instead of stacking. The admin path had 0 uses on prod in the last 89 days.
