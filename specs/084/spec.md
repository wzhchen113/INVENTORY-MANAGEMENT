# Spec 084: `fetchBrandAdmins` NULL-brand email-inference blind spot + stale `auth.ts` comment

Status: READY_FOR_REVIEW

## Background

This is the explicitly-deferred follow-up to spec 083 (shipped, commit `140377e`,
CI green). Spec 083 fixed the **Users & access** "(email not loaded)" bug — email
is inferred from the `invitations` table, but affected users' invitations carried
`brand_id = NULL` while the inference query filtered by `brand_id`, hiding them.
Spec 083 fixed it two ways: (1) a data-only backfill migration
`20260531010000_invitations_brand_id_backfill.sql` (filled `invitations.brand_id`
from each linked profile's brand), and (2) dropped the `.eq('brand_id', brandId)`
filter from `fetchInvitationsForUserLookup` in `src/lib/db.ts` (the loader behind
**Users & access**, via `fetchAllUsers`).

The spec-083 backend-architect (§7 of `specs/083/spec.md`) and code-reviewer
**deferred two items to a follow-up** — this spec:

- **Part A (the real work):** `fetchBrandAdmins` (`src/lib/db.ts:3242`) — the loader
  for the **Brands tab → members detail pane** (a DIFFERENT screen, the one spec
  082 touched) — carries the SAME `.eq('brand_id', brandId)` shape on its
  invitations read (`src/lib/db.ts:3259`). It therefore has the symmetric
  NULL-brand blind spot: a registered user whose only invitation is NULL-brand
  would not have their email resolved in the Brands-tab members pane for a
  brand-scoped query.

  Unlike `fetchInvitationsForUserLookup` (which exists ONLY for email inference),
  `fetchBrandAdmins` uses its single `invites` array for **TWO** purposes:
  1. **Email inference** (`src/lib/db.ts:3297-3304`) — builds `inviteByProfileId`
     / `inviteByName` maps. This WANTS the unfiltered set so NULL-brand invites
     are caught (the symmetric fix).
  2. **Synthetic "pending" row construction** (`src/lib/db.ts:3334`:
     `const pendingInvites = invites.filter((inv) => !inv.used)`) — produces
     `status='pending'` User rows so the UI shows "Bobby invited yesterday, not
     yet registered." If the brand filter is naively dropped, a NULL-brand
     UNCONSUMED invitation would leak into EVERY brand's members tab as a phantom
     pending row (cross-brand pollution).

  So the central design question is: **how to relax the brand filter for
  email-inference purposes WITHOUT polluting the pending-row list.** Left as an
  explicit open question for the architect (see "Open questions" below).

- **Part B (trivial):** the comment at `src/lib/auth.ts:468-470` is now FALSE.
  Spec 083 dropped the brand filter but deliberately froze `fetchAllUsers` as
  read-only-verify, leaving this sibling-file comment stale on purpose, to be
  swept here.

### Urgency framing (honest)

Part A is primarily about **RESILIENCE + completing the symmetry**, not a live
user-reported breakage on the Brands tab. After spec 083's backfill, the DATA is
already repaired for the currently-affected users (Bobby/Charles — their used
invites now carry a real `brand_id` and are included in the brand-filtered
query). The spec-083 architect noted explicitly: **"no user has reported it on
that surface."** So this is the same belt-and-suspenders posture as 083, at lower
urgency. The pending-row pollution guard, however, is load-bearing the moment the
filter is relaxed (see the `createInvite` finding below) — it is the thing that
keeps the relaxation from regressing the Brands tab.

### Material finding for the architect: new NULL-brand invites CAN be created

The task brief asked to check `createInvite`. There is **no function named
`createInvite`** in `src/lib/auth.ts`. Invite creation lives in the
invite-user path at **`src/lib/auth.ts:294`** (`supabase.from('invitations').insert({…})`).
Two facts the architect needs for the pollution-risk assessment:

- **Admin** invites are guarded: `if (opts.role === 'admin' && !opts.brandId)`
  returns an error (`src/lib/auth.ts:274-276`) — a new ADMIN invite cannot be
  NULL-brand.
- **Non-admin** invites (`manager`, `user`, …) insert `brand_id: opts.brandId`
  with **no guard** (`src/lib/auth.ts:294-303`). If a caller omits `brandId`, a
  NEW NULL-brand UNCONSUMED invitation can be created.

**Implication:** the pending-row pollution risk is NOT limited to legacy rows —
it is live for non-admin pending invites whenever `brandId` is omitted. The
pollution guard in Part A therefore protects current and future data, not just
historical drift. (Whether the non-admin invite path SHOULD also require a brand
is a separate question and is OUT of scope here — flagged for the architect to
note, not chase.)

## User story

As a **super_admin or brand admin viewing the Brands tab → members detail pane**,
I want **every registered member's email to render correctly even when their
invitation row carries a NULL brand**, so that **the members pane is consistent
with the Users & access fix (spec 083)** — without **a NULL-brand pending
invitation from another brand leaking in as a phantom "pending" member row.**

## Acceptance criteria

Email inference (the symmetric fix):
- [ ] `fetchBrandAdmins(brandId)` resolves a non-empty `email` for a registered
      profile (status `active`) whose only matching invitation is NULL-brand and
      is matched by `profile_id`, when that `brandId` is passed. (Pre-fix the
      `.eq('brand_id', brandId)` read would exclude the NULL-brand invitation and
      the row would render an empty email.)

Pending-row pollution guard (the load-bearing assertion):
- [ ] A NULL-brand, UNCONSUMED (`used=false`) invitation does NOT appear as a
      `status='pending'` User row in the result of `fetchBrandAdmins(brandId)`
      for a brand it does not belong to. Concretely: given a profiles set scoped
      to brand X and an unconsumed invitation with `brand_id = NULL`, the returned
      array contains NO `status='pending'` row sourced from that NULL-brand
      invitation. (This is the regression the naive `.eq`-drop would introduce.)
- [ ] An UNCONSUMED invitation whose `brand_id` EQUALS the queried `brandId`
      still appears as exactly one `status='pending'` row (the legitimate
      pending-member case is preserved — the guard tightens NULL-brand, it does
      not drop in-brand pendings).

Regression-safety (spec 082 behavior preserved):
- [ ] An existing spec-082 behavior is unchanged: a registered user with a
      `used=true` name-matching invite still resolves a non-empty email, and a
      consumed invite for an active user does not duplicate as a phantom pending
      row. (The existing `src/lib/db.fetchBrandAdmins.test.ts` arms (a)-(d)
      continue to pass.)

Part B (comment correctness):
- [ ] The comment at `src/lib/auth.ts:468-470` no longer references "Cleanup #16
      scopes the query to the current brand." It reflects reality: spec 083
      dropped the brand filter; `fetchInvitationsForUserLookup` now reads ALL
      invitations; the per-user `profile_id`/name match scopes inference; the
      `opts?.brandId` passed to the helper is currently ignored. (Mirror the
      authoritative corrected wording already in the `db.ts`
      `fetchInvitationsForUserLookup` doc block, spec 083.)

Tests / build:
- [ ] New jest arms in `src/lib/db.fetchBrandAdmins.test.ts` cover the
      email-inference AC and the pending-row pollution-guard AC above.
- [ ] `npx tsc --noEmit` (base) and `npx tsc -p tsconfig.test.json --noEmit`
      (test graph) both exit 0; full jest suite green.

## In scope

- Relax `fetchBrandAdmins`'s invitations brand filter (`src/lib/db.ts:3259`) for
  **email-inference** purposes so a NULL-brand invitation matched by `profile_id`
  (or name) resolves an email when a `brandId` is passed — WITHOUT polluting the
  synthetic pending-row list (`src/lib/db.ts:3334`) with cross-brand NULL-brand
  unconsumed invites. The exact mechanism is the architect's design-time decision
  (see Open questions).
- Fix the stale comment at `src/lib/auth.ts:468-470` (Part B).
- jest coverage extending `src/lib/db.fetchBrandAdmins.test.ts` (spec 082
  template).

## Out of scope (explicitly)

- **Re-touching `fetchInvitationsForUserLookup`, `consume_invitation`, or the
  spec-083 migration** — all landed and prod-confirmed. Rationale: re-opening
  freshly-reviewed code invites regression for no benefit; this spec builds on
  them as fixed infrastructure.
- **Any new migration.** The spec-083 backfill already repaired the data for the
  currently-affected users; this is a TS-only spec. Exception: if the architect
  surfaces a genuine data reason, that is a design-time escalation back to the PM,
  not a silent ride-along.
- **Adding an email column to `profiles`** — large schema change; the email-via-
  `invitations` inference model stays. Rationale: same model spec 082/083 kept.
- **The bootstrap super_admin with no invitation row** stays "(email not loaded)"
  — there is no invitation to infer from. Accepted gap, identical to spec 083.
- **Requiring a `brand_id` on the non-admin invite-creation path
  (`src/lib/auth.ts:294`).** The NULL-brand-pending finding above is flagged for
  the architect's risk analysis only; changing the invite-creation guard is a
  separate behavior change. Rationale: this spec fixes the READ-side blind spot,
  not the WRITE-side policy.
- **Frontend changes.** `BrandsSection` members tab consumes `fetchBrandAdmins`
  through `loadBrandAdmins` (`src/store/useStore.ts:721`) with an unchanged
  signature and shape; no UI/store edit is expected. Rationale: this is a
  read-path correctness fix, not a contract change. (The frontend-developer is
  not needed unless the architect disagrees — flagged below.)
- **`app.json` slug** — untouched (`towson-inventory` remains; load-bearing,
  pending separate user approval per CLAUDE.md).
- **Realtime** — `fetchBrandAdmins` is dispatched on selection change
  (`useStore.ts:719-721`), not via a realtime channel; this spec adds none.

## Open questions

### Resolved (enough for the architect to design)

- Q: Which loader and screen does Part A touch? → A: `fetchBrandAdmins`
  (`src/lib/db.ts:3242`), the **Brands tab → members detail pane**, reached via
  `loadBrandAdmins` (`src/store/useStore.ts:721`). This is the screen spec 082
  touched — a DIFFERENT screen from spec 083's Users & access (`fetchAllUsers`).
- Q: Is Part A a live user-reported bug? → A: No. The spec-083 architect noted
  "no user has reported it on that surface," and the spec-083 backfill already
  repaired the data for Bobby/Charles. Part A is resilience + symmetry — lower
  urgency than 083, same belt-and-suspenders posture.
- Q: Can new NULL-brand pending invites even be created (does the pollution guard
  matter beyond legacy rows)? → A: YES for non-admin roles. `src/lib/auth.ts:294`
  inserts `brand_id: opts.brandId` with no guard for non-admin invites; admin
  invites are guarded (`auth.ts:274-276`). So the pollution guard is load-bearing
  for current/future data, not just legacy.
- Q: Migration needed? → A: No (TS-only). Confirmed unless the architect surfaces
  a data reason — escalate to PM if so.
- Q: Frontend change needed? → A: Not expected. `fetchBrandAdmins`'s return shape
  is unchanged; `BrandsSection`/`useStore` consume it unaltered. Flagged for the
  architect to confirm.

### DESIGN-TIME DECISION — left to the architect (NOT a blocking PM question)

The **central mechanism** of Part A is intentionally left for the architect to
finalize: **how to relax the brand filter for email inference while keeping the
pending-row construction brand-scoped.** Candidate shapes the architect should
weigh (surface and decide — do not assume the PM has pre-decided):

- **(a)** Drop the `.eq('brand_id', brandId)` on the `invitations` query (so
  inference sees all invites) and re-apply a `brand_id === brandId` filter ONLY
  to the `pendingInvites` construction at `src/lib/db.ts:3334`. Question to
  settle: should a NULL-brand pending invite be excluded from EVERY brand
  (strict-equality, my reading of the AC), or surfaced only in some "no brand"
  bucket (out of scope — there is no such bucket in the Brands tab)?
- **(b)** Two separate invitation reads — one unfiltered for inference, one
  brand-scoped for pending. Tradeoff: an extra round-trip vs. clearer separation
  of concerns; `invitations` is a tiny table (286 KB seed has zero invitation
  rows), so the cost is negligible.
- **(c)** Something else the architect prefers (e.g. a single read plus a derived
  in-memory partition).

Whichever shape is chosen, the AC fixes the OBSERVABLE contract: NULL-brand
invites feed inference; NULL-brand UNCONSUMED invites never appear as pending
rows in a brand they don't belong to; in-brand pendings are preserved. The
architect picks the implementation; the pollution guard is the load-bearing
assertion the jest arms must pin.

Note also: the existing code already clips pending rows' `stores` to
`brandStoreIds` (`src/lib/db.ts:3344`), but that clips the store list WITHIN a
row — it does not prevent a wrong-brand pending ROW from appearing. The fix must
gate the ROW, not just its stores. The architect should confirm this distinction
in the design.

## Dependencies

- **Spec 082 (landed):** `fetchBrandAdmins`'s email-inference + pending-row split
  (`src/lib/db.ts:3242-3353`); `consume_invitation` sets `profile_id` on accept;
  `db.fetchBrandAdmins.test.ts` (the jest template to extend).
- **Spec 083 (landed):** the `fetchInvitationsForUserLookup` relaxation +
  `20260531010000_invitations_brand_id_backfill.sql` (the data is already
  repaired) + the authoritative corrected doc-comment wording the Part B fix
  should mirror.
- `invitations` table columns `email, name, role, store_ids, brand_id, used,
  expires_at, profile_id` (`brand_id` nullable, FK to `brands(id)` —
  `supabase/migrations/20260510000000_invitations_brand_id.sql`).
- Affected TS: `src/lib/db.ts` (`fetchBrandAdmins`, lines 3242-3353),
  `src/lib/auth.ts` (comment at 468-470), `src/lib/db.fetchBrandAdmins.test.ts`.
  Consumed by `src/store/useStore.ts` (`loadBrandAdmins`, line 721) →
  `src/screens/cmd/sections/BrandsSection`.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI — `BrandsSection` members tab. No legacy
  surface (spec 025 deleted `AdminScreens.tsx`).
- **Per-store or admin-global:** Brand-scoped. `fetchBrandAdmins(brandId)` is
  per-brand; the fix relaxes the email-inference sub-query's brand scope for the
  narrow purpose of inference while KEEPING the pending-row list brand-scoped. It
  does NOT loosen which profiles appear (still `.eq('brand_id', brandId)` on the
  `profiles` read, `src/lib/db.ts:3250`).
- **Edge function or PostgREST:** PostgREST. No RPC, no edge function. The
  invite-creation finding touches `send-invite-email` only tangentially (out of
  scope; flagged for context).
- **Realtime channels touched:** None. `fetchBrandAdmins` is selection-dispatched,
  not realtime-driven. The `docker restart supabase_realtime_imr-inventory`
  ritual does NOT apply (no publication change — no migration at all).
- **Migrations needed:** No (TS-only). Escalate to PM if the architect finds a
  data reason.
- **Edge functions touched:** None.
- **Web/native scope:** Both (shared TS loader; no web-only or native-only
  surface). No CSS/web-push involved.
- **Tests (spec 022 tracks):** jest only. Extend
  `src/lib/db.fetchBrandAdmins.test.ts` (spec 082 template) with: (1) a NULL-brand
  invitation matched by `profile_id` resolves an email when a `brandId` is passed;
  (2) **the pollution guard** — a NULL-brand unconsumed invite does NOT appear as
  a pending row in a brand it doesn't belong to (the load-bearing assertion); (3)
  an in-brand unconsumed invite still yields exactly one pending row. **No pgTAP**
  (TS-only, no migration) — confirm with the architect. No shell-smoke track.
- **app.json slug:** Untouched (`towson-inventory` remains).

## Handoff
next_agent: backend-architect
prompt: Design the contract for this spec. The central design-time decision is
  Part A's mechanism — how to relax `fetchBrandAdmins`'s `.eq('brand_id', brandId)`
  invitations read (src/lib/db.ts:3259) so NULL-brand invites feed email inference
  WITHOUT a NULL-brand unconsumed invite polluting the synthetic pending-row list
  (src/lib/db.ts:3334) of a brand it doesn't belong to. Weigh shapes (a) re-apply
  a brand filter only to pendingInvites, (b) two reads, (c) other — and finalize
  one. Factor in the finding that non-admin invites CAN be created NULL-brand
  (src/lib/auth.ts:294, unguarded) so the pollution guard protects live data, not
  just legacy. Specify the Part B comment rewrite (src/lib/auth.ts:468-470) to
  mirror the spec-083 fetchInvitationsForUserLookup doc block. Confirm jest-only
  (no pgTAP, no migration) and that no frontend/store change is needed. Then set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/084/spec.md

---

## Backend design (architect)

### Scope confirmation (what this spec is and is NOT)

A TS read-path correctness fix. Two source edits + one test-file extension.
No DB objects change, so:

- **Migration: NONE.** Spec 083's `20260531010000_invitations_brand_id_backfill.sql`
  already repaired the data for the currently-affected users. This is the same
  decision the spec already pre-resolved (Open questions → "Migration needed? →
  No"). I surface no data reason to escalate — the symmetric fix is achievable
  entirely in the TS read path, and the pollution guard is pure in-memory
  predicate logic. **Confirmed: no migration.**
- **pgTAP: NONE.** No new/changed DB object (table, column, index, RLS policy,
  RPC, function). pgTAP exercises DB objects; there is nothing for it to assert
  here. **Confirmed: jest-only.** (Matches the spec's "Tests (spec 022 tracks):
  jest only … No pgTAP".)
- **RLS impact: NONE.** No table/policy added or altered. `fetchBrandAdmins`
  reads `profiles`, `invitations`, `stores`, `user_stores` through PostgREST
  under the existing 012a/012b admin + `super_admin_read_all_profiles` policies
  (cited in the function's own doc block, `src/lib/db.ts:3237-3240`). Dropping a
  client-side `.eq('brand_id', …)` predicate does NOT widen what RLS admits — it
  only stops the *client* from narrowing a set RLS already authorizes the caller
  to read. The caller could already read every invitation row RLS lets through;
  we now stop discarding the NULL-brand ones before inference. **Confirmed: no
  RLS change.**
- **Edge function impact: NONE.** No function added/modified; no `verify_jwt`
  change; no service-token strategy. The spec's note that the invite-creation
  finding "touches `send-invite-email` only tangentially" is correct and OUT of
  scope. **Confirmed: no edge change.**
- **Realtime impact: NONE.** `fetchBrandAdmins` is dispatched on BrandsSection
  selection change via `loadBrandAdmins` (`src/store/useStore.ts:721`), not from
  a `store-{id}` / `brand-{id}` channel. No `supabase_realtime` publication
  membership changes (no migration at all), so the
  `docker restart supabase_realtime_imr-inventory` ritual does NOT apply.
  **Confirmed: no realtime change, no publication gotcha.**
- **Frontend / store impact: NONE.** `fetchBrandAdmins(brandId): Promise<User[]>`
  signature and return shape are unchanged. `loadBrandAdmins`
  (`src/store/useStore.ts:721-724`) keys the returned `User[]` by `brandId`
  unaltered; `BrandsSection` consumes it as before. The optimistic-then-revert /
  `notifyBackendError` pattern does not apply — this is a read loader, not a
  mutation. **Confirmed: no frontend-developer needed.** (Matches the spec's
  "Frontend changes" out-of-scope line.)

### Data model changes

None. No new tables, columns, indexes, or proposed migration filename. The
`invitations` table columns this loader reads
(`id, email, name, role, store_ids, brand_id, used, expires_at, profile_id`)
are unchanged; `brand_id` remains nullable (FK to `brands(id)`,
`20260510000000_invitations_brand_id.sql`).

### API contract

Unchanged. PostgREST read (no RPC, no edge function). The only wire-level change
is removing one client predicate from the `invitations` SELECT inside
`fetchBrandAdmins`: the query goes from brand-scoped to all-invitations-the-
caller-can-see. Request/response shape of the function is identical; error cases
unchanged (`profilesRes.error` still rethrown).

### The central decision — CHOSEN SHAPE: (a) drop-and-re-gate

**Decision: Shape (a).** Drop `.eq('brand_id', brandId)` from the `invitations`
query so email inference sees all invitations the caller is authorized to read,
and re-apply a STRICT-equality `inv.brand_id === brandId` predicate ONLY to the
`pendingInvites` construction. This is the smallest correct diff, it mirrors how
spec 083 reasoned about `fetchInvitationsForUserLookup` (drop the table-read
narrowing; let the per-row match do the scoping), and it keeps a single read.

**Why not (b) two reads:** Shape (b) (one unfiltered read for inference, one
brand-scoped read for pending) is *defensible* — it separates "all invites for
inference" from "this brand's invites for pending" at the query layer. But it
costs a second round-trip to `invitations` on every BrandsSection selection for
zero correctness benefit: the in-memory partition in (a) is exact, and the
286 KB seed has **zero** invitation rows so there is no dataset-size argument
for pushing the filter to Postgres. (b) also forks the `invites` array, which
means two `.abortSignal(signal)` sites to keep in sync and a second place a
future column-list edit must be mirrored. (a) keeps one source of truth for the
row set. Rejected on cost-without-benefit grounds.

**Why not (c) derived partition into two named arrays:** Equivalent behavior to
(a) but more ceremony (an extra `allInvites` vs `brandInvites` split) for a
loader where inference already iterates the full array and only ONE downstream
derivation (`pendingInvites`) needs the brand gate. (a) localizes the entire
change to two lines. Rejected as needless surface.

**The predicate, stated precisely (the load-bearing detail):** the pending-row
gate is **strict equality** `inv.brand_id === brandId`, NOT a "include if NULL"
or "include if NULL-or-match" relaxation. `brandId` is always a non-empty string
at this point (the `if (!brandId) return [];` guard at `src/lib/db.ts:3243`
already excluded the empty case). Therefore:

- a NULL-brand invite: `null === brandId` → `false` → **excluded from EVERY
  brand's pending list.** This is exactly AC #2 (the pollution guard) — a
  NULL-brand unconsumed invite belongs to no brand and surfaces in none. There
  is no "no-brand bucket" in the Brands tab (the spec confirms this), so
  exclude-from-all is the correct and only sensible reading.
- an in-brand invite (`inv.brand_id === brandId`): `true` → **retained** → still
  yields its pending row. This is AC #3 (in-brand pendings preserved).
- a foreign-brand invite (`inv.brand_id === someOtherBrand`): `false` →
  excluded. (Already true pre-fix via the query filter; preserved post-fix via
  the predicate. No behavior change for this case — but note it now relies on
  the JS predicate rather than the dropped query filter.)

**ROW-gate vs store-clip distinction (confirmed):** the existing clip at
`src/lib/db.ts:3344`
(`stores: (inv.store_ids || []).filter((sid) => brandStoreIds.has(sid))`) clips
the `stores` array WITHIN a pending row — it does not decide whether the ROW
appears. My fix gates the ROW upstream, at the `pendingInvites` filter (line
3334), so a NULL-brand or foreign-brand unconsumed invite never reaches the
`.map()` that builds a pending `User`. The store-clip stays as-is (it still
correctly clips the stores of the in-brand rows that DO survive the row gate).
The two operate at different layers and are complementary; neither replaces the
other.

### Exact `fetchBrandAdmins` edit (before / after)

**Edit 1 — the `invitations` query (`src/lib/db.ts:3253-3260`).** Drop the brand
filter; update the rationale comment.

Before:
```ts
    supabase
      .from('invitations')
      // Spec 082: NO `used` filter here — email inference must source from
      // ALL brand invitations (a registered user's invite is used=true).
      // The `!used` subset is applied below, only for the pending rows.
      .select('id, email, name, role, store_ids, brand_id, used, expires_at, profile_id')
      .eq('brand_id', brandId)
      .abortSignal(signal),
```

After (drop the `.eq('brand_id', brandId)` line; comment now also explains the
spec-084 brand-filter drop and points at the re-gate):
```ts
    supabase
      .from('invitations')
      // Spec 082: NO `used` filter here — email inference must source from
      // ALL invitations (a registered user's invite is used=true); the `!used`
      // subset is applied below, only for the pending rows.
      // Spec 084: NO `.eq('brand_id', brandId)` either — a NULL-brand invitation
      // would otherwise be hidden from inference (the symmetric blind spot to
      // spec 083's fetchInvitationsForUserLookup). The per-row profile_id/name
      // match below scopes inference to the correct person; the brand scope of
      // the PENDING rows is re-applied in-memory at `pendingInvites` (strict
      // inv.brand_id === brandId) so a NULL-brand UNCONSUMED invite never leaks
      // in as a phantom pending row for a brand it doesn't belong to.
      .select('id, email, name, role, store_ids, brand_id, used, expires_at, profile_id')
      .abortSignal(signal),
```

**Edit 2 — the `pendingInvites` construction (`src/lib/db.ts:3334`).** Add the
strict brand gate alongside the existing `!used` gate.

Before:
```ts
  const pendingInvites = invites.filter((inv: any) => !inv.used);
```

After:
```ts
  // Spec 084: gate the pending ROW on the brand too. Inference (above) reads ALL
  // invites; the synthetic pending list must stay brand-scoped or a NULL-brand
  // (or foreign-brand) UNCONSUMED invite would surface as a phantom pending row.
  // Strict equality: `null === brandId` is false, so NULL-brand invites are
  // excluded from EVERY brand (there is no "no-brand" bucket in the Brands tab).
  const pendingInvites = invites.filter(
    (inv: any) => !inv.used && inv.brand_id === brandId,
  );
```

**Unchanged — email-inference map construction (`src/lib/db.ts:3297-3304`).**
Confirmed NO edit needed. The loop already iterates the full `invites` array
unconditionally and indexes by `profile_id` (winning) then `name`:

```ts
  for (const inv of invites) {
    if (inv.profile_id && inv.profile_id !== '00000000-0000-0000-0000-000000000000') {
      inviteByProfileId.set(inv.profile_id, inv);
    }
    if (inv.name) inviteByName.set(inv.name, inv);
  }
```

Once Edit 1 stops the query from dropping NULL-brand rows, those rows arrive in
`invites` and feed these maps for free — that IS the symmetric fix (AC #1). No
code change inside the loop; the comment block above it
(`src/lib/db.ts:3285-3296`) may optionally gain a one-line spec-084 note but the
logic is untouched.

> Developer note: line numbers above are spec-time references. Edit 2 shifts the
> `pendingInvites` site by however many comment lines Edit 1's expanded comment
> adds — anchor on the `const pendingInvites = invites.filter(` text, not the
> literal line number.

### Part B — `src/lib/auth.ts:468-470` comment rewrite (comment-only)

The current comment is FALSE post-083:
```ts
    // Pull invitation rows for email inference. Cleanup #16 scopes the
    // query to the current brand when brand-filtered so the table read
    // doesn't span every tenant.
    const invitations = await fetchInvitationsForUserLookup(opts?.brandId);
```

Rewrite to mirror the authoritative spec-083 wording in the `db.ts`
`fetchInvitationsForUserLookup` doc block (`src/lib/db.ts:119-134`). Proposed:
```ts
    // Pull invitation rows for email inference. Spec 083 DROPPED the brand
    // filter here: fetchInvitationsForUserLookup now reads ALL invitations
    // (the old cleanup-#16 `.eq('brand_id', …)` narrowing HID NULL-brand
    // invitations from inference — the spec-083 "(email not loaded)" bug).
    // The per-user profile_id (winning) / name match below — not a brand
    // filter — is what scopes each invitation to the correct person. The
    // `opts?.brandId` passed here is RETAINED for call-site compatibility but
    // is currently IGNORED by the helper. (Which USERS appear is still
    // brand-scoped: the profiles query above filters by brand_id.)
    const invitations = await fetchInvitationsForUserLookup(opts?.brandId);
```

This is comment-only. `fetchAllUsers` logic stays untouched — the spec is
explicit that 083 "deliberately froze `fetchAllUsers` as read-only-verify." We
keep passing `opts?.brandId` (the helper ignores it; removing the arg would be a
signature change outside this spec's surface). No behavior change in Part B.

### `src/lib/db.ts` surface

No NEW exported helper. `fetchBrandAdmins(brandId: string): Promise<User[]>` —
signature, return type, and the snake_case → camelCase mapping (the
`activeRows` / `pendingRows` `.map()`s that already produce the `User` camelCase
shape, e.g. `notificationsEnabled` ← `notifications_enabled`, `brandId` ←
`brand_id`) are all unchanged. The change is internal to the function body.

### The jest test contract — extend `src/lib/db.fetchBrandAdmins.test.ts`

Extend the existing spec-082 file (the per-table chainable-builder mock at
`makeBuilder` / `mockFrom`, lines 36-59). Critically, the mock's `eq:
jest.fn().mockReturnThis()` IGNORES its arguments, so **dropping the query's
`.eq('brand_id', brandId)` is transparent to the harness** — the test exercises
the JS-side `pendingInvites` predicate and the inference maps, which is exactly
the load-bearing logic this spec changes. No mock-infrastructure change is
required; only new `it(...)` arms and (if desired) a new `describe` block.

Add a `describe('fetchBrandAdmins — spec 084 NULL-brand inference + pending
pollution guard', …)` with these arms. `BRAND` (`'brand-1'`) and `SENTINEL` are
already defined; introduce a local `const OTHER_BRAND = 'brand-2';` for the
NULL/foreign distinction.

**Arm (e) — NULL-brand invite feeds inference (AC #1).**
- Mocks: `profilesResult` = one ACTIVE profile in `BRAND`, e.g.
  `profileRow({ id: 'p-nina', name: 'Nina', role: 'admin', brand_id: BRAND })`.
  `invitationsResult` = one invite matched by `profile_id` with
  **`brand_id: null`** and `used: true`:
  `inviteRow({ id: 'inv-nina', name: 'Nina', email: 'nina@example.com', used: true, profile_id: 'p-nina', brand_id: null })`.
- Asserts: the returned row `u.id === 'p-nina'` has
  `email === 'nina@example.com'` (NON-empty → the NULL-brand invite resolved via
  the `profile_id` map). `result` has length 1 (no phantom pending — the invite
  is `used` AND NULL-brand). `result.some(u => u.status === 'pending')` is
  `false`. This is the arm that would FAIL pre-fix (the `.eq('brand_id', BRAND)`
  query would have excluded the `brand_id: null` invite → empty email).
  *(Implementation note: because the harness `eq` ignores args, this arm only
  goes green once Edit 1's query no longer relies on the filter AND Edit 2's
  predicate excludes the NULL-brand pending — the arm pins the OBSERVABLE
  contract, which is what we want.)*

**Arm (f) — THE POLLUTION GUARD (AC #2, load-bearing).**
- Mocks: `profilesResult` = one active profile in `BRAND`
  (`profileRow({ id: 'p-ann', name: 'Ann', role: 'admin', brand_id: BRAND })`)
  so the result isn't trivially empty. `invitationsResult` = one **UNCONSUMED**
  invite with **`brand_id: null`** for a person who has NOT registered:
  `inviteRow({ id: 'inv-ghost', name: 'Ghost', email: 'ghost@example.com', used: false, profile_id: SENTINEL, brand_id: null })`.
- Asserts: `result.filter(u => u.status === 'pending')` has length **0** — the
  NULL-brand unconsumed invite produced NO pending row. Stronger assertion to
  pin the source: `result.every(u => u.id !== 'invitation:inv-ghost')` is
  `true`. (Ann still appears as the lone active row.) This is the regression the
  naive `.eq`-drop would introduce; it is the assertion that makes the guard
  load-bearing. Optional belt-and-suspenders: a second variant of this arm with
  `brand_id: OTHER_BRAND` instead of `null` asserting the SAME (a foreign-brand
  unconsumed invite also yields no pending row in `BRAND`) — proves the strict
  equality, not merely a NULL-special-case.

**Arm (g) — in-brand unconsumed invite still yields exactly one pending row
(AC #3).**
- Mocks: `profilesResult` = `{ data: [], error: null }` (or one unrelated active
  profile). `invitationsResult` = one UNCONSUMED invite whose `brand_id` EQUALS
  `BRAND`:
  `inviteRow({ id: 'inv-pat', name: 'Pat', email: 'pat@example.com', used: false, profile_id: SENTINEL, brand_id: BRAND })`.
- Asserts: `result.filter(u => u.status === 'pending')` has length **1**; that
  row's `id === 'invitation:inv-pat'` and `email === 'pat@example.com'`. Proves
  the brand gate TIGHTENS NULL/foreign without dropping legitimate in-brand
  pendings. (Mirrors existing arm (c)'s pending assertion but isolates the
  in-brand-equality case.)

**Arms (a)-(d) — regression safety (the existing spec-082 arms).** Do NOT modify
them. Re-confirm they still pass. They remain valid because:
- (a), (b), (d) use `used: true` invites whose `brand_id` defaults to `BRAND`
  (the `inviteRow` factory default) — these feed inference and produce no
  pending rows regardless of the new predicate (they're `used`).
- (c)'s pending invite `inv-zoe` has the factory-default `brand_id: BRAND` and
  `used: false`, so it now satisfies `!used && brand_id === BRAND` → still
  exactly one pending row. The new predicate does not change (c)'s outcome.
  *(This is why the `inviteRow` factory defaulting `brand_id: BRAND` is
  fortunate — the existing pending arm is in-brand by construction and survives
  the tightening. Worth a one-line code-review check that no existing arm
  relied on a pending invite with a non-`BRAND`/NULL brand; none do.)*

### Risks and tradeoffs (explicit)

- **Strict-equality predicate is the entire correctness surface.** If a developer
  writes `inv.brand_id === brandId || inv.brand_id == null` "to be safe," they
  re-introduce the exact pollution AC #2 forbids. The predicate MUST be strict
  `inv.brand_id === brandId` with no NULL escape hatch. Arm (f) pins this; the
  optional `OTHER_BRAND` variant pins that it's true equality, not a NULL
  special-case. Flagged as the #1 review check.
- **Migration-ordering risk: N/A.** No migration. Nothing to order against prod's
  `schema_migrations`.
- **RLS gap: none introduced.** Dropping a client predicate cannot widen RLS;
  see RLS impact above. The caller still only sees invitation rows the existing
  admin / super_admin policies authorize. (If a brand admin's RLS scope somehow
  let them read another brand's invitations, that would be a pre-existing policy
  bug unrelated to this change — and the pending-row gate would STILL exclude
  the foreign-brand rows from their pending list. The change is strictly
  defensive on the pending side.)
- **Performance on the 286 KB seed: negligible.** The seed has zero invitation
  rows; even at realistic scale `invitations` is low-cardinality and not a hot
  path (the function's own doc block notes this for the sibling helper). Reading
  all-invitations-the-caller-can-see instead of the brand subset adds at most a
  handful of rows in-memory. No index needed. No extra round-trip ((a) keeps the
  single read; this is the concrete win over shape (b)).
- **Edge-function cold-start: N/A.** No edge function involved.
- **Live-data relevance of the guard (per the spec's finding).** Because
  non-admin invites are created NULL-brand unguarded at `src/lib/auth.ts:294`
  (admin invites are guarded at 274-276), a NULL-brand UNCONSUMED invite can
  exist in live data today — the pollution guard protects current/future data,
  not just legacy drift. I am NOT changing the invite-creation guard (the spec
  marks "Requiring a `brand_id` on the non-admin invite-creation path" OUT of
  scope). **Open note for a future spec (not chased here):** whether the
  non-admin invite path SHOULD require `brandId` is a write-side policy question;
  if a future spec adds that guard it should keep this read-side row gate anyway
  (defense in depth — they protect different layers).
- **Comment-mirror drift (Part B).** The Part B comment is hand-mirrored from the
  `db.ts` doc block, not shared code (different file, no shared module). If the
  `fetchInvitationsForUserLookup` doc block is reworded later, this comment can
  drift — same inline-not-shared posture the codebase already accepts for the
  escapeHtml mirror. Low risk (comment-only), called out for completeness.

### Handoff
next_agent: backend-developer
prompt: Implement against the "## Backend design (architect)" section in this
  spec. Three edits, backend-only (no frontend/store change): (1)
  `src/lib/db.ts` fetchBrandAdmins — drop `.eq('brand_id', brandId)` from the
  invitations query (Edit 1) and add the strict `&& inv.brand_id === brandId`
  gate to the `pendingInvites` filter (Edit 2); leave the inference-map loop and
  store-clip untouched. (2) `src/lib/auth.ts:468-470` — comment-only rewrite per
  Part B, mirroring the db.ts fetchInvitationsForUserLookup doc block;
  fetchAllUsers logic untouched. (3) `src/lib/db.fetchBrandAdmins.test.ts` — add
  arms (e) NULL-brand invite feeds inference, (f) the pollution guard (NULL-brand
  AND optional foreign-brand unconsumed invite → zero pending rows; load-bearing,
  strict-equality), (g) in-brand unconsumed invite → exactly one pending row;
  keep arms (a)-(d) intact and passing. CRITICAL: the pending predicate is STRICT
  `inv.brand_id === brandId` — no `|| brand_id == null` escape hatch. No
  migration, no pgTAP, no edge/RLS/realtime change. Run `npx tsc --noEmit`,
  `npx tsc -p tsconfig.test.json --noEmit`, and the jest suite — all must be
  green. Then set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/084/spec.md

---

## Files changed

### src/lib (read path)
- `src/lib/db.ts` — `fetchBrandAdmins`: Edit 1 dropped `.eq('brand_id', brandId)`
  from the `invitations` query (so email inference sees ALL invitations the
  caller can read, including NULL-brand) and expanded the rationale comment;
  Edit 2 added the strict `&& inv.brand_id === brandId` gate to the
  `pendingInvites` filter (the pollution guard — NULL-brand `null === brandId`
  is `false`, so excluded from every brand) with an explaining comment. The
  inference-map loop (`inviteByProfileId`/`inviteByName`) and the store-clip on
  pending rows are untouched.
- `src/lib/auth.ts` — comment-only rewrite of the `fetchInvitationsForUserLookup`
  call site in `fetchAllUsers` (the stale "Cleanup #16 scopes the query to the
  current brand" claim), now mirroring the spec-083 `db.ts`
  `fetchInvitationsForUserLookup` doc block. No `fetchAllUsers` logic changed.

### Tests (jest)
- `src/lib/db.fetchBrandAdmins.test.ts` — added a `describe('… spec 084 …')`
  block with arms (e) NULL-brand invite feeds inference (non-empty email),
  (f) NULL-brand UNCONSUMED → zero pending rows (pollution guard), (f-bis)
  foreign-brand UNCONSUMED → zero pending rows (proves strict equality, not a
  NULL special-case), and (g) in-brand UNCONSUMED → exactly one pending row.
  Existing spec-082 arms (a)-(d) unchanged and still passing.

### Verification
- `npx jest src/lib/db.fetchBrandAdmins` — 9/9 green (5 existing + 4 new).
- `npx jest` (full) — 44 suites / 410 tests green (was 406; +4 new arms).
- `npx tsc --noEmit` (base) — exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` (test graph) — exit 0.

No migration, no pgTAP, no edge/RLS/realtime, no store/frontend change.
