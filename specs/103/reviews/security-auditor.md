# Security audit for spec 103 (per-user custom drag-to-reorder for count screens)

Reviewed: `git diff --cached` (24 files staged). Focus per dispatch — the core
security property is the US-2 privacy guarantee: a user's saved row order is
invisible to and unaffected by every other user, INCLUDING admins/super_admins.

Verdict: **the privacy guarantee holds.** The new `public.user_count_orders`
table is correctly owner-scoped with no privileged bypass, all four commands
carry the owner predicate (INSERT/UPDATE both with WITH CHECK), the
delete-then-insert client path cannot write or read another user's rows, the
spec-053 lint stays green with no allowlist edit, and the NULL-vendor
uniqueness cannot cross users. No new edge function, no new dependency, no
secrets, no PII exposure. **No Critical findings. No High findings.**

---

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Should-fix

None that fall in the security lane. (The frontend slice self-reports a
`42P10` persist-on-drop functional break in the spec body — that is a
correctness/contract issue owned by the architect + backend-developer, not a
security finding. Note: the staged `saveCountOrder` in BOTH
`src/lib/db.ts:94-128` and `src/screens/staff/lib/countOrder.ts:74-104` has
ALREADY been rewritten to the delete-then-insert path the frontend recommended,
so the staged tree does not contain the broken `.upsert({ onConflict })`. The
delete-then-insert is RLS-safe — see the verification below.)

## Nit

- `src/lib/db.ts:302`, `:321`, `:337` and `InventoryCountSection.tsx:302` etc.
  log `e?.message` from a failed count-order read/write via `console.warn`. This
  is a per-user view-pref error path; the message is a PostgREST error string,
  not a token/PII/secret, and the row payload (`item_ids` = inventory item ids
  the user already sees) is not sensitive. Below the `notifyBackendError`
  `console.warn` bar already established project-wide. No action required —
  noted only for completeness.

---

## Detailed verification (the dispatch checklist)

### 1. Owner-scoped RLS — every command has the owner predicate, no bypass

`supabase/migrations/20260630000500_user_count_orders.sql:127-148`. RLS is
enabled (`:127`) and there are exactly four permissive policies, each a single
policy per command with the owner predicate as the WHOLE clause:

- SELECT `:130-132` — `using (auth.uid() = user_id)`.
- INSERT `:135-137` — `with check (auth.uid() = user_id)`. **Has WITH CHECK** —
  a user cannot insert a row carrying someone else's `user_id`.
- UPDATE `:140-143` — `using (auth.uid() = user_id) with check (auth.uid() =
  user_id)`. **Has BOTH** USING and WITH CHECK — a user cannot move a row to
  another owner, and cannot see/target a row they don't own.
- DELETE `:146-148` — `using (auth.uid() = user_id)`.

No `auth_is_admin()`, no `auth_is_privileged()`, no `auth_can_see_store()`, no
`super_admin` special-case, no second permissive arm with `auth.uid() IS NOT
NULL` anywhere on the table. The deliberate absence of an admin bypass is the
correct design for US-2 and is asserted by the test (below). Confirmed: no
privileged read path crept in.

pgTAP proof (`supabase/tests/user_count_orders_rls.test.sql`, plan 13):
- `:122-131` (3) — user B SELECT of A's rows → **0 rows**.
- `:139-154` (4) — user B UPDATE of A's row → **0 rows affected**.
- `:156-171` (5) — user B DELETE of A's row → **0 rows affected**.
- `:173-186` (6) — user B INSERT of a row with `user_id = A` → **42501** (WITH
  CHECK denial — the cross-user write-spoof guard).
- `:200-209` (7) — **super_admin** JWT SELECT of A's rows → **0 rows** (asserts
  NO admin bypass; this is the literal US-2 privacy assertion). Confirmed the
  test impersonates `app_metadata.role = 'super_admin'` (`:195`) and still gets
  zero rows.

This directly satisfies AC-1 and the dispatch's "a non-owner gets zero rows /
42501, the design deliberately has NO super_admin bypass — confirm none crept
in." Confirmed.

### 2. spec-053 permissive-policy lint stays green (no allowlist entry needed)

`auth.uid() = user_id` references the owning column, so it is not trivially-wide
(not `auth.uid() IS NOT NULL`, not `true`, not `auth.role() = 'authenticated'`)
and has no OR-tail. The allowlist in
`supabase/tests/permissive_policy_lint.test.sql:124-127` / `:169-172` is
unchanged (still only the two `*_categories` SELECT policies) — confirmed not
staged-modified. Arm (1)/(2) scan all public.* permissive policies and these
four pass with no edit; the backend slice reports `permissive_policy_lint
4/4`. The owner predicate is the canonical shape the lint is designed to
*pass*. Confirmed green.

### 3. NULL-vendor uniqueness cannot let one user clobber another

`:84-90` — two partial unique indexes:
- `user_count_orders_vendor_uq` on `(user_id, screen, vendor_id) where vendor_id
  is not null`.
- `user_count_orders_novendor_uq` on `(user_id, screen) where vendor_id is
  null`.

`user_id` is the leading column of BOTH indexes, so the uniqueness scope is
always within a single user — a cross-user clobber is structurally impossible
regardless of the NULL-vendor handling. The "gap" the design worried about
(two NULL-vendor rows for the same `(user, screen)`) is a same-user duplicate
concern, not a cross-user one, and is closed by `..._novendor_uq`. pgTAP
`:252-263` (9) proves a second NULL-vendor upsert REPLACES (1 row), and
`:232-241` (8) / `:274-284` (10) prove independent keys coexist. The privacy
boundary does not depend on the uniqueness design at all — it is RLS — but the
uniqueness is also sound. Confirmed.

### 4. `saveCountOrder` delete-then-insert path — no attacker-controlled user_id

Both write helpers (`src/lib/db.ts:94-128`, `src/screens/staff/lib/countOrder.ts:74-104`)
do `delete … .eq('user_id', userId).eq('screen', screen)[.eq/.is vendor]` then
`insert({ user_id: userId, … })`. Security properties:

- The DELETE is RLS-gated by the DELETE policy (`using auth.uid() = user_id`) —
  even though the client also pins `.eq('user_id', userId)`, RLS independently
  guarantees it can only ever delete the caller's own rows. A forged `userId`
  would simply match 0 rows (the `.eq` filters to that id, RLS hides any row
  not owned by the caller).
- The INSERT is RLS-gated by the INSERT WITH CHECK — a forged `userId !=
  auth.uid()` is rejected with 42501 (pgTAP (6) proves this). So the client
  literally cannot persist a row under another user's id; the WITH CHECK is the
  backstop, not the `.eq`.
- `userId` provenance is session-derived everywhere it is called: admin `uid =
  currentUser?.id` (`EODCountSection.tsx:353`, `InventoryCountSection.tsx:287`);
  staff `currentStaffUserId(s.authState)` (`EODCount.tsx:261`,
  `WeeklyCount.tsx:188`). Not request-body / not URL-derived.
- The non-atomic two-statement window (delete then insert) is a same-user
  durability nuance (a torn write re-saves on the next drop), not a security
  issue — it cannot expose or corrupt another user's row because both
  statements are owner-gated.

JSONB array handling: `item_ids` is passed as a JS `string[]` of inventory item
ids (sourced from the rendered list via drag/`nudge`, not free text). PostgREST
serializes it as a parameterized JSONB value — no string interpolation, no SQL
injection surface. The CHECK `jsonb_typeof(item_ids) = 'array'` (`:64-65`)
rejects a non-array body. The ids are not secrets (the user already sees these
items). No injection or leak surface in the array handling. Confirmed.

### 5. Grants scoped sanely (matches the established per-user-private pattern)

`:107-109`:
```
grant select, insert, update, delete, references, trigger
  on public.user_count_orders to anon, authenticated;
grant all on public.user_count_orders to service_role;
```
Byte-identical to the cited spec-097-class reference
`item_vendors` (`20260630000000_item_vendors.sql:98-100`). TRUNCATE omitted for
anon/authenticated (the anti-escalation baseline); service_role keeps ALL. The
`anon` grant is harmless: RLS is ENABLED and every policy requires `auth.uid()
= user_id`, so an anon caller (null `auth.uid()`) matches 0 rows on
SELECT/DELETE and fails the INSERT/UPDATE WITH CHECK. The frontend slice
verified this empirically ("anon → `[]`"). This is the same posture as the
`flags` / `push_subscriptions` per-user-private tables (which predate the
explicit-grant migration and inherit grants), just with the spec-097 explicit
re-grant. Grants are correctly scoped. Confirmed.

### 6. No new edge function; JWT path preserved

`grep` of staged files shows zero changes under `supabase/functions/` and zero
changes to `supabase/config.toml`. The read/write path is PostgREST + RLS on a
per-user table under the authenticated JWT session (admin and staff both run a
signed-in Supabase session). The `staff-*` service-token split is not involved.
No `verify_jwt` decision required. Confirmed.

### 7. No new dependency / `npm audit`

`git diff --cached --name-only` includes neither `package.json` nor
`package-lock.json`. The frontend slice used the already-installed `@dnd-kit`
(web) + native `▲/▼` buttons — the considered
`react-native-draggable-flatlist` was NOT added. No risky dependency landed.
Per process, `npm audit` is skipped (no package.json change).

---

## Dependencies

No `package.json` / `package-lock.json` changes — `npm audit` skipped. The
implementation reuses the already-installed `@dnd-kit` (web) and hand-rolled
native move buttons; no new dependency was introduced.
