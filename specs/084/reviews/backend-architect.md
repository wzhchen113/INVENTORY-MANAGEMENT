# Spec 084 — Architectural drift review (backend-architect, post-impl)

**Verdict: MATCHES DESIGN — no drift.**

Reviewed READ-ONLY against the "## Backend design (architect)" section of
`specs/084/spec.md`. All five load-bearing decisions landed as designed. Zero
Critical, zero Should-fix, zero Minor findings. One positive deviation
(developer added the optional strict-equality variant arm I had flagged as
"optional belt-and-suspenders") — acceptable, strengthens the guard.

---

## Decision-by-decision verification

### 1. Shape (a) — drop-and-re-gate — MATCHES (this was my #1 flagged risk)

**Edit 1 (query) — landed.** `src/lib/db.ts:3253-3266`: the `invitations`
`PostgrestBuilder` chain is now `.from('invitations')` → comment block →
`.select('id, email, name, role, store_ids, brand_id, used, expires_at, profile_id')`
→ `.abortSignal(signal)`. The `.eq('brand_id', brandId)` line is **GONE**. The
rationale comment was expanded with a Spec 084 block that explains the drop and
points forward at the in-memory re-gate — exactly the "after" shape in the
design (§ "Exact `fetchBrandAdmins` edit").

**Edit 2 (pending re-gate) — landed, STRICT, no null escape hatch.**
`src/lib/db.ts:3345-3347`:

```ts
const pendingInvites = invites.filter(
  (inv: any) => !inv.used && inv.brand_id === brandId,
);
```

This is the exact predicate the design mandated: strict `===`, conjoined with
`!inv.used`. **There is NO `|| inv.brand_id == null` and NO `?? ` relaxation** —
the entire pollution guard rests on `null === brandId` evaluating to `false`,
and it does. This was the #1 review check called out in the design's "Risks and
tradeoffs" ("If a developer writes `inv.brand_id === brandId || inv.brand_id ==
null` 'to be safe,' they re-introduce the exact pollution AC #2 forbids"). The
developer did NOT take that bait. The `brandId` non-empty precondition still
holds upstream (`if (!brandId) return [];` at db.ts:3243), so `brandId` is a
non-empty string at the predicate and the strict-equality reasoning is sound:
- NULL-brand invite → `null === brandId` → `false` → excluded from EVERY brand
  (AC #2, the pollution guard).
- in-brand invite → `true` → retained (AC #3).
- foreign-brand invite → `false` → excluded (now via the JS predicate rather
  than the dropped query filter; behavior preserved).

**The pending predicate exactly matches the design intent.** No drift on the
single most load-bearing line in the spec.

### 2. Inference maps unchanged — MATCHES

`src/lib/db.ts:3303-3310` (the `inviteByProfileId` / `inviteByName` loop) is
byte-identical to the design's "Unchanged — email-inference map construction"
snippet: it iterates the full `invites` array unconditionally, sets
`inviteByProfileId` for non-sentinel `profile_id`, and `inviteByName` for any
`inv.name`. No edit inside the loop. The preceding comment block
(db.ts:3291-3302) gained Spec-082-era context but the logic is untouched — and
the design explicitly permitted an optional comment note here ("the comment
block above it may optionally gain a one-line spec-084 note but the logic is
untouched"). The symmetric fix (AC #1) is achieved purely by Edit 1 letting the
NULL-brand rows arrive in `invites`; the maps then index them for free, exactly
as designed.

The store-clip on pending rows (db.ts:3357,
`(inv.store_ids || []).filter((sid) => brandStoreIds.has(sid))`) is also
untouched, preserving the ROW-gate-vs-store-clip layering the design called out
as complementary.

### 3. Part B comment — MATCHES

`src/lib/auth.ts:468-477` was rewritten comment-only. The stale "Cleanup #16
scopes the query to the current brand" claim is gone. The new wording mirrors
the authoritative spec-083 `fetchInvitationsForUserLookup` doc block
(`src/lib/db.ts:119-134`): it states spec 083 DROPPED the brand filter, that the
helper now reads ALL invitations, that the per-user profile_id (winning) / name
match is what scopes inference, that `opts?.brandId` is RETAINED for call-site
compatibility but IGNORED, and that which USERS appear is still brand-scoped via
the profiles query. The call line
`const invitations = await fetchInvitationsForUserLookup(opts?.brandId);`
(auth.ts:477) is unchanged — `opts?.brandId` is still passed, no signature
change. `fetchAllUsers` logic is untouched, matching the design's "spec is
explicit that 083 'deliberately froze fetchAllUsers as read-only-verify.'"
Acceptance criterion (Part B comment correctness) satisfied.

### 4. Scope containment — MATCHES (clean)

- **No migration.** `supabase/migrations/` tail is unchanged:
  `20260530000000_record_missed_orders_rpc.sql`,
  `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082, original
  date), `20260531010000_invitations_brand_id_backfill.sql` (spec 083). No
  `20260531020000`-or-later spec-084 migration exists. Confirmed via glob.
- **`fetchInvitationsForUserLookup` NOT re-touched.** Body at db.ts:136-146 is
  intact (still `.select('email, profile_id, name, brand_id').abortSignal()`
  with no `.eq`). Out-of-scope item respected.
- **`consume_invitation` migration NOT re-touched.** `20260531000000_…` retains
  its original date and is not restaged. Out-of-scope item respected.
- **Spec-083 backfill migration NOT re-touched.** `20260531010000_…` content is
  fully intact (read end-to-end; both UPDATE statements + the post-backfill
  invariant present and unchanged). Out-of-scope item respected.
- **No pgTAP, no edge function, no RLS, no realtime, no store/frontend change.**
  Grep for `Spec 084` / `spec 084` across `src/` returns ONLY the three intended
  files (`db.ts`, `db.fetchBrandAdmins.test.ts`); across `supabase/` returns
  only `seed.sql`, whose `084` hits are incidental substrings inside UUIDs and
  numeric data values (e.g. `...b084...`, `40841519...`) — NOT a spec-084
  change. `fetchBrandAdmins`'s `(brandId: string): Promise<User[]>` signature
  and return shape are unchanged, so `loadBrandAdmins` (useStore.ts:721) and
  `BrandsSection` consume it unaltered — matching the "Frontend / store impact:
  NONE" design line. The `docker restart supabase_realtime_imr-inventory`
  publication gotcha does NOT apply (no migration, no publication membership
  change) — correctly absent.

The implementation touched exactly the three files the design named, nothing
more.

### 5. jest arms — MATCHES (with one positive addition)

`src/lib/db.fetchBrandAdmins.test.ts`:
- **(a)-(d) preserved verbatim** (lines 102-213) inside the original
  `describe('… spec 082 email inference')` block — not modified. Regression
  safety (AC, spec-082 behavior) intact. The `inviteRow` factory still defaults
  `brand_id: BRAND`, so (c)'s in-brand pending invite still satisfies the new
  `!used && brand_id === BRAND` predicate → still exactly one pending row. The
  design's "one-line code-review check that no existing arm relied on a pending
  invite with a non-`BRAND`/NULL brand" — confirmed: none do.
- **(e)** (db.test:234-251) — NULL-brand invite matched by `profile_id` →
  non-empty email, length 1, no pending row. Matches the design's Arm (e) (AC
  #1, the symmetric fix).
- **(f)** (db.test:258-276) — NULL-brand UNCONSUMED invite → zero pending rows,
  `result.every(u => u.id !== 'invitation:inv-ghost')`, Ann the lone active row.
  Matches the design's Arm (f), the load-bearing pollution guard (AC #2).
- **(f-bis)** (db.test:280-297) — foreign-brand (`OTHER_BRAND`) UNCONSUMED
  invite → zero pending rows. This is the design's explicitly-OPTIONAL
  "belt-and-suspenders … proves the strict equality, not merely a
  NULL-special-case" variant. The developer ADDED it. **Positive deviation, not
  drift** — it pins the strict-equality property the design flagged as the #1
  risk, exactly as suggested.
- **(g)** (db.test:302-315) — in-brand UNCONSUMED invite → exactly one pending
  row (`invitation:inv-pat`). Matches the design's Arm (g) (AC #3).

The new arms live in a separate `describe('… spec 084 …')` block (db.test:226)
with the local `const OTHER_BRAND = 'brand-2';` the design specified, and a
harness note that `makeBuilder`'s `eq` ignores args (so the query-filter drop is
transparent to the mock and the arms exercise the JS-side predicate + maps) —
exactly the test-contract reasoning in the design ("The jest test contract").

Developer-reported verification (spec § Verification): `npx jest
src/lib/db.fetchBrandAdmins` 9/9 green (5 existing + 4 new), full jest 410
tests green, both `tsc` typechecks exit 0. Consistent with the arm count I
designed (4 new arms: e/f/f-bis/g). I did not re-run the suite (read-only
review); the static shape of the arms is correct and the assertions pin the
ACs.

---

## Findings ledger

| Severity   | Count | Notes |
|------------|-------|-------|
| Critical   | 0     | — |
| Should-fix | 0     | — |
| Minor      | 0     | — |

No findings. One acceptable judgment-call deviation (the (f-bis) foreign-brand
arm) is a STRENGTHENING of the design's optional suggestion, not a divergence.

---

## Summary

The implementation matches the spec-084 backend design with zero drift. The #1
flagged risk — that the `pendingInvites` re-gate must be STRICT
`inv.brand_id === brandId` with no `|| == null` escape hatch — landed exactly as
designed at `src/lib/db.ts:3345-3347`; the entire pollution guard correctly
rests on `null === brandId` being false, and AC #2 (NULL-brand unconsumed invite
yields no pending row in any brand) holds. Edit 1's query-filter drop landed,
the inference-map loop and store-clip are untouched, the symmetric inference fix
(AC #1) is achieved for free, the Part B comment is a faithful comment-only
mirror of the spec-083 doc block with `fetchAllUsers` logic frozen, and scope is
clean: only the three intended TS files changed, with no migration / pgTAP /
edge / RLS / realtime / store / frontend ride-along, and
`fetchInvitationsForUserLookup` / `consume_invitation` / the spec-083 migration
all left untouched. The jest arms (e/f/f-bis/g) pin the OBSERVABLE contract and
preserve (a)-(d); the developer's addition of the optional (f-bis)
foreign-brand strict-equality variant is a positive, not drift. Verdict:
MATCHES DESIGN.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity (0 Critical,
  0 Should-fix, 0 Minor). Implementation matches the spec-084 backend design
  with no drift; the load-bearing strict-equality pending-row re-gate landed
  exactly as designed with no NULL escape hatch. One acceptable positive
  deviation (developer added the optional (f-bis) foreign-brand strict-equality
  jest arm).
payload_paths:
  - specs/084/reviews/backend-architect.md
