## Code review for spec 194

Scope: the migration, the pgTAP file, the `deletePoItem` and `upsertVendorDraftOrder` hunks in `src/lib/db.ts` (other sessions' hunks ignored), and the three jest files. Checked against the spec's backend design (D-1 to D-9). I did not run anything. The implementation notes report full jest, `typecheck:test` and 100/100 pgTAP files green.

### Critical
None.

- No `supabase.from` calls added outside `db.ts`. Both client changes sit inside `db.ts` and use `useInflight.track`.
- No legacy files touched, no `app.json` change, no custom `current_setting('jwt...')` for role checks. The date guard reads the claims role GUC only to detect a server context. It then defers to `auth_is_privileged()`, as the spec requires.
- No new PERMISSIVE policies and no new realtime channels. The new test file sits in the pgTAP track.

### Should-fix
- `supabase/tests/kept_records_delete_hardening.test.sql:340-346` (arm C-3). The arm claims to pin the firing order of `po_items_check_store_trg` and `po_items_lock_po_id_trg`. It only checks that both triggers exist, and that two string literals compare in the right order under `collate "C"`. The comparison is a constant, so it can never fail. The order is genuinely pinned only by `cross_store_item_rejection` T09 (the cross-store message). Compare the actual trigger names read from `pg_trigger`, for example `select min(tgname collate "C")` over the two rows equals `po_items_check_store_trg`. Otherwise reword the arm and header to say "both triggers exist", and point at T09 for the order.
- `src/lib/db.ts:1898-1908` (`upsertVendorDraftOrder`). `delCount < oldIds.length` treats "fewer rows than captured" as "refused or raced" and returns `null`. The same condition holds when another tab or session already deleted some old lines (a legitimate no-op on those rows). The caller then toasts "Draft not created" although the new lines were inserted and the PO is fine. The spec accepts this (D-5), so it is not a bug. The warning text and the comment name only the "turned sent" cause, which will mislead someone debugging the other case. Either mention "or lines already removed" in the warn string, or leave it and note the ambiguity in the comment.

### Nits
- `supabase/tests/kept_records_delete_hardening.test.sql:25-29` and `:24`. The header maps `AC25-*` to "the delete rules do not bind postgres". It also says AC-25 (refusal shape) is covered by the `throws_ok` arms. The two statements use the same label for different things. Rename the postgres arms (for example `PGBYPASS-*`) so the arm map matches the spec's AC numbers.
- `supabase/migrations/20261109170000_kept_records_delete_hardening.sql:246`, `:257`. The two new policy comments, and spec 186's three rewrites at `:262-268`, are single very long string literals. The function comments in the same file are split across concatenated lines. Matching that style would make the diff readable. Pure preference.
- `supabase/migrations/20261109170000_kept_records_delete_hardening.sql:68`. The `bad trigger argument` branch uses `P0001`, while every other refusal in this file is `42501`. The reason (misconfiguration, not a caller refusal) is sound but is not stated where the code is. A one-line "why" next to `errcode` would help the next reader. The comment above it says "fail closed" only.
- `src/lib/db.ts:2012`. The thrown message is a hardcoded English string. It matches the existing `notifyBackendError` usage, which also passes raw English strings, so I am not flagging it as a convention break. If the admin UI is localised later, this is one more string to move.
- `src/lib/db.deletePoItem.test.ts:17`. `terminal` is a module-level `let` reassigned by every test, with no reset beyond the `beforeEach` assignment. It works, and it mirrors the sibling upsert test. A queue as in `db.upsertVendorDraftOrder.test.ts` would be more consistent. Preference only.
- `src/store/useStore.removePoLine.test.ts:91`. The test asserts the exact `console.warn` call as a proxy for `notifyBackendError`, because the function is module-local. That couples the test to the log prefix. The toast assertion already covers the behaviour. Consider dropping the `warnSpy` assertion, or keep it as is.
- (out-of-scope) `src/lib/db.ts` ~1948. The orphan-header cleanup `delete().eq('id', poId)` on the INSERT path ignores its result. With spec 186's 1-day policy this still works, because the row is seconds old. Mentioned only because it is the one other delete in the function.

Everything else reads cleanly. The migration matches the design object for object. The refusal strings are identical across the migration, tests and design. The exemption rule is explained in the function comment. The jest files follow the existing mocking patterns, and the new `count: 0` arm in `db.upsertVendorDraftOrder.test.ts` asserts both the `null` return and that `update` is not called.
