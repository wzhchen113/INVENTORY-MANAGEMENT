# Spec 090: Stop creating NULL-brand invitations for user/manager invites at the source (`inviteUser`)

Status: READY_FOR_REVIEW

## Severity / nature

Bug-class **root-cause prevention** — a deferred write-side follow-up to the
read-side fixes in specs 068/069 (staff catalog reads) and 083/084 ("(email not
loaded)" in admin Users & access). Those specs fixed SYMPTOMS downstream
(read-side relaxation + one-time `brand_id` backfills). **This spec fixes the
SOURCE** so new NULL-brand `invitations` rows stop being created for
user/manager-role invites, which is the upstream emitter both backfills had to
clean up after.

Not a P0 (the symptoms are already mitigated and the data was backfilled). This
closes the recurrence so the bug class cannot reappear on the next invite.

## Problem statement (verified against the code)

`inviteUser` (`src/lib/auth.ts:269-321`) creates the `invitations` row. The
options type comments it explicitly (`src/lib/auth.ts:258-260`):

> `brandId` is *"Required for role='admin' (CHECK enforces). Allowed null for
> role='user' (staff app users have no brand scope today)."*

Two paths inside `inviteUser`:

- **admin invites are guarded** — `if (opts.role === 'admin' && !opts.brandId)
  return { error: 'Admin invitations require a brand assignment' }`
  (`src/lib/auth.ts:275-277`). An admin invitation can never be NULL-brand.
- **user/manager invites are NOT guarded** — the INSERT writes
  `brand_id: opts.brandId` (`src/lib/auth.ts:303`) with no derivation and no
  check. The sole call site, `InviteUserDrawer`, **hard-codes**
  `brandId: values.role === 'admin' ? brandId : null`
  (`src/components/cmd/InviteUserDrawer.tsx:147`) — so for every user/manager
  invite, `opts.brandId` is deterministically `null`, and the `invitations` row
  is written with `brand_id = NULL`.

That NULL-brand `invitations` row is the SOURCE that spec 083's backfill
(`supabase/migrations/20260531010000_invitations_brand_id_backfill.sql`) and
spec 084 had to repair after the fact (the email-inference query
`fetchInvitationsForUserLookup` excluded NULL-brand invitation rows, producing
"(email not loaded)").

### What is ALREADY fixed (so this spec does NOT re-touch it)

Spec 069 already closed the *profiles* side of the SAME class at register time:
`registerInvitedUser` (`src/lib/auth.ts:379-389`) now stamps the new staff
profile's `brand_id` for `role==='user'` from `invitation.resolved_brand_id`:

```ts
brand_id: invitation.role === 'user'
  ? (invitation.resolved_brand_id ?? invitation.brand_id ?? null)
  : (invitation.brand_id ?? null),
```

and `get_pending_invitation`
(`supabase/migrations/20260528020000_staff_brand_id_backfill.sql:228-266`)
already computes that derivation **server-side** (SECURITY DEFINER, bypasses
RLS):

```sql
resolved_brand_id = COALESCE(
  invitation.brand_id,
  (SELECT s.brand_id FROM public.stores s WHERE s.id = (store_ids[1])::uuid)
)
```

**So the REGISTERED PROFILE is no longer NULL-brand** (069 owns that). What 069
did NOT close — and explicitly **rejected closing at the time** (069 §4 ruled
"derive at register time, not invite time") — is the **`invitations` row write
itself** in `inviteUser`. That residual NULL-brand invitation row is precisely
what spec 083 then had to backfill. **This spec's target is the `invitations`
row write at `inviteUser` (the write-side source), reusing the derivation logic
069 already proved out.**

### Why the "no brand scope today" assumption is OUTDATED

The comment at `src/lib/auth.ts:259-260` is stale. Specs 068/069 proved staff
users DO need their store's brand (NULL brand broke their EOD catalog reads),
069 shipped `staff_brand_id_backfill`, and 083 backfilled the invitation rows.
A user/manager invitation that has assigned stores should therefore never be
written NULL-brand.

### The multi-brand-stores edge is already closed (so derivation is unambiguous)

- Spec 068's trigger
  (`supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql`)
  guarantees a NULL-brand user's `user_stores` rows are all within a SINGLE
  brand (first grant defines the brand; later cross-brand grants are rejected).
- `InviteUserDrawer` filters the STORES multi-select to the single active brand
  (`brandStores = stores.filter((s) => s.brandId === brandId)`,
  `src/components/cmd/InviteUserDrawer.tsx:84-87`, spec 068) and prunes stale
  cross-brand selections on a brand switch (lines 96-111).

So at invite time the assigned `storeIds` are already single-brand →
`store_ids[1]`'s brand is the unambiguous derived brand. This is the same
derivation `get_pending_invitation.resolved_brand_id` already uses.

## User story

As the **operator and the system**, I want **every new user/manager invitation
that has assigned stores to carry its store's brand at creation time (not
NULL)**, so that **the "(email not loaded)" admin-Users bug and the blank-EOD-
catalog staff bug class can't recur from a freshly-created invitation** —
without the operator having to enter a brand by hand.

## Acceptance criteria

- [ ] **User/manager invite WITH assigned stores → non-null `invitations.brand_id`.**
      Calling `inviteUser({ role: 'user', storeIds: [<a store in brand X>], brandId: null, … })`
      creates an `invitations` row whose `brand_id` equals brand X (the brand of
      the assigned store(s)), NOT NULL. The brand is DERIVED from the assigned
      stores — the operator does not supply it (the call site passes
      `brandId: null` for user invites, unchanged).
- [ ] **Admin invite path unchanged.** `inviteUser` with `role: 'admin'` and a
      non-null `brandId` still inserts that `brandId` verbatim; `role: 'admin'`
      with a null `brandId` still returns the existing
      `'Admin invitations require a brand assignment'` error
      (`src/lib/auth.ts:275-277`) and creates no row. No new behavior on the
      admin path.
- [ ] **Zero-store user invite remains allowed and brand-less by design.** A
      `role: 'user'` invite with `storeIds: []` (a legitimate, supported flow —
      `InviteUserDrawer.tsx:452-457` "The invitee can still be sent the
      invitation; they will gain access when stores are assigned", and spec 069
      treats zero-store as a benign no-op) is NOT blocked: it still creates an
      `invitations` row (with `brand_id = NULL`, since there is no store to
      derive from). The guard MUST NOT reject zero-store user invites.
- [ ] **Backward-compat — existing rows untouched.** This change affects only
      NEWLY-created invitations. Existing `invitations` and `profiles` rows
      (already repaired by the spec 069 / 083 backfills) are not re-touched by
      this spec. No new backfill is required for the app-level guard.
- [ ] **(If the architect also tightens a DB CHECK — see open question C)** a
      pgTAP arm proves a NULL-brand `profiles` row for `role='user'` WITH a
      `user_stores` grant is rejected, AND existing legitimate rows (including
      the zero-store / no-store-yet staff case) are NOT rejected; a
      backfill-completeness pre-flight (069 already backfilled) is asserted
      before the constraint is added. If the architect decides app-level only,
      this AC is N/A and the spec states so.
- [ ] **Tests land on the named tracks** (open question, Conventions): jest for
      the `inviteUser` guard/derivation (a user invite with stores produces a
      non-null `brand_id`; a zero-store user invite still succeeds with NULL; the
      admin path is unchanged — both the verbatim-passthrough and the
      missing-brand error). pgTAP ONLY if the architect tightens the CHECK or
      changes any function/grant (with `has_function_privilege` checks only if a
      grant changes; NO `set role anon`).

## In scope

- Prevent NEW NULL-brand invitations for **user/manager** roles **at the source**
  (`inviteUser`, `src/lib/auth.ts`), by DERIVING `brand_id` from the assigned
  stores' brand when `opts.brandId` is null and the invite has ≥1 store. The
  architect picks the exact mechanism (see open question A): derive at invite
  time in `inviteUser`, and/or rely on the existing register-time stamp + an
  `invitations` backfill, and/or both as belt-and-suspenders.
- Reusing the EXISTING server-side derivation
  (`get_pending_invitation.resolved_brand_id` = `COALESCE(brand_id, store_ids[1]
  brand)`, spec 069) rather than inventing a new one, OR a client-side
  derivation from `useStore.stores` at the `InviteUserDrawer` call site — the
  architect rules between these (see open question A; note the register-time
  RLS-context caveat that drove 069 to derive server-side).
- Optionally a DB-level guard (a `profiles_role_brand_consistent` CHECK
  tightening, and/or an `invitations` CHECK) — the architect decides whether
  app-level is sufficient or app + DB is warranted, with the backfill-
  completeness and zero-store caveats (open questions C, E).
- Updating the now-stale `InviteUserOptions.brandId` doc comment
  (`src/lib/auth.ts:258-260`) to reflect that user invites are no longer
  brand-less when they carry stores.
- Tests per the named tracks (jest mandatory for the `inviteUser` change; pgTAP
  only if a CHECK/function/grant changes).

## Out of scope (explicitly)

- **Re-touching the spec 083/084 read-side relaxations** (`fetchInvitationsForUserLookup`
  / `fetchBrandAdmins` brand-filter drops). They are landed and correct; this is
  purely the write-side source. (Rationale: those fixes make inference resilient
  to ANY future NULL-brand row regardless; touching them expands blast radius.)
- **Re-running or modifying the spec 069 / 083 backfills**
  (`20260528020000_staff_brand_id_backfill.sql`,
  `20260531010000_invitations_brand_id_backfill.sql`). They already repaired
  existing rows. (Rationale: this spec prevents NEW bad rows; the historical
  cleanup is done.)
- **The admin invite path.** Already guarded
  (`src/lib/auth.ts:275-277`); confirm-unaffected only, do not refactor.
  (Rationale: not the bug; admin invites can't be NULL-brand.)
- **Changing the staff app's runtime brand usage / EOD reads**
  (`src/screens/staff/`). The fix is at the admin invite write path; staff
  read-side is unchanged. (Rationale: separate, landed surface.)
- **The `registerInvitedUser` profile stamp** (spec 069 territory). It already
  correctly stamps the profile from `resolved_brand_id`; this spec does not
  alter it. The architect MAY note whether the invite-time write makes the
  register-time stamp redundant for the with-stores case, but the register-time
  stamp stays (it is the durable fallback for any invitation that was created
  NULL-brand). (Rationale: 069 is shipped; don't regress its durability fix.)
- **`InviteAdminDrawer`** — admin invites are already brand-scoped; do not
  refactor. (Rationale: different component, already correct.)
- **Adding a per-user brand picker to the invite UI.** The brand is derived from
  the assigned stores; the operator does not pick it. (Rationale: contradicts the
  data model and the existing single-active-brand UI; YAGNI.)
- **`app.json` slug** — untouched (load-bearing per CLAUDE.md). (Rationale:
  standing policy.)
- **Realtime** — `invitations` is not a realtime-published table and
  `UsersSection` uses no realtime channel; no `supabase_realtime` membership
  changes, so the `docker restart supabase_realtime_imr-inventory` ritual does
  NOT apply. (Rationale: not engaged; flagged so it is not cargo-culted.)

## Open questions resolved

The PM resolved both flagged questions against controlling precedent in landed
specs; neither genuinely blocks on a fresh user decision, so `Status:` is
`READY_FOR_ARCH`. The two LOAD-BEARING decisions (exact A mechanism, and whether
to also add a DB CHECK) are architect-decidable design picks, surfaced below for
the architect to finalize in the design doc.

- **Q (A) — Derive vs. require the brand for user invites?**
  → **Derive from the assigned stores** (do not require an explicit `brandId`
  for user roles). Rationale: (1) the data model already supports it — stores
  belong to a brand (`stores.brand_id`) and the assigned stores are
  single-brand-scoped at invite time (spec 068 trigger + `InviteUserDrawer`
  brand-filtered store list); (2) the exact derivation already exists server-side
  as `get_pending_invitation.resolved_brand_id` (spec 069); (3) the call site
  hard-codes `brandId: null` for users and offers no per-user brand picker, so
  REQUIRING an explicit brand would contradict the existing UI. **Architect
  finalizes the MECHANISM:** derive at invite time inside `inviteUser` (e.g. when
  `role !== 'admin' && !opts.brandId && storeIds.length > 0`, look up the first
  store's brand) vs. a client-side derive at the `InviteUserDrawer` call site
  (the drawer already has `useStore.stores` and `brandStores` in hand) vs.
  relying on the register-time stamp plus a fresh `invitations` backfill. Note
  the 069 §4 caveat: at REGISTER time a client-side `stores` read is RLS-blocked
  (user_stores rows don't exist yet) — but at INVITE time the inviting admin DOES
  have store visibility, so a client-side derive at the drawer, or a server-side
  derive in `inviteUser`'s own (admin-authenticated) session, is viable. The
  architect picks the least-duplicative, single-sourced option.

- **Q (B) — Can a user's assigned stores span more than one brand (ambiguous
  derivation)?**
  → **No.** Resolved by spec 068: the `user_stores_brand_match` trigger
  (`20260528010000_…`) rejects cross-brand grants for a NULL-brand user, and
  `InviteUserDrawer` only offers single-brand-scoped store options + prunes stale
  cross-brand selections. So `store_ids` at invite time is single-brand and
  `store_ids[1]`'s brand is unambiguous. The architect confirms (it is the same
  invariant 069's backfill relied on).

- **Q (C) — Tighten `profiles_role_brand_consistent` (DB-level guard)?**
  → **Architect-decidable; PM lean is app-level guard sufficient, DB CHECK
  optional.** The current CHECK
  (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:341-348`) has
  an UNCONDITIONAL `(role = 'user')` arm — it permits NULL OR set `brand_id` for
  staff (confirmed by inspection; the comment at line 347 says "staff app users;
  brand_id may be NULL or set"). Tightening it to REQUIRE a brand for
  `role='user'` would (a) need a migration + the `db-migrations-applied` gate +
  pgTAP, (b) need a backfill-completeness pre-flight (069 already backfilled
  the with-stores rows), and (c) **break the legitimate zero-store / no-store-yet
  staff case** unless the constraint is carefully written as "NULL brand allowed
  only when no `user_stores` grant exists" (a CHECK can't easily reference
  another table, so this likely needs a trigger, not a CHECK). PM lean:
  **app-level guard at the source is the targeted fix; a DB CHECK tightening is a
  larger, separable hardening.** If the architect elects the DB guard, it must
  preserve the zero-store case (open question E) and assert backfill-completeness
  first. The architect decides app-level-only vs. app + DB and states the
  rationale.

- **Q (D) — Backward-compat for existing rows?**
  → Existing NULL-brand invitations/profiles were already backfilled by spec
  069/083. This spec's app-level guard affects only NEW invites and does not
  re-touch existing rows. If a DB CHECK is added (C), it must validate against
  the already-backfilled data (069/083 left zero with-stores rows NULL) and a
  pre-flight asserts this before the constraint is added. The architect confirms
  no legitimate existing row trips a new guard.

- **Q (E) — Is a zero-store user invite valid (no derivable brand)?**
  → **Yes, valid and supported.** `InviteUserDrawer` explicitly permits sending a
  user invite with zero stores (the "No stores visible yet … the invitee can
  still be sent the invitation; they will gain access when stores are assigned"
  branch, `src/components/cmd/InviteUserDrawer.tsx:442-458`), and spec 069 treats
  the zero-store NULL-brand case as a benign no-op (the profile is stamped later
  when a store is assigned). **The guard MUST handle this by allowing a
  zero-store user invite to be created with NULL `brand_id`** — it neither blocks
  the invite nor guesses a brand. (This is the case that could have forced a user
  decision; the landed precedent answers it, so it does not block
  READY_FOR_ARCH.)

## Dependencies

- `src/lib/auth.ts` — `inviteUser` (`:269-321`, the write-side target;
  `InviteUserOptions` at `:254-266` with the stale comment), `registerInvitedUser`
  (`:323-415`, the register-time stamp — read-only reference, not modified).
  `src/lib/auth.ts` is a documented `db.ts` carve-out (CLAUDE.md) allowed to call
  `supabase.from/rpc` directly.
- `src/components/cmd/InviteUserDrawer.tsx` — the sole `inviteUser` caller
  (`:140-150`), which hard-codes `brandId: null` for user invites and holds the
  brand-filtered `brandStores` list; the likely locus if the architect picks a
  client-side derive.
- `supabase/migrations/20260528020000_staff_brand_id_backfill.sql` (spec 069) —
  defines `get_pending_invitation.resolved_brand_id` (the existing server-side
  derivation, `COALESCE(brand_id, store_ids[1] brand)`); the reuse target for a
  single-sourced derivation.
- `supabase/migrations/20260510000000_invitations_brand_id.sql` — `invitations.brand_id`
  column (nullable, FK `brands(id)` on delete cascade) and the original
  `get_pending_invitation` definition.
- `supabase/migrations/20260528010000_user_stores_brand_match_null_brand_guard.sql`
  (spec 068) — the single-brand-staff guarantee that makes the derivation
  unambiguous (open question B).
- `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:341-348` — the
  `profiles_role_brand_consistent` CHECK (the `(role='user')` arm is
  unconditional); the target IF the architect tightens the DB guard (open
  question C).
- `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql` (spec
  083) — the landed `invitations.brand_id` backfill (read-only reference; this
  spec prevents NEW bad rows rather than re-running it).
- `src/lib/registerInvitedUser.test.ts` (spec 069) — the jest pattern for
  mocking `./supabase` and capturing an INSERT payload; the model for the new
  `inviteUser` test (capture the `invitations` INSERT payload, assert `brand_id`).

## Project-specific notes

- **Cmd UI section / legacy:** Neither a Cmd section build nor legacy. This is a
  backend/auth write-path fix in `src/lib/auth.ts` (a `db.ts` carve-out), with a
  possible touch at the Cmd component `src/components/cmd/InviteUserDrawer.tsx`
  if the architect picks a client-side derive. No legacy surface (spec 025
  deleted `AdminScreens.tsx`).
- **Which app:** Admin app (this repo). The invite flow is admin-only; the
  affected downstream surfaces are admin Users & access (083/084) and the staff
  EOD app (068/069), but the WRITE being fixed is in the admin invite path.
- **Per-store or admin-global:** The invite surface is admin-global but
  brand-aware; the fix reconciles a user/manager invite's brand with its assigned
  (store-scoped) stores' brand. No per-store RLS policy change.
- **Edge function or PostgREST:** PostgREST/RPC. `inviteUser` writes via
  `supabase.from('invitations').insert(...)`; the existing derivation lives in
  the `get_pending_invitation` SECURITY DEFINER RPC. No edge function involved
  (the only edge calls in the path are the fire-and-forget `send-invite-email` /
  `send-welcome-email`, untouched).
- **Realtime channels touched:** None. `invitations` is not realtime-published
  and `UsersSection` uses no realtime channel; no `supabase_realtime` membership
  change → the `docker restart supabase_realtime_imr-inventory` ritual does NOT
  apply.
- **Migrations needed:** CONDITIONAL on the architect's open-question-C decision.
  App-level-guard-only (PM lean) → NO migration (a TS change in `inviteUser`,
  and/or a client derive in the drawer; possibly a fresh `invitations` backfill
  if the architect wants belt-and-suspenders, though 083 already backfilled).
  DB-CHECK tightening → YES, a migration that also engages the
  `db-migrations-applied` gate + pgTAP, with a backfill-completeness pre-flight.
- **Edge functions touched:** None.
- **Web/native scope:** Both. `inviteUser` is shared TS; `InviteUserDrawer`
  renders on web + native via `ResponsiveSheet`. No web-only surface.
- **Tests (spec 022 tracks):** jest (mandatory — the `inviteUser`
  guard/derivation: user-invite-with-stores → non-null `brand_id`; zero-store
  user invite → still succeeds with NULL; admin passthrough + admin
  missing-brand error both unchanged). pgTAP ONLY if a CHECK/function/grant
  changes (assert NULL-brand `role='user'`-with-stores profile rejected; existing
  rows incl. zero-store unaffected; `has_function_privilege` only if a grant
  changes; NO `set role anon`). No shell smoke.

## Review routing (note for the dispatcher)

This touches the brand/RLS data-model boundary (the same class as 068/069/083/084)
and may ship a migration if the architect tightens the CHECK. The reviewer
fan-out SHOULD include **security-auditor** alongside **code-reviewer** and
**test-engineer**, and **backend-architect (post-impl mode)** IF a migration
ships (CHECK tightening) — drift on the constraint/derivation contract is exactly
what post-impl review catches. If the architect lands an app-level-only guard
with no migration, code-reviewer + test-engineer + security-auditor suffices.

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. The core decision is open question A's
  MECHANISM (derive the user/manager invite brand server-side inside inviteUser,
  vs. client-side at the InviteUserDrawer call site, vs. lean on the existing
  register-time resolved_brand_id stamp plus a fresh invitations backfill, vs. a
  belt-and-suspenders combination) — reuse the existing
  get_pending_invitation.resolved_brand_id derivation (COALESCE(brand_id,
  store_ids[1] brand), spec 069) rather than inventing a new one. Also rule on
  open question C: app-level guard only vs. app + a DB-level guard
  (profiles_role_brand_consistent tightening and/or an invitations CHECK), being
  careful to PRESERVE the legitimate zero-store user invite (open question E,
  which stays brand-less by design) and to assert backfill-completeness (069/083
  already backfilled) before any constraint is added. Confirm open question B
  (single-brand stores → unambiguous derivation, per spec 068). Keep the admin
  path unchanged (already guarded at auth.ts:275-277) and do NOT re-touch the
  069/083 backfills or the 083/084 read-side relaxations. Name the test tracks:
  jest for the inviteUser guard/derivation (model on registerInvitedUser.test.ts
  — capture the invitations INSERT payload), pgTAP only if a CHECK/function/grant
  changes (NO set role anon). Then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/090/spec.md

---

## Backend design (architect)

### Summary of the decision

This is an **app-level-only, client-side derivation** fix. No migration, no RLS
change, no edge-function change, no realtime change. One load-bearing line in
`InviteUserDrawer` changes (the hard-coded `brandId: null`), one defense-in-depth
guard is added in `inviteUser`, and one stale doc comment is corrected. The
existing server-side derivation (`get_pending_invitation.resolved_brand_id`,
spec 069) and the register-time profile stamp stay untouched as the durable
fallback.

The reasons this is the right shape, not bigger:

- The bug is a thrown-away value, not a missing one. `InviteUserDrawer` ALREADY
  computes the brand (`brandId = brand?.id ?? null`, `InviteUserDrawer.tsx:76`)
  and ALREADY filters the store multi-select to that brand (`brandStores`,
  `InviteUserDrawer.tsx:84-87`, spec 068). Line 147 then deliberately discards it
  for user invites. The fix is to stop discarding it.
- A server-side read inside `inviteUser` would re-derive a brand the caller
  already holds — duplicative, and a second source of truth for the same value.
- A DB CHECK tightening is rejected for this spec (open question C, see §C below).

### Open-question resolutions (finalized)

**(A) Derivation mechanism — PRIMARY: client-side derive at the `InviteUserDrawer`
call site; SECONDARY: a server-side belt-and-suspenders guard in `inviteUser`.**

- **Primary (A2 — the actual fix).** At `InviteUserDrawer.tsx:147`, replace the
  hard-coded `brandId: values.role === 'admin' ? brandId : null` with the derived
  brand for the user/manager case. Because the store list is already
  brand-filtered to the single active brand, the brand is unambiguous (open
  question B), and the drawer already holds it in `brandId`. So:
  - admin → `brandId` (unchanged).
  - user **with ≥1 store selected** → the brand the selected stores belong to.
  - user **with zero stores** → `null` (open question E — stays brand-less).

  The exact derivation reuses the SAME COALESCE-store-brand logic
  `get_pending_invitation.resolved_brand_id` uses, expressed against the data the
  drawer already has in hand:

  ```
  derivedBrandId =
      values.role === 'admin'
        ? brandId                                  // unchanged admin path
        : values.storeIds.length > 0
            ? (brandStores.find((s) => s.id === values.storeIds[0])?.brandId ?? brandId ?? null)
            : null;                                // zero-store user → null (E)
  ```

  Why `brandStores.find(...storeIds[0]).brandId` and not just `brandId`: it makes
  the derivation explicitly "the brand of the assigned store" (mirroring
  `store_ids[1]` in the RPC) rather than implicitly "the active brand", so the
  written value provably matches the store assignment even if those two ever
  diverge in a future multi-brand-picker world. In today's single-active-brand UI
  the selected stores are all `brandId` anyway, so the `?? brandId` tail is the
  practical result — but the store-first form is the single-sourced derivation and
  is what the AC asks for ("DERIVED from the assigned stores"). Developer note:
  `storeIds[0]` is JS 0-indexed; the RPC's `store_ids[1]` is Postgres 1-indexed —
  same "first store", different index base. Do not introduce an off-by-one.

  `Store.brandId` is the camelCase field already on `useStore.stores` (the drawer
  reads `s.brandId` at line 85), so no new mapping is needed.

- **Secondary (A1 — defense-in-depth in `inviteUser`).** Because `src/lib/auth.ts`
  is a shared module and a future second caller could pass an unguarded
  `brandId: null` for a user invite with stores, add a small server-side derive in
  `inviteUser` BEFORE the `invitations.insert` (`src/lib/auth.ts:295`):

  ```
  // Spec 090 — derive brand from the first assigned store when a
  // user/manager invite arrives brand-less but store-scoped. Single-brand
  // store invariant (spec 068) makes storeIds[0] unambiguous. Zero-store
  // user invites stay NULL-brand by design (legitimate; profile is stamped
  // later at register time once a store is assigned — spec 069).
  let resolvedBrandId = opts.brandId;
  if (opts.role !== 'admin' && !resolvedBrandId && opts.storeIds.length > 0) {
    const { data: store } = await supabase
      .from('stores')
      .select('brand_id')
      .eq('id', opts.storeIds[0])
      .single();
    resolvedBrandId = store?.brand_id ?? null;
  }
  // ...then insert brand_id: resolvedBrandId
  ```

  This is a small single-row read by PK on the admin-authenticated session (the
  inviting admin has store visibility — the 069 §4 RLS caveat applies only at
  REGISTER time, not invite time). It is a SECOND-DEFENSE layer; the primary fix
  is the drawer change. **If the developer judges the secondary read redundant**
  (the only caller is the drawer, which now passes the derived brand), it MAY be
  omitted — but then the `inviteUser` jest "user-invite-with-stores derives
  brand" test moves to the drawer level instead. RECOMMENDATION: keep the
  `inviteUser` derive — it's a 6-line guard at the single chokepoint every
  invitation flows through, it makes the jest assertion sit on the `db.ts`
  carve-out (the durable contract surface) rather than on RN component internals,
  and it mirrors how the admin guard already lives in `inviteUser` (`:275-277`)
  not in the drawer. The two layers agree by construction (same store→brand
  lookup), so there is no divergence risk.

**(B) Single-brand stores → unambiguous derivation. CONFIRMED.** Spec 068's
`user_stores_brand_match` trigger
(`20260528010000_user_stores_brand_match_null_brand_guard.sql`) rejects
cross-brand grants for a NULL-brand user, and `InviteUserDrawer` only offers
single-brand-scoped store options and prunes stale cross-brand selections on a
brand switch (`InviteUserDrawer.tsx:96-111`). So `storeIds` at invite time is
single-brand; `storeIds[0]`'s brand is the same unambiguous value the RPC's
`store_ids[1]` derives. This is the invariant 069's backfill relied on.

**(C) App-level guard ONLY. NO DB CHECK tightening. NO migration.** Rationale:

- The current `profiles_role_brand_consistent` CHECK
  (`20260509000000_multi_brand_schema_rls.sql:341-348`) has an UNCONDITIONAL
  `(role = 'user')` arm — confirmed by inspection: line 347 comments "staff app
  users; brand_id may be NULL or set". This is CORRECT and must stay, because the
  legitimate zero-store user case (E) MUST be able to land NULL-brand.
- Tightening to "NULL brand only when no `user_stores` grant exists" cannot be a
  CHECK — a CHECK can't reference another table (`user_stores`). It would require
  a TRIGGER, plus a migration, plus the `db-migrations-applied` gate, plus a
  backfill-completeness pre-flight, plus pgTAP. That is a materially larger,
  separable hardening with its own blast radius — disproportionate to closing the
  one source emitter, which the app-level guard fully closes.
- The DB already has the durable safety net: `get_pending_invitation` derives
  `resolved_brand_id` server-side and `registerInvitedUser` stamps the PROFILE
  from it (spec 069). So even a hypothetical future NULL-brand invitation row
  still produces a correctly-branded PROFILE at register time. The remaining gap
  this spec closes is the invitation ROW itself (what spec 083's email-inference
  cared about), and the app-level write guard closes it at the source.
- **Therefore acceptance criterion "(If the architect also tightens a DB CHECK)"
  is N/A for this spec.** No pgTAP arm for a CHECK. (See §Tests — pgTAP is not
  run at all here because no CHECK/function/grant changes.)

**(D) Backward-compat — existing rows untouched. CONFIRMED.** This is a pure
write-path change affecting only NEW invitations. No backfill is added or re-run
(083 already backfilled `invitations.brand_id`; 069 backfilled `profiles`). No
existing row is read or mutated. No legitimate existing row can trip the guard
because there is no new constraint.

**(E) Zero-store user invite stays allowed and brand-less. PRESERVED BY DESIGN.**
Both the drawer derive and the `inviteUser` derive are gated on
`storeIds.length > 0`. A zero-store user invite yields `brandId: null`, the
INSERT succeeds with `brand_id = NULL`, no error is returned, and the
`brandStores.length === 0` "No stores visible yet … can still be sent" branch
(`InviteUserDrawer.tsx:442-458`) is unaffected. This matches 069's benign-no-op
treatment (the profile is stamped later when a store is assigned).

**Admin path unchanged. CONFIRMED.** The admin branch still returns
`brandId` verbatim in the drawer and `inviteUser` still returns
`'Admin invitations require a brand assignment'` for `role==='admin' && !brandId`
(`auth.ts:275-277`) before any of the new code runs (the new derive is gated on
`role !== 'admin'`). The 069/083 backfills and the 083/084 read-side relaxations
(`fetchInvitationsForUserLookup`, `fetchBrandAdmins`) are NOT touched.

### Data model changes

NONE. No new tables, columns, indexes, or constraints. No migration file.

Destructive vs additive: N/A (no schema change). Rollout safety: trivial — a
frontend/auth-module behavior change deployed via the normal Vercel/EAS path;
no DB step, no ordering concern.

### RLS impact

NONE. No new table, no policy added or modified. The new `inviteUser` `stores`
read (if the secondary derive is kept) runs under the inviting admin's session
and is admitted by the EXISTING `stores` SELECT policy via
`auth_can_see_store(...)` / brand visibility — the same policy that already lets
the drawer populate `useStore.stores`. If the admin can see the store in the
picker, they can read its `brand_id`. No `auth_is_admin()` /
`auth_can_see_store()` change.

### API contract

PostgREST, no RPC change.

- Existing write: `supabase.from('invitations').insert({...})` in `inviteUser`.
  The ONLY field that changes value is `brand_id` — now `resolvedBrandId` (derived)
  instead of the raw `opts.brandId`. Request/response shape of the INSERT is
  otherwise byte-identical.
- Existing optional read (secondary derive only):
  `supabase.from('stores').select('brand_id').eq('id', storeIds[0]).single()`.
  - Success: `{ data: { brand_id: uuid }, error: null }`.
  - Store not visible / not found: `.single()` returns `{ data: null, error }`.
    Handled by `store?.brand_id ?? null` → falls back to NULL-brand (no throw,
    no invite failure). This is acceptable: a store the admin can't read can't
    have been a valid selection in the brand-filtered picker, so the realistic
    path is always `data` present.
- `get_pending_invitation` RPC: UNCHANGED. `registerInvitedUser`: UNCHANGED.
  No new error cases surfaced to the operator. The admin missing-brand error
  string is unchanged.

### Edge function changes

NONE. No function is new or modified. `verify_jwt` settings unchanged. The
fire-and-forget `send-invite-email` / `send-welcome-email` calls are untouched
(payload unchanged — brand is not surfaced in the email template).

### `src/lib/db.ts` surface

NONE — no new `db.ts` helper. The write stays in `inviteUser`
(`src/lib/auth.ts`), which is a DOCUMENTED `db.ts` carve-out (CLAUDE.md
"Documented carve-outs"). The secondary `stores` read also lives in `auth.ts`,
inside the same carve-out, alongside the existing `supabase.from('invitations')`
calls. No snake_case→camelCase mapping needed: the `inviteUser` read uses raw
`store.brand_id` locally (it never returns it to the frontend), and the drawer
reads the already-camelCased `Store.brandId` off `useStore.stores`.

Do NOT route this through `db.ts` — `inviteUser` and its siblings are
deliberately in `auth.ts` per the carve-out, and the spec's "in scope" pins the
fix to `auth.ts` / `InviteUserDrawer`.

### Realtime impact

NONE. `invitations` is not a member of the `supabase_realtime` publication and
`UsersSection` subscribes to no realtime channel. Neither `store-{id}` nor
`brand-{id}` replays this. **The `docker restart supabase_realtime_imr-inventory`
ritual does NOT apply** — no publication membership changes. (Flagged explicitly
so it is not cargo-culted; the spec's out-of-scope section already calls this
out.)

### Frontend store impact

NO slice of `src/store/useStore.ts` changes. The drawer only READS existing
state (`s.stores`, `s.brand`) — both already populated. There is no optimistic
write to `useStore` here: `inviteUser` is an `await`-ed RPC-style call whose
result drives a `Toast`, not an optimistic-then-revert store mutation. The
optimistic-then-revert + `notifyBackendError` pattern does NOT apply (this is a
fire-once form submit, error surfaced via the existing `Toast.show({ type:
'error' })` at `InviteUserDrawer.tsx:152-159`). `onInvited?.()` already triggers
the users-list refresh on success.

### Doc-comment correction (in scope, required)

Update the now-stale `InviteUserOptions.brandId` comment (`src/lib/auth.ts:258-260`)
from "Allowed null for role='user' (staff app users have no brand scope today)"
to reflect that a user/manager invite WITH assigned stores now carries the
store's brand (derived), and `null` is reserved for the zero-store user case.
Keep it factual and short.

### Test contract

**jest (mandatory).** Model on `src/lib/registerInvitedUser.test.ts` — mock
`./supabase`, capture the `invitations` INSERT payload, assert `brand_id`. New
file `src/lib/inviteUser.test.ts` (or extend the existing `src/lib/auth.test.ts`
if its mock surface is widened to cover `from('invitations').insert`,
`from('invitations').select().eq().eq().single()` for the dup-check, and
`from('invitations').delete().lt().eq()` for the expired-cleanup, plus
`from('stores').select().eq().single()` for the secondary derive). A dedicated
file is cleaner (the existing `auth.test.ts` only stubs `auth.getSession`).
Required cases:

1. **User invite WITH a store derives a non-null brand.** `inviteUser({ role:
   'user', storeIds: ['<store in BRAND_A>'], brandId: null, ... })` → the
   captured `invitations` INSERT payload has `brand_id === BRAND_A` (the brand
   the mocked `stores` read returns for that store id), NOT null. (This is the
   AC-110 assertion; it sits on `inviteUser` because the secondary derive is
   kept.)
2. **Zero-store user invite still succeeds with NULL brand.** `inviteUser({
   role: 'user', storeIds: [], brandId: null, ... })` → `{ error: null }` AND the
   captured INSERT payload has `brand_id === null`. No `stores` read fires (assert
   the `from('stores')` mock was not called, or that the derive branch was
   skipped). (AC-122.)
3. **Admin passthrough unchanged.** `inviteUser({ role: 'admin', brandId:
   BRAND_A, storeIds: [...] })` → INSERT payload `brand_id === BRAND_A` verbatim;
   the `stores` derive branch does NOT fire for admin. (AC-116, half 1.)
4. **Admin missing-brand error unchanged.** `inviteUser({ role: 'admin',
   brandId: null, ... })` → `{ error: 'Admin invitations require a brand
   assignment' }` and NO `invitations` INSERT occurs (assert the insert mock was
   not called). (AC-116, half 2.)

Optional (drawer-level, if the developer wants it): a render test asserting the
drawer passes the derived brand for a user invite with a checked store. Not
required if the `inviteUser` derive is kept — the `inviteUser` jest covers the
contract. If the developer OMITS the secondary `inviteUser` derive (option to
drop A1), cases 1–4 MUST move to a drawer-level test that captures the
`inviteUser` argument.

**pgTAP: NONE.** No CHECK, function, grant, or policy changes (open question C =
app-level only). Do NOT add a pgTAP arm. (Per the spec's test note and the
standing rule: NO `set role anon`; `has_function_privilege` only when a grant
changes — neither applies.)

**shell smoke: NONE.**

### Risks and tradeoffs (explicit)

- **Two derivation layers could drift.** MITIGATED: both layers compute the same
  thing (brand of the first assigned store) and both gate on `storeIds.length >
  0` and `role !== 'admin'`. The `inviteUser` layer is the authoritative one the
  jest test pins; the drawer layer is the practical path. They cannot disagree on
  the value because the single-brand-store invariant (B) makes "active brand" ==
  "brand of any selected store". If a future multi-brand picker lands, the
  store-first form in BOTH layers keeps them correct; revisit only if the picker
  allows mixed-brand selections (which the 068 trigger currently forbids).
- **Secondary `stores` read adds one round-trip to every store-scoped user
  invite.** NEGLIGIBLE: a single PK lookup, on a low-frequency admin action (issuing
  an invite), not on a hot path. No impact on the 286 KB seed dataset (reads one
  row by id). If the developer drops A1, even this disappears.
- **A store the admin can't read returns `data: null`.** The derive falls back to
  NULL-brand rather than erroring — a defensive no-throw. This is strictly safer
  than the status quo (which always wrote NULL) and cannot regress a valid invite,
  since an unreadable store could never have been selected in the brand-filtered
  picker. Acceptable.
- **No DB-level guarantee that future code can't write a NULL-brand user invite
  WITH stores.** ACCEPTED (open question C). The durable PROFILE-side safety net
  (069's `resolved_brand_id` stamp) remains; the DB CHECK/trigger hardening is a
  deliberately separable follow-up, not silently skipped. If a future spec wants
  the table-layer guarantee, it adds a trigger (not a CHECK) with a
  backfill-completeness pre-flight and pgTAP — out of scope here.
- **Migration ordering / `db-migrations-applied` gate:** N/A — no migration.
- **Edge function cold-start:** N/A — no edge function touched.
- **app.json slug:** untouched (standing policy).

### Files the developer will change

- `src/lib/auth.ts` — add the secondary brand derive in `inviteUser` before the
  `invitations.insert` (`:295`); write `brand_id: resolvedBrandId`; correct the
  `InviteUserOptions.brandId` doc comment (`:258-260`).
- `src/components/cmd/InviteUserDrawer.tsx` — replace the hard-coded
  `brandId: values.role === 'admin' ? brandId : null` (`:147`) with the
  store-derived brand for the user/manager case.
- `src/lib/inviteUser.test.ts` — NEW jest file (or extend `src/lib/auth.test.ts`),
  the four cases above.

## Handoff
next_agent: frontend-developer
prompt: Implement against the "## Backend design (architect)" section in this
  spec. Two edits plus a test: (1) in src/components/cmd/InviteUserDrawer.tsx,
  replace the hard-coded brandId: null at line 147 with the store-derived brand
  for the user/manager case (admin path unchanged; zero-store user stays null);
  (2) in src/lib/auth.ts, add the defense-in-depth server-side derive in
  inviteUser before the invitations.insert (gated on role !== 'admin' &&
  !opts.brandId && storeIds.length > 0, a single stores PK read for brand_id),
  write brand_id: resolvedBrandId, and correct the stale InviteUserOptions.brandId
  doc comment; (3) add src/lib/inviteUser.test.ts modeled on
  registerInvitedUser.test.ts covering the four cases (user-with-store derives
  brand, zero-store user stays null, admin passthrough, admin missing-brand
  error). NO migration, NO pgTAP, NO RLS/realtime/edge change. Reuse the
  COALESCE(brand_id, brand of first store) derivation; do not invent a new one.
  Do not re-touch the 069/083 backfills or the 083/084 read-side relaxations.
  After implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/090/spec.md

---

## Files changed

- `src/components/cmd/InviteUserDrawer.tsx` — PRIMARY fix. Replaced the
  hard-coded `brandId: values.role === 'admin' ? brandId : null` at the
  `inviteUser` call site with a `derivedBrandId`: admin → `brandId` (unchanged);
  user/manager WITH ≥1 store → the assigned store's brand
  (`brandStores.find((s) => s.id === values.storeIds[0])?.brandId ?? brandId ?? null`,
  the store-first form mirroring the RPC's `store_ids[1]` derivation); zero-store
  user → `null` (legitimate, preserved).
- `src/lib/auth.ts` — (a) defense-in-depth derive in `inviteUser` BEFORE the
  `invitations.insert`: gated on `opts.role !== 'admin' && !resolvedBrandId &&
  opts.storeIds.length > 0`, a single `stores` PK read for `storeIds[0]`'s
  `brand_id`, then `brand_id: resolvedBrandId` on the insert (zero-store and
  admin paths skip the read; admin missing-brand error unchanged at `:275-277`).
  (b) Corrected the stale `InviteUserOptions.brandId` doc comment to reflect
  that user invites now derive the brand from their assigned stores, with `null`
  reserved for the zero-store case.
- `src/lib/inviteUser.test.ts` — NEW jest file (modeled on
  `registerInvitedUser.test.ts`), four cases: (1) user invite WITH a store →
  non-null `brand_id` derived from the store's brand + derive read fired; (2)
  zero-store user invite → `error: null`, `brand_id: null`, derive read NOT
  fired; (3) admin invite → `brandId` passthrough verbatim, derive read NOT
  fired; (4) admin invite with no brand → existing
  `'Admin invitations require a brand assignment'` error and NO insert.

### Verification

- jest: `src/lib/inviteUser.test.ts` 4/4 pass; full `npx jest` 557/557 green
  across 56 suites.
- typecheck: `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json
  --noEmit` (test graph) both exit 0.
- Live local DB (real seed data, rolled-back transaction): the derive produces
  `brand_id = 2a000000-…-001` (Towson store's brand) for a user-with-store
  invite, and a zero-store user invite lands `brand_id = NULL` without tripping
  the `invitations` CHECK constraint.
- Browser/UI: no `preview_*` harness or connected chrome-extension tools were
  available in this session, and a node ts-node run of the real `inviteUser`
  could not load the RN-flavored `src/lib/supabase.ts` under node. The full
  client code path is instead covered by the jest suite (the `./supabase`
  boundary mocked — derive read, insert payload, zero-store skip, admin
  passthrough/error all asserted) plus the live-DB end-to-end of the derivation
  itself.
