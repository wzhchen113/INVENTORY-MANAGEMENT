## Security audit for spec 199

Scope read: `specs/199-staff-eod-skip-unknown-items.md` (incl. Backend design + Files changed), `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql` (full), the spec 193 base body in `supabase/migrations/20261109190000_staff_eod_date_bound.sql`, `supabase/tests/staff_submit_eod_skip_unknown.test.sql` (fixtures, SK6, SK9/R13 pin, SK13), and the client diffs in `src/screens/staff/hooks/useEodSubmit.ts`, `src/screens/staff/lib/types.ts`, `src/screens/staff/screens/EODCount.tsx`, `src/screens/staff/i18n/{en,es,zh-CN}.json`.

Local probes (local stack, migration `20261110130000` applied, every write probe inside `begin … rollback`; no prod access):

| # | Probe | Result |
|---|---|---|
| C1 | Catalog posture | `staff_submit_eod`: `prosecdef=t`, `proconfig={search_path=public}`, `proacl={postgres=X/postgres,authenticated=X/postgres}`, owner `postgres`. Writer: `prosecdef=f`, `{search_path=public}`, ACL owner-only. Normalized md5 `dce41928eeea865f5c10ea34297a9b68`, which matches the developer's recorded value. `authenticated`/`anon` have no CREATE on `public`. `eod_entries_check_store_trg` is present and enabled (`O`). |
| P1 | Oracle, partial skip: member 2222 at Frederick sends `[I1, X]` (X is a real Charles item, cross-brand) vs `[I1, D]` (random uuid) | The envelopes are the same shape. `stock_updates` names only I1, and `skipped_item_ids` echoes exactly the sent id (canonicalized to lowercase; an upper-cased X comes back lowercased, as D would). Before the call, `select … from inventory_items where id = X` under RLS returns 0, so the caller can't see X directly either. |
| P2 | Oracle, all-skipped: `[X]` vs `[D]` | Identical: 22023 `no p_entries element names an item of this store`. |
| P3 | Oracle via skipped-element evaluation: X with `no_need:true` + a quantity | Skipped silently, with no 23514. A real cross-store item behaves like a missing one. |
| P4/P5 | Gate order: outsider targets Charles with `[X]`, Charles with `[D]`, and a random store id | All three get 42501 `caller cannot see store …` from line 30 of the body, before replay, O-1, the date window and the new lookup. |
| P6 | Malformed elements | `[1]` → R3 22023. Object-valued `ingredient_id` → 22P02. Both behave as designed. |
| L1 | Lock timing side-channel: session A holds `FOR UPDATE` on Charles item X, then member 2222 submits `[I1, X]` to Frederick | Returned in **9 ms** with X skipped. The `store_id = p_store_id` qual filters X below the LockRows node, so a foreign row is never locked or waited on, and there is no timing oracle. |
| L2 | Control: session A holds `FOR UPDATE` on own-store I1 | The submit waits and hits `lock_timeout` (55P03) as expected. Only rows the caller already legitimately writes are lockable. |
| A1 | Amplification: 1 valid id + 100,000 random uuids (3.8 MB body) | Succeeded in 154 ms and returned 100,000 skipped ids. Bounded by `authenticated` `statement_timeout=8s`. |
| D1 | Legacy cross-store `eod_entries` rows (item store ≠ submission store) | 0 locally. |

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql:284-301` (with the writer's spec 193 `Count cleared` branch): if a **legacy** pre-2026-05-14 `eod_entries` row exists whose item belongs to another store, its item is now skipped and the full replace deletes the row. The writer then writes a `Count cleared` audit row whose `item_ref` is that foreign item's catalog name, under the calling store. Store members can read their own store's `audit_log`, so a foreign (possibly cross-brand) item name would land in their audit feed. The spec says this is truthful (R9), but it is also a one-off name disclosure. It's theoretical: 0 such rows locally (probe D1), and the trigger has refused them since 2026-05-14. **Fix (no code change):** add a read-only count to the §7 prod pre-check (`select count(*) from eod_entries e join eod_submissions s on s.id = e.submission_id left join inventory_items i on i.id = e.item_id where i.store_id is distinct from s.store_id`). If it is non-zero, decide before apply whether those rows should be cleaned up as `postgres` first.
- `supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql:241-304`: there is no upper bound on `jsonb_array_length(p_entries)`, and the response reflects every distinct skipped id. Before this change, a stale or hostile id at position 1 aborted the writer early. Now a store member can make the wrapper classify and echo an arbitrarily large list (probe A1: 100k ids in 154 ms). The `x <> all(v_valid_ids)` and `= any(v_valid_ids)` passes are O(N × valid), and valid is capped at the store's item count. The cost is bounded by the 8 s `statement_timeout`, the caller must already pass the store gate, and the echo only reflects the caller's own input. So this is resource use, not data exposure. **Optional fix:** refuse `jsonb_array_length(p_entries) > 2000` (or similar) with a constant 22023 message that follows the R5 rules, placed after O-1. Not required for ship.

### Answers to the dispatch questions

1. **Can the skip path or the returned ids leak cross-store or cross-brand existence?** No. A missing id (D) and a foreign-store id (X) can't be told apart by anything I tried:
   - envelope and skip list (P1);
   - refusal code and message (P2);
   - side-effect evaluation (P3);
   - lock wait / timing (L1).

   The only bit the caller learns is "this id is or isn't an item of the store I'm a member of", which they can already read through RLS on `inventory_items`. Pre-199 parity holds: the trigger raised the same 42501 for both cases. `skipped_item_ids` is computed from `v_ids`, the caller's own payload, never from a table read, so it can't contain an id the caller didn't send.
2. **Does gate order still refuse outsiders with 42501 before any lookup?** Yes. The store gate (`:178-181`) precedes the replay lookup (`:195-206`), O-1, the date window and the new R3/R2/R4 block (`:238-278`). P4/P5 confirm it, including for a random store id. SK9 pins the code and the prefix. The gate message has been byte-stable in every version since `20260525000000`, so `STORE_GATE_TEXT` matches all live server versions.
3. **Are ACL, prosecdef and search_path unchanged?** Yes (C1). The signature is the same, so the ACL carries over. `security definer` and `set search_path = public` are restated (`:148-149`). The writer and `admin_submit_eod` aren't in the file. The `FOR KEY SHARE` clause needs UPDATE on `inventory_items`, which comes from the owner (`postgres`), not the caller. The definer-context read bypasses RLS on purpose. That is safe because the result only reduces to a membership test against `p_store_id`, which is already gated.
4. **Does the lock open a DoS or deadlock lever?**
   - **Scope:** the lock can only touch rows with `store_id = p_store_id`, a store the caller passed the gate for (L1/L2), so there is no lever on a foreign store's rows.
   - **What it blocks:** `FOR KEY SHARE` blocks only DELETE and key-column UPDATEs. On `inventory_items` the keys are the `id` PK and the `(store_id, catalog_id)` unique index; spec 179 makes `id` and `store_id` immutable. Ordinary edits (NO KEY UPDATE) aren't blocked. It is held for one statement-bounded RPC (8 s max).
   - **Holding it without writing:** a hostile member can hold it on their own items without writing anything. For example, send all valid items plus a duplicate so the writer raises 23505 after the lock. But the pre-199 writer's `current_stock` UPDATE (NO KEY UPDATE) already conflicted with DELETE in the same way. And any successful submit creates FK history that blocks the delete permanently. So there's no new capability.
   - **Deadlock:** lock order is deterministic (`order by id`). The 40P01 residual against a multi-row key-changing transaction is documented in the header (`:51-54`). It surfaces as neither forbidden nor network, so the item is kept.
   - **No locks on refusal:** R3/R4 refusals take no locks, since an empty valid set locks nothing.
5. **Does narrowing `isForbidden` make any real revocation retry forever in a harmful way?** No.
   - **Revocations still dequeue:** every real access revocation reaches the store gate, so its message matches `STORE_GATE_TEXT` and the item is still dequeued. That covers membership removal, profile delete with a live JWT, a brand move, and a role drop to no stores (`useEodSubmit.ts:69-82`).
   - **What now retries:** two kinds of 42501.
     - The trigger 42501. It is near-unreachable on a 199 server, given the lock.
     - The spec 152 anon-session `permission denied for function`.
   - **Why the retry is harmless:**
     - The retry is event-driven (mount and connectivity flips), not a loop.
     - The queue is scoped by `intent_user_id` (`:175`), so the item is only ever sent under the same user's JWT.
     - A late replay is still bounded by spec 193's 35-day window and the 30-day queue GC.
     - Server-side authorization is unchanged, so retrying can't write anything the caller isn't entitled to.
   - **What remains is UX:**
     - The online anon-session case now shows the generic "failed" toast instead of the "sign out and back in" prompt.
     - A new client meeting a pre-199 server would keep the trigger's 42501 forever. The §7 order (server apply before push) prevents that.

### Informational (pre-existing, not introduced by this spec)

- Replay step (4) (`:195-206`) looks up `p_client_uuid` with no store filter, so a member who knows another store's `client_uuid` would get that submission's id back. `client_uuid` values are random v4 values that only the submitting device holds, so this isn't practically exploitable. It's noted for a future hardening pass, not a finding here.
- 22P02 on a non-uuid `ingredient_id` echoes the caller's own input in the message. This was already the case in the writer's `jsonb_to_recordset`.
- Client: the skipped notice renders only a numeric count through `t()` (`EODCount.tsx` online path, `useEodSubmit.ts` drain path). No server-supplied id is rendered, so there is no injection surface. No new `console.*`, token or PII logging was added.

### Dependencies

No dependency change in spec 199. `package.json` shows as modified in the working tree, but the diff only touches the `test:smoke` script (another session's work, not in this spec's Files changed) and changes no dependencies, so I skipped `npm audit`.
