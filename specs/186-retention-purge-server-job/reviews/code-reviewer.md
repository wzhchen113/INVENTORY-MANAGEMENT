## Code review for spec 186

Scope: the migration, `retention_prune_job.test.sql`, the `cleanupOldRecords` removal in `db.ts` and `useStore.ts`, and the mock removals. I did not review the spec 187 hunk near `db.ts:2702`, `placeholderEmail*`, `delete-user`, the `20261108130000_*` migration, or other tests changed for specs 187-189. Architecture and security are deferred to the other reviewers, including whether the `stores_clear_waste_log_before_delete` trigger should stay.

I read the files and ran nothing. I did not re-run pgTAP or jest, so the spec's pass counts are taken from its implementation notes.

### Critical
None.

- No direct Supabase calls were added outside `db.ts`.
- No legacy files were touched.
- `app.json` was not touched.
- `cleanupOldRecords` no longer appears under `src/`. The only remaining mentions are in migration comments and in the P-7 arm, which asserts the name is absent.
- `db.ts:185-193` (`deleteStore`) has the new L188 comment and nothing else changed.

### Should-fix
None.

### Nits
- `supabase/migrations/20261108120000_retention_prune_job.sql:41-148` — the section markers run (1), (3), (2), (4). The header numbering matches the spec, but the file body does not follow it. Renumber the body markers in file order, or move the stale-client policies ahead of the trigger. This is comment-only and does not affect behaviour.
- `supabase/migrations/20261108120000_retention_prune_job.sql:151` — the `admin_delete_audit_log` comment ends "Client/server clock skew at the boundary is harmless (N3)." That is true for audit rows. The same migration's policy comments say skew is not harmless for the kept tables. Add "for audit_log" so a later reader does not generalise it.
- `supabase/migrations/20261108120000_retention_prune_job.sql:124,135,146` — the three policy comments repeat about 80% of the same text. This is fine for `\d+` readability. If another table is added, consider a shorter shared sentence.
- `supabase/tests/retention_prune_job.test.sql:87-95` — `pg_temp.jwt` ends with a bare `select;` after the `set_config` call. It only keeps the `void` return legal, and it reads like a typo. Either add a one-line comment or make the body a single `perform`-style statement.
- `supabase/tests/retention_prune_job.test.sql:7-26` — the arm map lists most arm families but omits F-1, A18/A21 are lumped in as one line, and A19-0 is only mentioned lower down. Add F-1 and A19-0 so the map matches the 72 arms.
- `supabase/tests/retention_prune_job.test.sql:655-661` and `:723-738` — the A17-8 and A17-9 arms depend on the future-cutoff delete being the last attempt in the file. The comment says so, but nothing enforces it. If someone adds an arm after line 661 that reads the admin's fresh rows, it will silently see them deleted. A `-- keep last` marker at the statement would make this harder to break.
- `src/lib/db.ts:183` — the `deleteStore` header comment says "except audit_log". After this spec waste_log is also partly left to the stores trigger, and L188 now explains that. Optional: widen the L183 comment so the two comments agree.
