## Code review for spec 193

Scope: spec 193's own changes only. Read: the migration, the new pgTAP suite, the date-only moves in the 8 reworked suites (grepped the touched call sites and anchors; did not re-read each suite in full), the jest `describe` block, and `scripts/smoke-staff-eod.sh`.

Limitation: this reviewer had no shell, so `git show HEAD:...` / `git diff` could not be run. The migration was compared by eye, line by line, against the working-tree `20261109120000_admin_eod_replace.sql`. The spec states the working tree equals HEAD (commit 97f0f17), and 189 is a committed migration. If you want certainty, re-run `diff <(git show HEAD:supabase/migrations/20261109120000_admin_eod_replace.sql | sed -n '126,289p') <(sed -n '108,301p' supabase/migrations/20261109190000_staff_eod_date_bound.sql)` and the wrapper equivalent (189 L303-394 vs 193 L314-424).

### Body-equality verification (the explicit ask)

- `eod_write_submission` (193 L108-301 vs 189 L126-289): signature, `security invoker`, `set search_path = public`, declare block, parent upsert, the targeted (admin) branch, the entry loop, on-hand predicate, per-entry staff audit and the return envelope are identical. The single difference is the NULL-arm hunk (193 L153-183, replacing 189 L171's bare delete). The new CTE's `returning` list, six audit values, `case` for `value`, and both left joins match the admin CTE (189 L177-195) token for token. The only deltas are the dropped `and e.item_id = any (...)` line and the added `where not exists (...)`. Comment: spec 193 sentence plus the 189 text verbatim. Revoke: verbatim from 189 L296-297.
- `staff_submit_eod` (193 L314-424 vs 189 L303-394): identical apart from the one inserted block (193 L390-407). The header clauses (`security definer`, `set search_path = public`) are restated. Comment: spec 193 sentence plus the 189 text verbatim.
- `admin_submit_eod` is untouched.

Result: confirmed, one hunk each.

### Critical
None.

### Should-fix

- `scripts/smoke-staff-eod.sh:109-122, 518` — `cleanup` only deletes rows for `CLIENT_UUID` and `PRIME_UUID`. Step 8c's `OOW_UUID` is not tracked. Step 8c exists to catch a regression where the A - 36 call stops being refused, and in exactly that case it writes a real submission at A - 36 that is never cleaned up. Because the script's whole design depends on leaving no rows behind, track it. For example, assign `OOW_UUID` to a third cleanup variable before the call, and add it to the `for u in ...` list.
- `scripts/smoke-staff-eod.sh:429-432` — when `pick_free_date` finds no free date for the NN pair, the script records `fail` but carries on. It then POSTs `"p_date": ""` for the prime and NO NEED calls, which produces confusing secondary failures. Step 4 (L232-236) already bails out cleanly in the same situation. Mirror that: skip the prime and NO NEED calls when `NN_DATE` is empty.

### Nits

- `src/screens/staff/hooks/useEodSubmit.test.ts:1-5` — the file header ("Tests all 4 outcomes ... spec 062") was not touched and now undersells the file. It is fine to leave; the new `describe` carries its own explanatory comment (L419-426).
- `src/screens/staff/hooks/useEodSubmit.test.ts:428-429` — `MSG` is the fourth copy of the refusal string (migration, pgTAP `test.msg`, smoke `OOW_MSG`, jest). The comment at L425-426 is honest that nothing ties them together. Acceptable for a constant the spec fixes. If it ever changes, grep for `outside the staff window`.
- `src/screens/staff/hooks/useEodSubmit.test.ts:446-449` — the queued item's `date: '2026-01-01'` is not the date the production drain would carry for an out-of-window item. Neither the hook nor the mock reads it, so it is harmless. A comment or an obviously stale date would make the intent clearer.
- `supabase/tests/staff_submit_eod_date_bound.test.sql:592, 637, 671, 695, 717, 833` — the R9 calls are bare `select public.staff_submit_eod(...)`. If one regresses, the whole file aborts with a raw error and every later arm vanishes. `lives_ok` (as arms 17-22 do) would keep the plan intact and name the failing call. Optional.
- `supabase/tests/staff_submit_eod_date_bound.test.sql:579-582` — arm (36) asserts `prosrc not like '%current_date%'`. A future explanatory comment in the function that mentions `current_date` would trip it. Low risk, but it is a source-text pin, same class as arms (35), (68) and (69).
- `supabase/tests/staff_submit_eod_date_bound.test.sql:371` — the lint regex also rejects the bare word `network`, which is stricter than AC-4's four substrings. That is harmless and arguably better, but note it differs from the spec text.
- `supabase/migrations/20261109190000_staff_eod_date_bound.sql:161-183` — the NULL-arm CTE copy-pastes the admin CTE's select list. That is deliberate (keeps the diff to one hunk and the admin branch untouched), and arm (68) pins only the literal's occurrence count, not shape equality. Any future shape change to the audit row has to be made twice. The migration comment at L153-160 says "same shape as the targeted branch", so the duplication is at least flagged.
- `scripts/smoke-staff-eod.sh:75` — the host-guard `sed` rejects `[::1]` and uppercase `LOCALHOST`. That fails safe (exit 2), so no change is needed. Mentioning "IPv4 loopback or lowercase localhost" in the usage text would save a future confusion.

### Checked and fine
- Pre-flight `do` block (55000), restated `security` / `search_path` clauses, no grant/revoke for the wrapper (same signature, ACL carries over), writer revoke re-issued as a documented no-op.
- Anchor is `now() at time zone 'America/New_York'`, not `current_date`. Arms (15)-(22) prove the session TimeZone cannot move it. Each test computes `A` once from `now()`, which is the transaction start, so there is no midnight flake. The smoke script uses k in [3, 33] plus A - 36 for the same reason.
- Check order (store gate, then idempotency, then O-1, then date, then writer) is correct. AC-6, AC-7 and AC-26 arms pin it.
- Fixture rework: dates A - 10 to A - 19 are distinct per suite, pre-deletes run only where seed vendors are reused, and the other suites create in-transaction vendors. All the remaining `staff_submit_eod` call sites in `supabase/tests/` were grepped; the out-of-membership arms intentionally keep fixed old dates because 42501 fires first. `admin_submit_eod.test.sql` O-1 arms (77)-(81) all use `test.d3`.
- No client, `db.ts`, store, realtime or edge-function change; no `app.json`, legacy-file, color, confirm or web-API concerns apply. Test files follow the three established tracks.
