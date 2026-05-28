# Security audit for spec 068

Scope: cross-brand `user_stores` isolation. The bug fixed here had a real,
reachable (though never-exploited — prod has ZERO bad rows per §0) DB-layer
write hole: `public.user_stores_brand_match()` SKIPPED its cross-brand check
for NULL-brand users, which is exactly the state the staff (`role='user'`)
invite→register path produces. This audit verifies the DB-layer fix actually
closes the hole, that the UI fix is correctly treated as defense-in-depth and
not the boundary, and that the RLS + trigger pair together enforce
"an admin may only assign stores within their own brand."

Files reviewed:
- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql` (the fix)
- `supabase/tests/user_stores_brand_match_null_brand.test.sql` (pgTAP)
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:357-387` (original trigger) + helpers `:187-243`
- `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql` (the `user_stores` RLS policy stack, spec 051)
- `supabase/migrations/20260504073942_brand_catalog_p5_rls.sql:23-27` (`auth_is_admin()`)
- `src/components/cmd/InviteUserDrawer.tsx` (the UI that assembles `store_ids`)
- `src/lib/auth.ts:268-400` (`inviteUser` / `registerInvitedUser` — the write path)
- `src/screens/cmd/sections/UsersSection.tsx` + `src/utils/userPermissions.ts` (the chip display fix)
- `src/components/cmd/InviteAdminDrawer.tsx:49` (confirmed already brand-scoped, untouched)

Verdict: **no Critical, no High.** The DB-layer hole is genuinely closed and
the layered model (UI filter → table trigger → RLS) is sound. Findings below
are Medium/Low/informational. The spec may advance.

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

None.

---

### Medium

- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql:94-101`
  — **the NULL-brand branch defines "the brand" by the set of rows that
  already exist, which makes correctness order-dependent in a way that is
  benign here but worth a one-line acknowledgement.** The new rule is "reject
  a row if the NULL-brand user ALREADY holds a grant whose store brand differs
  from this row's." Because the FIRST grant always passes (nothing to conflict
  with), the *invariant the trigger enforces* is "no NULL-brand user holds
  grants spanning >1 brand" — which holds row-by-row regardless of insert
  order: whichever row would be the second-brand one is the one rejected. I
  walked the multi-row and single-row-UPDATE-flip cases and confirmed there is
  no ordering by which two cross-brand rows both land:
  - First brand-A row → passes (empty conflict set).
  - Second brand-B row → conflict lookup finds the brand-A row (A ≠ B) → RAISE.
  - Single-row UPDATE that flips store X (brand A) → store Y (brand B): the
    conflict lookup's `us.store_id is distinct from new.store_id` excludes the
    *target* store_id (Y), so it still sees the pre-image row (X, brand A),
    A ≠ B → RAISE. A lone brand-flip is correctly rejected.
  The invariant is sound; this is not a bypass. Flagging only because the
  predicate is "consistency among siblings" rather than "match a declared
  brand," so a future reader must not assume a NULL-brand user has a single
  canonical brand column — they don't; the constraint is purely relational.
  No code change required; the migration's own comment block (`:84-93`)
  already explains the intent. **Medium, informational-leaning — no fix
  needed, surfaced so it isn't mistaken for a stronger guarantee than it is.**

- `supabase/migrations/20260528010000_…:104-106` — **the raise message
  interpolates `v_conflict_brand` and `v_store_brand` (brand UUIDs) into the
  exception text, which surfaces to the client via PostgREST.** These are
  brand-id UUIDs, not PII and not secrets, and the message is only reachable by
  a privileged caller who already passed the `user_stores` admin RLS policy
  (i.e. already can see at least one of the brands) or by the service role.
  The existing non-NULL arm (`:114-115`) already interpolates the same class of
  value and shipped in 012a, so this is consistent with precedent, not a new
  leak. **Not a finding to fix** — recorded for completeness because the audit
  brief asks about data in error messages. A brand UUID is not cross-tenant
  row data; no stack traces or SQL fragments are exposed.

---

### Low

- `src/lib/auth.ts:381-384` — **partial-insert-then-block on the multi-row
  register loop (the BE-dev's flag #1).** The loop is a plain `for (const
  storeId of storeIds) { await supabase.from('user_stores').insert(...) }` with
  NO surrounding transaction (confirmed — there is no `rpc`-wrapped txn, no
  `begin`/`commit`; each insert auto-commits). With the tightened trigger, a
  payload whose `store_ids` span two brands inserts the first-brand rows, then
  RAISES on the first second-brand row; the already-committed first-brand rows
  persist and the `catch` at `auth.ts:397` returns `{ error }`. My assessment,
  matching the architect's §4 / §11:
  - **Not a security problem.** The first N−1 rows are all in ONE brand — the
    brand the row's store actually belongs to — and the rejected row is the
    cross-brand one. The invariant "no user holds cross-brand `user_stores`
    rows" is preserved by construction: the conflicting row is exactly the one
    the trigger blocks. There is no foothold-in-brand-A-before-brand-B-rejected
    escalation, because a NULL-brand staff user holding brand-A grants is a
    legitimate, intended state (a single-brand staff assignment).
  - **It is a UX wart, not a vuln.** A half-applied invite leaves the staff
    user with partial (single-brand) store access plus an error toast. The
    operator re-issues or edits. Recoverable, no privileged state, no
    recover-by-psql-only condition.
  - **It is also largely unreachable from the product.** The UI fix
    (`InviteUserDrawer` brand filter + stale-selection prune, `:84-108`)
    prevents `store_ids` from ever spanning two brands in the first place, so
    the trigger only fires for a direct-API/psql writer — for whom
    partial-insert + 400 is the correct outcome.
  Agreeing with the architect: **do NOT wrap the loop in a transaction in this
  spec.** That is a behavior change to the registration path outside this bug's
  blast radius. Recording as Low so the follow-up is on the record: a future
  hardening spec could move the `user_stores` fan-out into a single
  SECURITY DEFINER RPC for all-or-nothing semantics, which would also let the
  trigger evaluate the full intended set atomically. Not required to ship 068.

- `supabase/migrations/20260528010000_…:83-110` + `profiles_role_brand_consistent`
  (`20260509000000_…:341-348`) — **super_admin NULL-brand residual (the BE-dev's
  flag #2 / §11).** Confirmed the reasoning holds and there is NO functional
  regression for super_admins:
  - super_admins **do not use `user_stores`**. Their store visibility comes
    from `auth_can_see_store()` (`20260509000000_…:216-227`), which
    short-circuits on `auth_is_super_admin()` and returns true for every store
    regardless of `user_stores` membership. So a super_admin sees all stores in
    all brands without any grant rows. The "they see everything via RLS" branch
    of the question is the operative one → **the new rule is fine; no
    super_admin flow hits it in normal operation.**
  - IF a super_admin row is ever inserted into `user_stores` (the original
    trigger comment and the architect both note this is a testing-only edge),
    the super_admin's `profiles.brand_id` is NULL (forced by
    `profiles_role_brand_consistent`), so they take the NULL branch. The new
    rule would then permit their FIRST grant and block a SECOND cross-brand
    grant. That is a *tightening* of the previous "unconditional pass," so a
    super_admin can no longer be given cross-brand `user_stores` rows. This is
    a theoretical functional narrowing, NOT a security regression (it removes
    access, never grants it), and it does not affect real super_admin behavior
    because they never needed those rows. **§11's tolerance claim is accurate
    enough: the practical effect on super_admins is nil.** No change needed.
    Recorded only because the brief asked to confirm the §11 reasoning — it
    holds.

- `src/lib/auth.ts:382-383` — the `user_stores` insert passes only
  `{ user_id, store_id }` and does not pre-check the store's brand against the
  invitation's `brand_id`. This is **correct and intended** per the design (§7:
  "do not add a brand pre-check in `inviteUser` — the trigger is
  authoritative"). A client-side guard would be bypassable and is the wrong
  layer. Noting it so it is not mistaken for a gap: the absence of a client
  brand-check is by design; the trigger is the single source of truth. No
  action.

---

### Cross-brand sweep — explicit confirmations (the brief's items 3, 4, 5)

**Item 3 — does the trigger fully close the hole? YES.**
- The trigger binding is `before insert or update on public.user_stores`
  (`20260528010000_…:127`) — it fires on BOTH INSERT and UPDATE, not INSERT
  only. An attacker cannot insert a clean single-brand grant then UPDATE its
  `store_id` to a foreign brand: the UPDATE re-fires the trigger and the
  conflict lookup (which excludes the target store_id, so it still sees the
  pre-image) rejects the flip. pgTAP arm (6) covers the no-op-UPDATE
  non-regression; the flip-rejection is covered transitively by the same
  conflict logic.
- The function is `security definer` and a table-level row trigger, so it fires
  for EVERY writer — `authenticated` via PostgREST, the `service_role`
  (sibling apps / edge functions), and direct `psql`/superuser. There is no
  role that bypasses it. (SECURITY DEFINER changes the function's execution
  identity, not whether the trigger fires.)
- Every write path into `user_stores` was walked:
  - **invite→register** (`auth.ts:382-383`) — fires the trigger per row. ✓
  - **direct PostgREST** by an admin — gated by RLS (item 5) AND the trigger. ✓
  - **RPCs** — grep shows no SECURITY DEFINER RPC inserts/updates
    `user_stores` outside this path; `fetchProfile`/`fetchAllUsers` only SELECT
    it. No RPC bypass surface. ✓
  - **service role** (sibling staff/PWA apps) — RLS is bypassed for
    service-role, but the trigger still fires, so even a sibling app cannot
    write a cross-brand row. ✓

**Item 4 — UI fix is defense-in-depth, not the boundary. CONFIRMED.**
The `InviteUserDrawer` brand filter (`:84-87`), stale-selection prune
(`:96-108`), and `handleSave` name-join over `brandStores` (`:133-136`) all
prevent a cross-brand `store_ids` array from being assembled in the product.
But a crafted direct API call carrying a foreign `store_id` is still stopped
at the DB by the trigger (NULL-brand users) and by RLS (non-NULL admins). The
DB is the real guard; the UI is UX. Correct architecture.

**Item 5 — RLS + trigger together enforce "admin assigns only within own
brand." CONFIRMED, and the two layers are complementary (both needed).**
The `user_stores` policy stack after spec 051
(`20260520010000_…:101-140`) is:
- own-row ALL: `using/with check (user_id = auth.uid())` — a caller managing
  their OWN grant rows.
- admin ALL: `using/with check (auth_is_privileged() AND exists(stores s where
  s.id = user_stores.store_id and auth_can_see_brand(s.brand_id)))`.

Tracing a **brand-A admin trying to assign a brand-B store to a brand-B user**
via direct PostgREST:
- `auth_is_privileged()` → TRUE (JWT `app_metadata.role='admin'`,
  `auth_is_admin()` true). 
- `auth_can_see_brand(B)` = `auth_is_super_admin() OR exists(profiles where
  id=auth.uid() and brand_id=B)`. The brand-A admin is not super_admin and
  their `profiles.brand_id` is A, not B → FALSE.
- WITH CHECK fails → **RLS rejects the insert.** The brand-A admin cannot write
  ANY brand-B `user_stores` row, regardless of the target user's brand. This is
  the cross-ADMIN-AUTHORITY guarantee, and **RLS is what enforces it** (the
  trigger would NOT catch a brand-B admin assigning a brand-B store to a
  brand-B user — that is not a cross-brand SPAN — so RLS is load-bearing here,
  not redundant).
- The trigger enforces the orthogonal cross-brand-SPAN invariant (no single
  user holds rows across >1 brand), including the NULL-brand staff case that
  RLS's brand-scoped admin arm does not by itself prevent (a privileged caller
  who CAN see both brands — i.e. a super_admin — would pass the RLS arm for
  either store; the trigger is what stops them from spanning brands on one
  user). The two layers are genuinely complementary; neither is dead weight.

So: a brand-A admin is confined to brand-A stores by RLS; cross-brand spanning
for any user (incl. the NULL-brand staff invite that motivated this spec) is
confined by the trigger. Together they satisfy the AC.

**Item 6 — no secret/PII exposure. CONFIRMED.**
- No secrets in the migration, test, or touched TS. No `Deno.env`,
  `service_role`, tokens, or keys involved (no edge function touched — §8).
- The trigger raise interpolates brand UUIDs only (Medium note above) — not
  PII, not other-store row data.
- `deriveAccessibleStores` (`userPermissions.ts:94-112`) and the `UserRow`
  chip render (`UsersSection.tsx:302`) operate purely over the already-loaded
  `stores` array and the row's own `role`/`brandId`/`stores`. The fix
  REDUCES exposure: it stops `UserRow` from rendering the entire global
  `stores` array (cross-brand store names) for admin-tier rows — the Bobby
  display artifact. No new data leaves the client; no `console.log` of user
  data added.
- `fetchAllUsers` (`auth.ts:426-501`) already brand-clips `user.stores` server
  side (`:450-452, 480`); the chip fix consumes that without a new fetch. No
  N+1, no broadened read.

---

### Trigger contract / pgTAP correctness notes

- The non-NULL path (`20260528010000_…:112-116`) is byte-for-byte identical to
  the original (`20260509000000_…:375-378`). Confirmed — the regression arms
  (1)/(2) in the pgTAP guard against drift on it. Good.
- `IS DISTINCT FROM` is used for both the conflict-brand comparison (`:100`)
  and the store-id exclusion (`:99`), which correctly handles NULL store
  brand_ids (a store with NULL brand would not falsely match). Stores have a
  NOT-NULL `brand_id` FK in practice, but the NULL-safe operator is the right
  defensive choice. Good.
- pgTAP `throws_ok(..., 'P0001', null, ...)` 4-arg form asserts the SQLSTATE
  without pinning exact text — correct per the brief's "assert on the raise,
  not the text" guidance, and the migration deliberately keeps the message
  stable for log-grep. The test's plan(7) arms cover: NULL-brand fixture
  sanity, non-NULL cross-brand RAISE (regression), non-NULL same-brand
  SUCCEED, NULL first-grant SUCCEED, NULL same-brand second SUCCEED, NULL
  cross-brand second RAISE (the previously-allowed-now-blocked AC arm), and
  no-op UPDATE SUCCEED. This is the right matrix; the one untested-but-benign
  case (single-row store-id flip across brands) is covered transitively by the
  same conflict logic as arm (5).

---

### Migration-safety / CI note

- The migration is `create or replace function` + idempotent
  `drop trigger if exists … ; create trigger …`. Additive, non-destructive, no
  data-cleanup (correct — prod has zero bad rows per §0). It is the latest file
  on disk (`20260528010000`), sorting after the original `20260509000000` and
  the same-day `20260528000000`. Ordering is correct.
- Per CLAUDE.md, there is **no `db-migrations-applied` CI gate.** The behavior
  here is a *tightening* (rejects what was previously allowed), so the standing
  risk is a legitimate existing row tripping the new rule on a future write.
  Prod has zero cross-brand rows (§0) and the seed's Tara Manager carries a
  non-NULL `brand_id` so she takes the unchanged non-NULL path — no existing
  data trips it. The BE-dev's verification (`db reset` + 36/36 pgTAP + 330/330
  jest, per the spec's "Verification" block) is the right manual gate in the
  absence of CI. No destructive operation to surface.

---

### Dependencies

No `package.json` changes in this spec (`git diff HEAD~3..HEAD` shows none; the
working tree touches only `.tsx`/`.ts`/`.sql`). `npm audit` skipped per process.
