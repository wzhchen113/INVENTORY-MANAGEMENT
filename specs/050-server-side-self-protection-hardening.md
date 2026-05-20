# Spec 050: Server-side self-protection hardening (demote + delete-user)

Status: READY_FOR_REVIEW

## User story

As the engineer who designed the role model, I want destructive
role-change and deletion operations to enforce `caller.id != target.id`
on the **server** (Postgres / edge function), not the UI, so that a
logged-in user cannot demote themselves to `user` (and null their own
`brand_id`) by hitting the PostgREST UPDATE directly, and cannot delete
their own profile by POSTing to `delete-user` with a forged body —
even if a future UI regression accidentally exposes the affordance.

Symmetrically, as a super-admin operating the Brands → Members tab, I
want the existing UI guard ("(you)" inline label, no Demote/Delete
buttons) to remain visible, but I want the **server** to be the
authoritative gate so future UI refactors cannot quietly re-open the
hole. This spec extends the spec 031 last-of-role pattern to cover
**self-action** as a sibling invariant: spec 031 protects against
"last super_admin / master gone"; this spec protects against "caller
acted on themselves."

### Foot-gun being closed

1. **Spec 012c security-auditor W2.** `demoteProfileToUser` at
   [src/lib/db.ts:2757](src/lib/db.ts) is a direct PostgREST UPDATE
   (`profiles.update({ role: 'user', brand_id: null }).eq('id', profileId)`),
   not a SECURITY DEFINER RPC. The base RLS policy for `profiles`
   includes an "Own profile" UPDATE policy (so a user can change their
   own `dark_mode` preference etc.). A logged-in user calling this
   UPDATE path with their own `profileId` will succeed — the RLS
   policy permits the own-row write, and the helper happily sets
   `role='user', brand_id=null`. There is no server-side
   `caller.id != target.id` check.
2. **Spec 012c test-engineer §3 / security-auditor W3 caveat.** The
   `delete-user` edge function has `auth.uid() != target.id` enforced
   for self-delete (line 168–173, returns HTTP 400 `"cannot delete
   self"`). But the **demote** path has no equivalent — a self-demote
   POST goes through directly via `src/lib/db.ts:2757`. The UI guard
   in `MembersTab.canActOn` excludes `isSelf` (BrandsSection
   line 860–865), but UI guards are never load-bearing — a different
   UI section, a directly-hit PostgREST URL, or a tools-tab
   experiment can reach the UPDATE.
3. **Recovery from a self-demote-then-locked-out state** requires a
   superadmin (or direct psql) to re-promote — exactly the
   "recover-by-psql-only" state the spec 031 guard set out to
   avoid. Closing this is the cheapest way to bring `demoteProfileToUser`
   up to the standard the rest of the destructive-action paths
   already meet.

## Acceptance criteria

### A. Server-side `caller.id != target.id` for `demoteProfileToUser`

- [ ] The `demoteProfileToUser` code path refuses to demote the
      caller's own profile when invoked with `target_id == caller_id`.
      The refusal happens server-side (either in a SECURITY DEFINER
      RPC or in an edge function — architect picks per open question
      Q1).
- [ ] The refusal returns a stable, exact-match error string:
      `'cannot demote self'`. The string is assertable from pgTAP /
      smoke / any future jest.
- [ ] The refusal fires **before** any UPDATE side-effect — the
      `profiles` row remains unchanged on a refused self-demote.
- [ ] No UI behavior changes on the happy path (non-self demote): the
      MembersTab "DEMOTE" button continues to optimistically flip
      cached role + clear `brand_id` and re-fetch the affected brand's
      admin list per the existing useStore action at
      [src/store/useStore.ts:863-895](src/store/useStore.ts).
- [ ] If the architect picks Q1 = "SECURITY DEFINER RPC": the existing
      `demoteProfileToUser` PostgREST UPDATE at
      [src/lib/db.ts:2757-2766](src/lib/db.ts) is replaced with
      `supabase.rpc('demote_profile_to_user', { target_user_id })`. The
      RPC reads `auth.uid()` internally as the caller; no `caller_id`
      argument is passed from the client (defense against forgery).
- [ ] If the architect picks Q1 = "edge function": the existing
      `demoteProfileToUser` client helper continues to call a function
      (new `/demote-profile-to-user`), and the function gates on
      `auth.uid() != userId` the same way `delete-user` does at
      [supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts).
- [ ] The chosen path is documented in CLAUDE.md under "Conventions
      already in use" — strictly additive, no existing bullet
      reworded.

### B. Server-side self-delete guard for `delete-user` — verify-and-tighten

- [ ] Verify the existing self-delete refusal at
      [supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts)
      is the FIRST gate in the destructive sequence (i.e. fires
      BEFORE the brand-match gate, the last-of-role guard, and any
      `from(...).delete()` call). If yes, this AC is satisfied by
      the existing code.
- [ ] If the verification shows the self-delete check is NOT first
      (e.g. some future refactor moved it), restore it as the first
      gate after `requireAdminCaller` returns 200.
- [ ] The refusal string stays exactly `'cannot delete self'`
      (byte-for-byte; smoke Arm 6 of spec 031 already asserts on
      either `'cannot delete self'` or `'cannot delete the last
      super_admin'`).
- [ ] The pgTAP test for the new demote guard (see C below) also
      cross-references the delete-user self-guard with a single
      comment-block in the file header, so a future reviewer who
      finds one is reminded the other exists.

### C. pgTAP regression test for self-demote refusal

- [ ] New file `supabase/tests/demote_self_guard.test.sql` lands
      alongside the existing pgTAP files in
      [supabase/tests/](supabase/tests/). File count goes from
      current → current + 1 (the architect verifies the current count
      and updates the AC; spec 031 went 14 → 15; spec 043 and others
      have landed since).
- [ ] Hermetic `begin; ... rollback;` shape, mirroring
      [supabase/tests/delete_last_privileged_guard.test.sql](supabase/tests/delete_last_privileged_guard.test.sql).
- [ ] Test mechanism depends on Q1:
        - **Q1 = RPC:** the test sets `request.jwt.claims` to make
          `auth.uid()` return the seed master's id, then `throws_ok`
          on `select public.demote_profile_to_user(<seed_master_id>)`
          with SQLSTATE `P0001` and message `'cannot demote self'`.
          A second arm sets a DIFFERENT `auth.uid()` and `lives_ok`
          on the same call (happy-path: non-self demote succeeds).
        - **Q1 = edge function:** the pgTAP file does not cover the
          self-check (that lives in TypeScript). Instead, a SMOKE arm
          (see D) is the regression detector, and the pgTAP file
          covers only the demote happy-path RPC (if Q3 chose to
          keep the demote logic in SQL) or is omitted entirely (if
          the demote stays a pure PostgREST UPDATE + the
          self-check is in the edge function).
- [ ] `npm run test:db` reports +1/+1 vs. pre-spec count.

### D. Smoke test arm for self-demote refusal

- [ ] `scripts/smoke-edge-roles.sh` gains an Arm appended after the
      existing Arms. The arm number is whatever comes next at landing
      time (spec 031 added Arm 6; later specs may have added more).
- [ ] The arm reuses the existing admin login machinery (admin@local.test).
      It does NOT depend on Arm 4's super_admin promotion — the
      self-demote is meaningful at any admin role (admin, master,
      super_admin).
- [ ] Sequence:
        1. Login admin@local.test → bearer.
        2. Resolve admin uid via `docker exec psql` (matching the
           Arm 6 pattern from spec 031 §11).
        3. Invoke the demote path with the admin's own uid as target:
             - Q1 = RPC: `POST ${SUPABASE_URL}/rest/v1/rpc/demote_profile_to_user`
               with body `{"target_user_id":"<admin_uid>"}` and the
               admin's bearer.
             - Q1 = edge function: `POST ${SUPABASE_URL}/functions/v1/demote-profile-to-user`
               with body `{"userId":"<admin_uid>"}` and the admin's
               bearer.
        4. Assert HTTP 400 AND body matches the stable string
           `cannot demote self`.
        5. Re-query the admin's row in `profiles` and confirm
           `role` is unchanged (still `admin`) and `brand_id` is
           unchanged (still set to whatever it was pre-test).
- [ ] Arm inherits the existing refuse-non-local guard at
      `scripts/smoke-edge-roles.sh` lines 53-60. No new check.
- [ ] `npm run test:smoke` passes with the new arm.

### E. Backward compatibility / call-site sweep

- [ ] Q3 = "wrap" (keep `demoteProfileToUser` client helper, swap
      implementation): no call site changes outside `src/lib/db.ts`.
      The store action at
      [src/store/useStore.ts:863-895](src/store/useStore.ts) and the
      BrandsSection MembersTab caller at
      [src/screens/cmd/sections/BrandsSection.tsx:847-855](src/screens/cmd/sections/BrandsSection.tsx)
      remain untouched.
- [ ] Q3 = "hard-delete the direct UPDATE": the direct PostgREST
      UPDATE at `src/lib/db.ts:2757` is removed; the new RPC / edge
      function call replaces it. Same callers, same outer signature
      (`async (profileId: string): Promise<string>`).
- [ ] No new `useStore` slice, no new toast surface — the existing
      optimistic-then-revert pattern handles the new refusal via
      `notifyBackendError` (the toast surface for the
      `'cannot demote self'` string is automatic, same as it is for
      `'cannot delete the last super_admin'` today per spec 032).

### F. Convention doc additions (strictly additive)

- [ ] `CLAUDE.md` gains a new bullet under "Conventions already in
      use" capturing the self-action rule. Exact wording is the
      architect's call but substance must be: destructive role-change
      / deletion paths enforce `caller.id != target.id` server-side,
      with a stable refusal string. Reference spec 050. If the
      architect picks the RPC path, the bullet names the RPC; if
      edge function, the bullet names the function.
- [ ] `.claude/agents/security-auditor.md` gains a matching reminder
      bullet in the audit-rule list, parallel to the spec 031
      last-of-role audit bullet. Substance: when reviewing destructive
      role-change or deletion paths, verify a server-side
      `caller.id != target.id` guard exists. Cross-reference spec 050.
- [ ] Both additions are STRICTLY ADDITIVE. No existing bullet
      reworded or reordered.

### G. Cross-cutting verification gates

- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run typecheck:test` exits 0.
- [ ] `npm test -- --ci` PASS. No existing tests broken.
- [ ] `npm run test:db` PASS — file count +1 if Q1 = RPC.
- [ ] `npm run test:smoke` PASS — new arm appended.
- [ ] Manual: log in as the seed admin, open Brands → Members on
      the admin's own brand, verify the "(you)" inline label is
      still rendered on the admin's row (no DELETE / DEMOTE buttons
      visible). Attempt the demote via direct
      RPC / edge function call (curl) and confirm HTTP 400 with
      the structured error.

## In scope

- Wrap or replace the direct PostgREST UPDATE in `demoteProfileToUser`
  with a server-authoritative path (SECURITY DEFINER RPC OR new edge
  function — Q1 decides). The path enforces
  `caller.id != target.id` server-side.
- Verify (and tighten if needed) the existing `delete-user`
  self-delete check at
  [supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts).
- Add pgTAP regression test for self-demote refusal (if Q1 = RPC).
- Add smoke arm for self-demote refusal.
- Strictly-additive convention bullets in `CLAUDE.md` and
  `.claude/agents/security-auditor.md`.

## Out of scope (explicitly)

- **Self-promotion guard (caller promotes themselves to a higher
  role).** Spec 012c §5 architect note already restricts role
  promotion to a super-admin caller via UI; promotion goes through a
  different code path (`invitePromoteAdmin` / role-edit picker, not
  `demoteProfileToUser`). Self-promotion is a separate guard
  shape and a separate spec. Listed here so future specs don't
  silently inherit "spec 050 covers all self-action" — it covers
  destructive self-action only.
- **Block demoting a `super_admin` caller via UI even when not the
  last (Q2 below).** The spec leaves this as an open question for
  the user to decide. If the user wants it folded in, the AC list
  expands; default is "no — `caller.id != target.id` is sufficient,
  the last-of-role guard from spec 031 already covers the
  catastrophic case."
- **Generalizing the guard to a shared SQL helper called by ALL
  destructive paths (e.g. `assert_not_self(target_user_id)`).** The
  symmetric shape with `assert_not_last_of_role` is attractive, but
  whether to extract is the architect's call — the spec accepts
  either inline per-RPC checks or a shared helper.
- **Touching the `delete-user` edge function's non-self gates**
  (brand-match gate from spec 043, last-of-role guard from spec
  031). Those are working as designed.
- **Adding a server-side self-protect to OTHER mutation paths.**
  For example: `updateProfile` (role / brand_id edit picker) may
  also benefit from a self-block on the role column, but that is a
  separate code path and a separate spec. This spec is scoped to
  `demoteProfileToUser` and `delete-user`.
- **Adding tests retroactively for other historic destructive
  paths.** Test-engineer §3 of 012c flagged this as a broader gap;
  it's a follow-up.
- **`useStore.test.ts` jest harness.** Spec 029's deferred
  follow-up remains its own spec.
- **Touching `useRole()` placeholder.** Per CLAUDE.md, intentional.
- **Touching the `app.json` `slug`.** Per CLAUDE.md, do not change.

## Open questions — RESOLVED (2026-05-20)

User accepted all PM-recommended defaults in a single batch:

- **Q1 → Path A (SECURITY DEFINER RPC).** `public.demote_profile_to_user(target_user_id uuid)` migration + `supabase.rpc(...)` call site. No new edge function.
- **Q2 → Strictly self.** Refuse only when `caller.id == target.id`. Role-hierarchy gate (super_admin can-demote-super_admin) is explicitly out of scope.
- **Q3 → Wrap.** `demoteProfileToUser` keeps its name and signature in `src/lib/db.ts`; body swaps to the RPC.
- **Q4 → Both pgTAP + smoke.** With Q1 = Path A, pgTAP is the load-bearing regression home; smoke is defense-in-depth.
- **Q5 → `'cannot demote self'`.** Lower-case, no punctuation, parallel to spec 031's `'cannot delete self'`.

The rest of this section preserves the original deliberation (Path A/B trade-offs, etc.) for the architect's reference; treat the resolutions above as the final word.

---

## Open questions (original deliberation — superseded by resolutions above)

- **Q1: SECURITY DEFINER RPC vs. new edge function for the demote
  wrap.** Spec 031 went the hybrid route (SQL helper called via RPC
  from an edge function) because the destructive op itself
  (`auth.admin.deleteUser`) requires the service-role client — only
  reachable from an edge function. For `demoteProfileToUser` the
  destructive op is a `profiles` UPDATE, which a SECURITY DEFINER
  function CAN perform directly. Choices:
    - **Path A: SECURITY DEFINER RPC** (`public.demote_profile_to_user(target_user_id uuid)`)
      called from the client via
      `supabase.rpc('demote_profile_to_user', { target_user_id })`. The
      function reads `auth.uid()` internally as the caller, refuses
      if `target_user_id = auth.uid()`, otherwise UPDATEs `profiles`
      with `role='user', brand_id=null`.
      - Pros: simpler (no new edge function, no `verify_jwt`
        config, no service-role client). Same shape as
        `assert_not_last_of_role`. Single source of truth in SQL
        (pgTAP can call it directly). No `_shared/` drift surface
        (spec 027 §4.2 lesson does NOT apply — SQL is deployed
        atomically).
      - Cons: RPCs go through PostgREST, which means the call site
        in the client is `supabase.rpc(...)` not the standard
        `callEdgeFunction` envelope (spec 032). Error surfacing
        works fine (`PostgrestError` → `notifyBackendError`) but is
        a different code path from the existing edge-function
        envelope. Slightly less symmetric with the other destructive
        paths (`delete-user`, `delete-brand`, etc.).
    - **Path B: new edge function `/demote-profile-to-user`** with
      the same `requireAdminCaller` + `userId != gate.userId` shape
      as `delete-user`. The edge function then does the profile
      UPDATE using the service-role client.
      - Pros: byte-for-byte parity with `delete-user`. Same
        `callEdgeFunction` envelope on the client (spec 032 surface).
        Same `ADMIN_ROLES = Set("admin", "master", "super_admin")`
        gate. Same CORS shape.
      - Cons: an entire new edge function for what is a single
        UPDATE. Adds another item to `supabase/config.toml`,
        another `supabase functions deploy` step on release. Spec
        031's hybrid was driven by `auth.admin.deleteUser`
        requiring service-role; there is no equivalent here.
    - **Recommended default (PM):** Path A. The "auth.uid() inside
      a SECURITY DEFINER function" pattern is what
      `assert_not_last_of_role` would have used if the destructive
      op were a SQL DELETE rather than `auth.admin.deleteUser`. The
      symmetry is strong; the cost is one new migration and one
      RPC call-site swap in `src/lib/db.ts`.

- **Q2: Scope of self-protection — strictly `caller.id != target.id`,
  or also block demoting/deleting `super_admin` callers via UI
  even when not the last?**
    - **Strictly self (default):** The new server-side check refuses
      ONLY when `caller.id == target.id`. The last-of-role guard
      from spec 031 already covers "last super_admin" globally. A
      super_admin demoting ANOTHER super_admin (when there are
      multiple) is permitted by both guards.
    - **Self + super_admin via UI:** Additionally refuse if the
      target's role is `super_admin` and the caller's role is not
      `super_admin` (only super_admins can demote super_admins).
      This is a *different* shape — it's a role-hierarchy gate, not
      a self-protection gate. Probably belongs in a separate spec
      ("role-hierarchy mutation guard").
    - **Recommended default (PM):** Strictly self. Q2 = "self only";
      role-hierarchy is a separate spec.

- **Q3: Backward compat for `demoteProfileToUser` — wrap (keep the
  client function name) or hard-delete (remove and replace
  call-sites)?**
    - **Wrap (recommended):** `demoteProfileToUser` stays in
      `src/lib/db.ts` with the same signature
      `(profileId: string) => Promise<string>`. Its body changes
      from the direct PostgREST UPDATE to a `supabase.rpc(...)` (Q1
      = Path A) or `callEdgeFunction(...)` (Q1 = Path B) call. The
      store action and BrandsSection caller are untouched.
    - **Hard-delete:** `demoteProfileToUser` is removed from
      `src/lib/db.ts`. Call sites in the store
      ([src/store/useStore.ts:875](src/store/useStore.ts)) and
      BrandsSection
      ([src/screens/cmd/sections/BrandsSection.tsx:852](src/screens/cmd/sections/BrandsSection.tsx))
      now call `supabase.rpc(...)` directly. The architect's note in
      the original demote helper ("Future spec should wrap as
      SECURITY DEFINER" — `src/lib/db.ts:2747-2756`) suggests wrap
      was the intent.
    - **Recommended default (PM):** Wrap. Minimal blast radius;
      preserves the abstraction; keeps the test-engineer's snapshot
      of the destructive surface stable.

- **Q4: pgTAP-vs-smoke load-bearing test.** If Q1 = Path A (RPC),
  the pgTAP path is the natural regression home (calls the same
  function the client calls via RPC, same `auth.uid()` mechanism).
  If Q1 = Path B (edge function), pgTAP cannot directly exercise
  the edge function — only smoke can. Choice:
    - **Q1 = Path A:** pgTAP is load-bearing, smoke is
      defense-in-depth.
    - **Q1 = Path B:** smoke is load-bearing, pgTAP optional (only
      the underlying UPDATE policy still has pgTAP coverage from
      spec 043).
    - **Recommended default (PM):** Tied to Q1. No separate
      decision needed.

- **Q5: Stable refusal string — `'cannot demote self'` is the PM
  default. Is that the preferred wording?**
    - Spec 031 used `'cannot delete the last super_admin'` /
      `'cannot delete the last master'` and `'cannot delete self'`
      (existing). The parallel construction is
      `'cannot demote self'`. Alternatives: `'cannot demote
      yourself'`, `'self-demote refused'`, `'demote: cannot target
      self'`. All are byte-for-byte stable; the smoke / pgTAP /
      future jest just need to match exactly whichever is picked.
    - **Recommended default (PM):** `'cannot demote self'`.
      Parallel to `'cannot delete self'`. Lower-case, no
      punctuation. Reviewers / scripts can grep for either.

## Dependencies

- **Q1 = Path A (recommended):**
  - New migration adding the
    `public.demote_profile_to_user(target_user_id uuid)` function.
    `security definer`, `set search_path = public, auth`, reads
    `auth.uid()` internally, refuses if `target_user_id =
    auth.uid()` with SQLSTATE `P0001` message `'cannot demote
    self'`, otherwise UPDATEs `profiles`.
  - `GRANT EXECUTE` to `authenticated` (NOT `anon` — no realistic
    caller path).
  - `src/lib/db.ts:2757-2766` body swap (PostgREST UPDATE →
    `supabase.rpc(...)`).
- **Q1 = Path B:**
  - New edge function `supabase/functions/demote-profile-to-user/index.ts`
    mirroring the shape of `supabase/functions/delete-user/index.ts`
    (minus `auth.admin.deleteUser`; the destructive op is a
    `profiles` UPDATE via service-role client).
  - New entry in `supabase/config.toml` for the function.
  - `src/lib/db.ts:2757-2766` body swap (direct UPDATE →
    `callEdgeFunction(...)`).
  - New `supabase functions deploy demote-profile-to-user` step
    on release.
- **No new packages.**
- **No realtime publication change.** `profiles` is already covered
  by the existing publication; the demote UPDATE already triggers
  realtime today.
- **Spec 031 last-of-role guard is untouched.** This spec is
  strictly additive to the destructive-action stack.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only — the only caller of
  `demoteProfileToUser` is
  [src/screens/cmd/sections/BrandsSection.tsx:847-855](src/screens/cmd/sections/BrandsSection.tsx)
  (MembersTab's Demote button). No legacy admin surface; spec 025
  already deleted it.
- **Per-store or admin-global:** Admin-global. `demoteProfileToUser`
  edits a `profiles` row regardless of store. The new self-check is
  a global predicate (`caller.id != target.id`); no store scoping
  involved.
- **Realtime channels touched:** None new. `profiles` UPDATE
  already flows through the existing realtime publication (the
  store's `loadBrandAdmins` re-fetch is the source of truth for
  the members-tab view; realtime is just a hint).
- **Migrations needed:** Q1 = Path A → yes (one new SQL function,
  `CREATE OR REPLACE`). Q1 = Path B → no migration; only an edge
  function add.
- **Edge functions touched:** Q1 = Path A → none. Q1 = Path B →
  new function `demote-profile-to-user`. Either path: `delete-user`
  is **read-only verified**, not modified (AC B).
- **Web/native scope:** Both. The MembersTab UI is pure React Native
  + react-native-web. No web-only or native-only API.
- **Test track:** pgTAP (DB tests) + shell smoke. Per spec 022's
  three-track convention. If Q1 = Path B, pgTAP track may be empty
  for this spec; if Q1 = Path A, pgTAP is load-bearing.
- **`app.json` slug:** Not touched.
- **Post-merge deploy step:**
    - Q1 = Path A: `supabase db push` to apply the new function
      migration. No edge-function deploy needed.
    - Q1 = Path B: `supabase db push` (no-op if no migration) +
      `supabase functions deploy demote-profile-to-user`. New
      function entry in `supabase/config.toml`.
- **`callEdgeFunction` standard envelope (spec 032):** Q1 = Path B
  must use `callEdgeFunction` (`src/lib/auth.ts:109`), not raw
  `fetch`. Q1 = Path A goes through `supabase.rpc(...)` which has
  its own `PostgrestError` shape; `notifyBackendError` already
  handles both shapes per the existing store conventions.
- **CLAUDE.md "Edge function role gates" parity:** Q1 = Path B
  must define
  `const ADMIN_ROLES = new Set(["admin", "master", "super_admin"]);`
  inline and use `requireAdminCaller()` matching the
  `delete-user` shape. Q1 = Path A's RPC enforces role via the
  existing `super_admin_manage_profiles` UPDATE policy (which is
  already in place per spec 012a); no new ADMIN_ROLES Set needed.

## Drift / convention risks the architect should review

- **Spec 027 inline-not-shared lesson** applies to Q1 = Path B
  (new edge function) — keep `ADMIN_ROLES` inline, do not
  share via `_shared/`. Same as spec 031, spec 028.
- **Spec 032 callEdgeFunction envelope** applies to Q1 = Path B —
  the client must call via `callEdgeFunction`, not raw `fetch`,
  so the HTTP 400 refusal surfaces as a string `error` for
  `notifyBackendError` to toast.
- **Spec 031 last-of-role parallel** — the self-protection guard
  is a sibling invariant to the last-of-role guard. The
  convention bullet (AC F) should explicitly name both as members
  of the same destructive-action discipline. A future role-edit
  picker spec (e.g. role-hierarchy guard) should extend the
  convention bullet rather than start a new one.
- **Spec 043 brand-match gate** in `delete-user` is upstream of
  the last-of-role guard, which is upstream of the self-delete
  check. The ordering convention is "fail-cheapest-first":
  authn → role gate → brand-match → last-of-role → self. This
  spec preserves that ordering (self-delete check stays where it
  is — AC B is verify-only).

## Risks and tradeoffs

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Migration applied after client deploy (Q1 = Path A). Client calls `rpc('demote_profile_to_user')` before the function exists in prod. | Low | Function returns HTTP 404 / "function does not exist" fail-closed. No data loss. Release notes call out the order: migration first, client deploy second. |
| User somehow bypasses the new RPC and hits the direct PostgREST UPDATE (Q3 = wrap, the UPDATE row in `db.ts` is removed; Q3 = hard-delete, ditto). | Low | The PostgREST UPDATE path is replaced, not co-existent. After this spec, the only client-side caller is the wrapped function. RLS policies remain in place as a baseline. |
| `auth.uid()` is `null` inside the RPC (e.g. service-role calls). | Low | `security definer` does NOT mean `auth.uid()` returns null — `auth.uid()` is sourced from the caller's JWT, not the function owner's. Service-role calls would have `auth.uid() = null` but RPCs from `service_role` don't typically pass through PostgREST's user JWT pipeline. The function defensively raises `'cannot demote self'` if `auth.uid()` is null AND `target_user_id` is null — but realistically the RPC is only callable from authenticated client sessions. Document explicitly in the function comment. |
| Smoke arm assumes admin@local.test is the seed admin and has a brand assigned. | Low | The seed admin always has a brand (spec 012a seed). If the admin's `brand_id` is null for some reason, the smoke arm's "confirm role unchanged" check still works — it only asserts non-mutation, not a specific brand_id. |
| Future role addition (e.g. `billing_admin`) wants its own self-demote semantics. | Manageable | The new function's self-check is role-agnostic (`auth.uid() = target_user_id` regardless of either party's role). A future role would inherit the same protection without changes. |
| TOCTOU between `auth.uid()` read and the UPDATE. | Negligible | Both happen inside the same plpgsql function invocation, atomic w.r.t. the row. No race window. |
| Performance: one new RPC round-trip per demote. | Negligible | Demote is a rare destructive op (operator-initiated). Single round-trip adds ~10ms; imperceptible. |

## Backend design

All open questions resolved at intake (PM defaults accepted in batch).
Path A (SECURITY DEFINER RPC) + Wrap + pgTAP load-bearing + smoke
defense-in-depth + stable refusal string `'cannot demote self'`. The
design below mirrors the spec 031 last-of-role guard byte-for-byte
where the shape is parallel; the divergences are flagged.

### Foot-gun refinement (architect note before implementation)

The spec's framing — "a logged-in user can self-demote via the
PostgREST UPDATE because the Own profile policy permits self-writes"
— is correct *in shape* but the actual reachable surface is narrower
than implied. The current stack already blocks self-demote for
admin / master callers through the spec 041/042
`assert_brand_id_immutable_for_self()` trigger
([supabase/migrations/20260517050000_rls_hardening_followups.sql:196-228](supabase/migrations/20260517050000_rls_hardening_followups.sql)),
which raises `'role is read-only for self-edits (super_admin only)'`
on any non-super_admin self-UPDATE that touches `role` or `brand_id`.

The hole that actually slips through today is **super_admin self-demote**:

1. `super_admin_manage_profiles` policy
   ([supabase/migrations/20260509000000_multi_brand_schema_rls.sql:985-988](supabase/migrations/20260509000000_multi_brand_schema_rls.sql))
   admits the UPDATE for any super_admin caller targeting any row,
   including their own.
2. `assert_brand_id_immutable_for_self()` explicitly bypasses
   super_admins (`not public.auth_is_super_admin()` guard at
   [20260517050000_rls_hardening_followups.sql:203](supabase/migrations/20260517050000_rls_hardening_followups.sql)).
3. `profiles_role_brand_consistent` CHECK is satisfied because
   `role='user'` accepts any `brand_id` (including NULL).

So a super_admin clicking DEMOTE on themselves — or curling the
PostgREST endpoint directly — successfully self-demotes today.
Recovery requires a sibling super_admin or direct psql access, the
exact "recover-by-psql-only" foot-gun spec 031 set out to avoid.

This doesn't change the design — the new RPC closes the surface
**uniformly across all roles** with a stable refusal string,
defense-in-depth against future trigger-broadening regressions for
admin/master, and as the load-bearing guard for super_admin. But
the test plan and the convention bullet should both name the
super_admin path explicitly so reviewers understand which arm is
"closing a live hole" vs. "defense-in-depth on already-blocked roles."

### Data model changes

**New migration:** `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql`

Strictly additive. No tables, columns, or policies touched. One new
SECURITY DEFINER function. Idempotent via `create or replace`.

**Function signature:**

```
public.demote_profile_to_user(target_user_id uuid)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, auth
```

Returns the demoted profile's id (matches the existing
`demoteProfileToUser` helper's `Promise<string>` contract — the
client extracts `data` and returns it as the resolved string id).

**Body shape (pseudocode):**

```
declare
  v_caller_id uuid := auth.uid();
begin
  -- Defense-in-depth: refuse if auth.uid() is null. The RPC is
  -- only reachable from authenticated PostgREST sessions in practice
  -- (GRANT EXECUTE is to authenticated only — see Authz below), but
  -- service_role bearers and unset JWT claims can both produce
  -- auth.uid() = null. A null caller can never satisfy the
  -- "caller != target" predicate safely, so refuse fail-closed
  -- with the standard SQLSTATE.
  if v_caller_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- THE GUARD. Stable refusal string parallel to spec 031's
  -- 'cannot delete the last super_admin' / spec 012c's
  -- 'cannot delete self' (delete-user/index.ts:169).
  if target_user_id = v_caller_id then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- Destructive op. Mirrors the body the existing demoteProfileToUser
  -- helper at src/lib/db.ts:2757-2766 performs via direct PostgREST.
  -- SECURITY DEFINER bypasses RLS — this is by design: the RPC is the
  -- new authoritative gate and the surrounding policies (super_admin_manage_profiles,
  -- assert_brand_id_immutable_for_self) are now defense-in-depth only.
  update public.profiles
     set role = 'user', brand_id = null
   where id = target_user_id
  returning id into v_caller_id;  -- reuse local; renamed in real impl

  -- maybe_rowcount = 0 → target didn't exist. Raise so the client
  -- gets a structured error instead of a silent no-op.
  if not found then
    raise exception using
      errcode = 'P0002',  -- no_data_found
      message = 'target profile not found';
  end if;

  return v_caller_id;  -- the demoted profile's id
end
```

**Grants:**

```
grant execute on function public.demote_profile_to_user(uuid)
  to authenticated;
```

NOT to `anon`. NOT to `service_role` (service-role callers go through
their own ad-hoc paths and `auth.uid()` is null for them anyway —
explicitly excluding them prevents accidental cross-tenant calls from
edge functions that shouldn't be reaching this path). Mirrors the
posture from spec 031's `grant execute on function
public.assert_not_last_of_role(uuid, text) to authenticated, service_role`
but tighter — `assert_not_last_of_role` is a read-only check, this RPC
is destructive.

**Authz boundary:** the RPC does NOT enforce "caller has admin role"
inside SQL. That gate is enforced by the existing
`super_admin_manage_profiles` UPDATE policy on `profiles` — except
the RPC is SECURITY DEFINER and bypasses RLS, so... we need a role
check. Three options:

1. **Inline `auth_is_privileged()` check inside the function.** Mirrors
   how the edge function `requireAdminCaller` gates: refuse if the
   caller is not admin / master / super_admin. Refusal string
   `'caller is not privileged'` or HTTP 403 mapping at the client.
2. **Rely on the existing UPDATE policy + drop SECURITY DEFINER.**
   With SECURITY INVOKER, the function runs as the caller and RLS
   fires normally. But then a non-privileged caller targeting
   themselves would hit the trigger first (`'role is read-only for
   self-edits'`) instead of the new stable string `'cannot demote
   self'`. Defeats the unified-refusal-string goal.
3. **SECURITY DEFINER + inline `auth_is_privileged()` check.**
   Combines (1) and the destructive-op-bypasses-RLS posture.

**Architect decision: option 3.** The function MUST enforce the
admin-role gate inline because SECURITY DEFINER bypasses the
`super_admin_manage_profiles` policy. Add this near the top of the
body, **after** the null-caller check and **before** the
self-check (so a non-privileged caller hitting their own id sees
`'forbidden'`, not `'cannot demote self'` — clearer error surface):

```
if not public.auth_is_privileged() then
  raise exception using
    errcode = '42501',  -- insufficient_privilege
    message = 'forbidden';
end if;
```

`auth_is_privileged()` returns true for admin / master / super_admin
(see [supabase/migrations/20260514150000_invitations_super_admin_rls.sql](supabase/migrations/20260514150000_invitations_super_admin_rls.sql)
and the canonical helper definition cited from
`supabase/functions/delete-user/index.ts:19`). This is the SQL
mirror of the edge-function `ADMIN_ROLES` set. Reviewers: if a
future role is added (e.g. `billing_admin`), the helper is the single
update point — the RPC inherits the change automatically.

**Final ordering inside the function:** `auth.uid() null check →
auth_is_privileged() role gate → self-check → UPDATE → not-found
check → return id`. Cheapest-fail-first, mirrors `delete-user`'s
ordering convention. The self-check is the load-bearing assertion;
the other gates are defense-in-depth or input validation.

### RLS impact

**No policy changes.** The new RPC is SECURITY DEFINER and bypasses
RLS by design; the inline `auth_is_privileged()` check is the
authorization gate.

**Question for reviewer: does the base "Own profile" UPDATE policy
need narrowing?**

Architect verdict: **no narrowing required.** Three reasons:

1. The "Own profile" policy at
   [supabase/migrations/20260517050000_rls_hardening_followups.sql:122-127](supabase/migrations/20260517050000_rls_hardening_followups.sql)
   exists for legitimate self-writes (dark_mode, locale,
   sidebar_layout). Narrowing it would break those preferences.
2. The role/brand_id column-write lockdown for admin/master is
   already done at the trigger level
   (`assert_brand_id_immutable_for_self`).
3. The actual hole (super_admin self-demote) cannot be closed via a
   tighter Own policy because `super_admin_manage_profiles` is a
   separate, broader policy that admits the row regardless.

The new RPC + inline self-check is sufficient. The Own UPDATE policy
remains a baseline grant for non-destructive preference writes,
which the trigger and RLS together already constrain to safe
columns.

**Defense-in-depth posture after this spec:** four layers, listed
from outermost to innermost:

1. **Client UI guard.** `MembersTab.canActOn` excludes `isSelf`
   ([src/screens/cmd/sections/BrandsSection.tsx:847-855](src/screens/cmd/sections/BrandsSection.tsx)).
   Not load-bearing — UI can regress.
2. **Server self-check (NEW, this spec).** `demote_profile_to_user`
   RPC refuses `target = caller`. Load-bearing.
3. **Trigger (existing).** `assert_brand_id_immutable_for_self` blocks
   admin/master self-edits of `role`/`brand_id`. Defense-in-depth for
   admin/master only; super_admin is exempt at this layer.
4. **RLS policies (existing).** `super_admin_manage_profiles` admits
   super_admin self-writes; without the new RPC, this was the open
   door.

### API contract

**Decision: RPC over PostgREST**
(`POST /rest/v1/rpc/demote_profile_to_user`).
Q1 = Path A. No new edge function, no `verify_jwt` config change.
Same shape as `assert_not_last_of_role` is invoked over RPC from
inside the `delete-user` edge function, except this RPC is the
end-user-facing call (PostgREST routes it for the client directly).

**Request:**

```json
{ "target_user_id": "<uuid>" }
```

**Note on the parameter name:** PostgREST expects the parameter name
to byte-match the function argument name. The function takes
`target_user_id uuid`; the client sends `{ target_user_id: ... }`
in the rpc call. This is a deliberate divergence from the existing
`demoteProfileToUser(profileId)` client signature (the helper
accepts `profileId` and translates internally — see the wrapper diff
below). Spec 031's `assert_not_last_of_role(target_user_id,
target_role)` uses the same arg name; consistency wins.

**Response (success):**

PostgrestSingleResponse-shaped: `{ data: '<uuid>', error: null }`.
The function returns the demoted profile's id as a scalar uuid; the
supabase-js client deserializes this as a string. The existing
`demoteProfileToUser` helper returns `Promise<string>` — the wrapper
extracts `data` and returns it directly.

**Response (refused — self):**

`PostgrestError`-shaped:
```
{
  data: null,
  error: {
    code: 'P0001',
    message: 'cannot demote self',
    details: null,
    hint: null
  }
}
```

**Response (refused — forbidden):**

`{ code: '42501', message: 'forbidden', ... }`. Standard
insufficient-privilege SQLSTATE.

**Response (target not found):**

`{ code: 'P0002', message: 'target profile not found', ... }`.

**Client surfacing:** `db.demoteProfileToUser` re-throws the
`PostgrestError`; the store action's `catch` runs `notifyBackendError`
([src/store/useStore.ts:893](src/store/useStore.ts)) which calls
`console.warn` + a `Toast.show` of `e?.message`. The user sees a
toast reading "Demote profile failed: cannot demote self." This is
the same UX path as the existing `'cannot delete the last
super_admin'` surfacing (spec 031), so no new toast surface is
needed.

### Edge function changes

**None.** Path A is pure SQL + client wrapper. `delete-user`'s
self-check is verify-only (see below). No `supabase/config.toml`
changes, no new deploys.

#### `delete-user` self-check verification (AC B)

I verified the self-check at
[supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts).
The current ordering inside the destructive sequence is:

1. `requireAdminCaller(authHeader)` — line 150-156. Returns 401 if no
   bearer / invalid token; 403 if role not in `ADMIN_ROLES`.
2. `req.json()` parse — line 159.
3. `userId required` validation — line 161-166.
4. **Self-check** — line 168-173. Refuses if `userId === gate.userId`
   with HTTP 400 + `'cannot delete self'`. **Fires BEFORE any
   side-effects.**
5. Service-role client init — line 175.
6. `requireSameBrandOrSuperAdmin` brand-match gate (spec 043) —
   line 189-200.
7. `assert_not_last_of_role` RPC (spec 031) — line 234-246.
8. Cascading deletes (`user_stores`, `profiles`, `invitations`,
   `auth.admin.deleteUser`) — line 248-252.

**Verdict: the self-check is correctly positioned as the first gate
after auth + input validation, BEFORE the brand-match gate, the
last-of-role guard, and any destructive side-effect.** AC B is
satisfied by the existing code; no edit required to
`supabase/functions/delete-user/index.ts`.

**Caveat for reviewers:** the spec asks for AC B to be a
"verify-and-tighten." There is nothing to tighten — the check is in
the right place with the right string. The pgTAP file header (AC C)
includes a one-line comment cross-referencing the delete-user
self-check at `index.ts:168-173` so a future reviewer who finds the
pgTAP file is reminded the edge-function sibling exists.

### `src/lib/db.ts` surface

**Same name, same signature, body swap.** Q3 = wrap. The exported
client helper at [src/lib/db.ts:2757-2766](src/lib/db.ts) keeps:

```typescript
export async function demoteProfileToUser(profileId: string): Promise<string>
```

**Diff (conceptual — backend-developer writes the actual code):**

Before:
```typescript
const { data, error } = await supabase
  .from('profiles')
  .update({ role: 'user', brand_id: null })
  .eq('id', profileId)
  .select('id')
  .single();
if (error) throw error;
return data.id;
```

After:
```typescript
const { data, error } = await supabase
  .rpc('demote_profile_to_user', { target_user_id: profileId });
if (error) throw error;
return data as string;  // RPC returns scalar uuid
```

**No snake_case → camelCase mapping needed.** The RPC returns a
scalar uuid; the existing `mapItem` family of helpers is for row
shapes. Comment block at the call site should be updated to point at
the new SQL function and spec 050 (replaces the existing block at
[src/lib/db.ts:2747-2756](src/lib/db.ts) that says "Future spec
should wrap as SECURITY DEFINER" — that future spec is this one).

**No call-site changes outside `db.ts`.** The store action at
[src/store/useStore.ts:863-895](src/store/useStore.ts) and the
BrandsSection caller at
[src/screens/cmd/sections/BrandsSection.tsx:847-855](src/screens/cmd/sections/BrandsSection.tsx)
remain untouched. AC E satisfied.

### pgTAP test cases (load-bearing track)

**New file:** `supabase/tests/demote_self_guard.test.sql`. Current
pgTAP file count is **29** (verified via Glob on
`supabase/tests/*.sql`). Post-spec: **30**. AC C's stated count
update lands here.

**Header comment:** mirror the shape of
[supabase/tests/delete_last_privileged_guard.test.sql:1-33](supabase/tests/delete_last_privileged_guard.test.sql).
Include the AC C cross-reference: "Sibling self-action guard exists
in [supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts).
Both refuse `caller.id == target.id` with stable strings — the SQL
side here, the TS side there."

**Plan: 4 arms.** Hermetic `begin; ... rollback;` isolation.

| Arm | Setup | Call | Assertion |
|-----|-------|------|-----------|
| (i) | `set local role authenticated` + `request.jwt.claims` mapping `sub = seed admin id (11111111-...)` + `app_metadata.role = 'admin'`. | `select public.demote_profile_to_user('11111111-...')` | `throws_ok` with SQLSTATE `P0001`, message `'cannot demote self'`. Load-bearing — this is the regression detector. |
| (ii) | Same JWT context as (i). | `select public.demote_profile_to_user('22222222-...')` (seed manager). | `lives_ok` + `is (select role from profiles where id = '22222222-...') 'user'` + `is (select brand_id ...) null`. Happy-path: admin demotes another user successfully. |
| (iii) | `request.jwt.claims` mapping `sub = '22222222-...'` (seed manager, role=user) + `app_metadata.role = 'user'`. | `select public.demote_profile_to_user('11111111-...')` | `throws_ok` with SQLSTATE `42501`, message `'forbidden'`. Authz check: non-privileged caller refused before the self-check fires. |
| (iv) | `set local role authenticated` + `request.jwt.claims` empty / `sub` unset → `auth.uid()` returns null. | `select public.demote_profile_to_user('11111111-...')` | `throws_ok` with SQLSTATE `P0001`, message `'cannot demote self'`. Defense-in-depth: null caller refused (same string, by design — null caller cannot prove non-self). |

**Note on Arm (iv):** the message string contract — null caller and
target-equals-caller both produce `'cannot demote self'` — is
intentional. A separate `'caller is null'` string would leak that
the auth was missing; the unified string is the safer surface. The
test asserts the exact byte-for-byte string.

**JWT-context idiom:** mirror
[supabase/tests/invitations_super_admin_rls.test.sql:59-76](supabase/tests/invitations_super_admin_rls.test.sql).
`set local role authenticated;` + `select set_config('request.jwt.claims',
jsonb_build_object(...)::text, true);` is the canonical way to make
`auth.uid()` return the seed admin's id inside the test. The
SECURITY DEFINER function reads `auth.uid()` per-call, so the JWT
context applies.

**No fixture sanity assertion.** Matches spec 031's pattern (the
seed UUIDs are well-known literals; an explicit fixture check would
be noise).

### Smoke arm shape (defense-in-depth)

**File:** [scripts/smoke-edge-roles.sh](scripts/smoke-edge-roles.sh).

**Arm number: 7.** Current last arm is Arm 6 (last-super-admin
delete refusal, spec 031). The new arm appends.

**Naming:** "Arm 7: self-demote refusal (spec 050)".

**Does NOT reuse Arm 4's super_admin promotion.** Per AC D, the
self-demote check is meaningful at any admin role. Reusing
ADMIN_BEARER from Arm 3 (plain admin) is simpler and avoids
contaminating the super_admin promotion's
`PROMOTED=1 / restore_admin` machinery. Order in the file: append
AFTER Arm 6, BEFORE the final `exit $FAILED`.

**Sequence (verbatim from AC D, with the route concretized):**

```bash
step "Arm 7: self-demote refusal (spec 050)"
DEMOTE_RPC_URL="${SUPABASE_URL}/rest/v1/rpc/demote_profile_to_user"

if [[ -z "${ADMIN_BEARER}" ]]; then
  skip "self-demote arm" "no ADMIN_BEARER (Arm 3 login failed?)"
else
  ADMIN_UID=$(docker exec -i supabase_db_imr-inventory psql -tA \
    -U postgres -d postgres \
    -c "select id from auth.users where email='${ADMIN_EMAIL}' limit 1;" \
    2>/dev/null | tr -d ' ')

  if [[ -z "$ADMIN_UID" ]]; then
    fail "could not resolve admin uid for ${ADMIN_EMAIL}"
  else
    # Snapshot pre-state for state-mutation invariant.
    PRE_ROLE=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select role from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')
    PRE_BRAND=$(docker exec -i supabase_db_imr-inventory psql -tA \
      -U postgres -d postgres \
      -c "select coalesce(brand_id::text, 'NULL') from public.profiles where id='${ADMIN_UID}';" \
      2>/dev/null | tr -d ' ')

    RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${ADMIN_BEARER}" \
      -H "Content-Type: application/json" \
      -d "{\"target_user_id\":\"${ADMIN_UID}\"}" \
      "$DEMOTE_RPC_URL")
    CODE=$(printf '%s' "$RESPONSE" | tail -1)
    BODY=$(printf '%s' "$RESPONSE" | sed '$d')

    # PostgREST maps P0001 → HTTP 400. The body is a PostgrestError JSON:
    #   {"code":"P0001","details":null,"hint":null,"message":"cannot demote self"}
    if [[ "$CODE" == "400" ]]; then
      if printf '%s' "$BODY" | grep -qE '"message":"cannot demote self"'; then
        pass "demote_profile_to_user RPC refused self (HTTP 400, $BODY)"
      else
        fail "expected message 'cannot demote self', got: ${BODY:0:200}"
      fi
    else
      fail "expected 400, got $CODE: ${BODY:0:200}"
    fi

    # State-mutation invariant: admin row unchanged.
    POST_ROLE=$(...same as PRE_ROLE...)
    POST_BRAND=$(...same as PRE_BRAND...)
    if [[ "$POST_ROLE" == "$PRE_ROLE" && "$POST_BRAND" == "$PRE_BRAND" ]]; then
      pass "post-check: admin role/brand_id unchanged"
    else
      fail "post-check: admin mutated (role ${PRE_ROLE}→${POST_ROLE}, brand ${PRE_BRAND}→${POST_BRAND})"
    fi
  fi
fi
```

**PostgREST RPC error mapping:** PostgREST translates
`raise exception` SQLSTATE codes to HTTP status as follows: `P0001`
→ 400, `P0002` → 404, `42501` → 403 (with some variation by
version). Reviewer flag: pin the assertion to the **message string,
not the status code**, in case the version mapping shifts. The
current smoke assertion above pins to both 400 AND the message — if
PostgREST changes the status mapping in a future Supabase upgrade,
the message assertion is the load-bearing test. This is the same
posture spec 031 used.

**No new refuse-non-local guard.** The arm inherits the existing
guard at
[scripts/smoke-edge-roles.sh:53-60](scripts/smoke-edge-roles.sh).
The state-mutation invariant is the safety net if a future remote
run slips past the guard (worst case: a no-op refusal against prod,
no state change).

### Realtime impact

**No channel changes.** `profiles` is already in the existing
`supabase_realtime` publication; the demote UPDATE triggers a
realtime event today via the direct PostgREST UPDATE, and will
continue to trigger one via the RPC's internal UPDATE. The
`store-{id}` channel does NOT replay this (profiles is admin-global,
not store-scoped); the `brand-{id}` channel DOES — but the spec's
store action at [src/store/useStore.ts:879-884](src/store/useStore.ts)
already re-fetches via `loadBrandAdmins` after the RPC resolves, so
realtime is just a hint here.

**Publication membership: no changes.** The new function adds no
table to `supabase_realtime`. The `docker restart
supabase_realtime_imr-inventory` gotcha (CLAUDE.md "Realtime
publication gotcha") does NOT apply to this spec. Reviewers can
skip this concern.

### Frontend store impact

**Slice touched:** `demoteProfileToUser` action at
[src/store/useStore.ts:863-895](src/store/useStore.ts).

**Change:** none. The action calls `db.demoteProfileToUser(profileId)`
on line 875 today; it continues to call the same function with the
same signature. The error path through `notifyBackendError` already
handles `PostgrestError` shape via `e?.message` extraction (line
27-29 of useStore.ts). The optimistic-then-revert pattern at
line 868-893 fires correctly for the new error shape:

1. Optimistic flip across `brandAdminsByBrandId` cache.
2. `await db.demoteProfileToUser(profileId)` throws `PostgrestError`
   with `message = 'cannot demote self'`.
3. `catch` runs: `set({ brandAdminsByBrandId: prevByBrand })` reverts;
   `notifyBackendError('Demote profile', e)` toasts "Demote profile
   failed: cannot demote self."
4. Return `false`.

**No new slice. No new toast surface. AC E satisfied.**

### Convention doc additions (AC F)

**Two strictly-additive bullets. No reordering of existing bullets.**

1. **`CLAUDE.md` under "Conventions already in use"**: add a new
   bullet AFTER the existing spec-031 last-of-role bullet
   ("Edge functions performing destructive role-change or deletion
   operations include a last-of-role guard."). Suggested wording for
   backend-developer to refine:

   > "Edge functions and SECURITY DEFINER RPCs performing destructive
   > role-change or deletion operations enforce a server-side
   > `caller.id != target.id` guard. The refusal raises with stable,
   > byte-for-byte refusal strings: `'cannot delete self'`
   > ([supabase/functions/delete-user/index.ts:168-173](supabase/functions/delete-user/index.ts)),
   > `'cannot demote self'`
   > ([supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql](supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql),
   > spec 050). The SQL path uses SQLSTATE `P0001` so PostgREST maps to
   > HTTP 400; the edge-function path returns HTTP 400 directly. A
   > new destructive path that targets a profile id MUST add a
   > self-guard before any side-effect, with a string that follows
   > the `'cannot <verb> self'` convention. Sibling rule to the
   > last-of-role guard (spec 031) — both protect against
   > recover-by-psql-only states."

2. **`.claude/agents/security-auditor.md`** in the audit-rule list:
   add a bullet parallel to the spec 031 last-of-role audit
   reminder. Suggested substance:

   > "When reviewing destructive role-change or deletion paths,
   > verify a server-side `caller.id != target.id` guard exists.
   > Reference: spec 050. The guard MUST fire before any side-effect
   > and MUST raise with the stable refusal string convention
   > (`'cannot delete self'`, `'cannot demote self'`, etc.). Mirror
   > the spec 031 last-of-role audit check — both are members of
   > the destructive-action discipline."

**No new bullet for the SECURITY DEFINER RPC pattern.** The existing
spec-031 sibling already implicitly covers RPC-vs-edge-function
choice via the "edge functions and SECURITY DEFINER RPCs" phrasing.

### Drift / convention risks for reviewers

| Risk | Where to look | Mitigation |
|------|---------------|------------|
| Backend-developer wires the RPC but forgets the inline `auth_is_privileged()` role gate, relying on the bypassed `super_admin_manage_profiles` policy. | The RPC body. SECURITY DEFINER means RLS is bypassed; without the inline gate, ANY authenticated caller could demote ANY user. | pgTAP Arm (iii) is the regression detector — a non-privileged caller demoting an admin MUST refuse with `42501 'forbidden'`. Code-reviewer sees the gate; security-auditor checks the test. |
| Refusal string drifts (`'cannot demote yourself'`, capital C, trailing punctuation, etc.). | The migration's raise message, the wrapper's error path, the pgTAP assertion, the smoke assertion. | Four enforcement points: AC C pgTAP arm asserts exact byte string; AC D smoke arm greps for `"message":"cannot demote self"`; AC F bullet pins the wording. If any one of these drifts, the others fail loudly. |
| Migration applied AFTER client deploy in prod (Vercel ships the wrapper before the SQL function exists). | Release ordering. | The risk table already covers this: PostgREST returns HTTP 404 / `42883 function does not exist` fail-closed. Release notes call out "migration first, web deploy second." Architect recommends folding this into the standing deploy runbook. |
| `auth.uid()` returns null under service-role bearers but the RPC's null-caller branch raises `'cannot demote self'` rather than `'forbidden'`. | Migration body. | This is deliberate (per the table above): a unified string avoids leaking auth-state to a probing caller. If a maintainer "fixes" this to differentiate, the pgTAP Arm (iv) breaks loudly. Comment in the migration body explains the design. |
| Future role-hierarchy spec (e.g. "only super_admins can demote super_admins") extends this RPC and forgets to extend the test plan. | The migration body + pgTAP file. | Out of scope for this spec per "Out of scope" — flagged explicitly. The convention bullet's "MUST add a self-guard before any side-effect" wording does NOT preclude a role-hierarchy spec from adding additional guards on top. |
| pgTAP test interaction with the new RPC's role gate when the JWT context isn't fully set (e.g. running the file without `set local role authenticated`). | The pgTAP test file. | The test file's `set local role authenticated` + `request.jwt.claims` JSON is the canonical idiom (see spec 031 / invitations_super_admin_rls test). The arm-iv null-caller test deliberately uses an unset claim to verify the null-caller branch. Reviewers can pattern-match against the existing precedent. |
| `delete-user` edge function's self-check string drift in a future spec. | [supabase/functions/delete-user/index.ts:169](supabase/functions/delete-user/index.ts). | The pgTAP file's header comment cross-references the line. The smoke Arm 6 also already asserts on this string (with the `cannot delete self` OR `cannot delete the last super_admin` regex, line 360). Drift would be loud. |
| Spec 027 "inline-not-shared" lesson does NOT apply (no `_shared/` involvement on Path A); reviewers may still flag it out of habit. | N/A — the spec is pure SQL + a client wrapper. | This design section explicitly notes: spec 027's lesson is about edge-function modules; Path A is SQL, deployed atomically. No drift surface. Reviewers can move on. |

### Migration ordering / rollout

**Single migration. Strictly additive.** No tables, columns, or
policies touched. Idempotent (`create or replace function`).

Filename: `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql`.

**Rollback plan:** `drop function public.demote_profile_to_user(uuid);`.
Restores the pre-spec state (the wrapper at `src/lib/db.ts:2757` would
need to be reverted to the direct PostgREST UPDATE in lockstep — this
is a coupled rollback, NOT a SQL-only rollback). For a one-side
rollback (SQL only, client still pointing at the RPC), the client
sees HTTP 404 / `42883` and the demote UI surfaces "function does
not exist" via `notifyBackendError`. No data corruption; degraded
UX only.

**Performance:** O(1). Single UPDATE on a single row by primary key.
The function adds ~10ms RPC round-trip overhead vs. the direct
PostgREST UPDATE. The 286 KB seed dataset is irrelevant here — this
is a single-row destructive op.

**CI:** per CLAUDE.md "CI workflow", there is no
`db-migrations-applied.yml` gate in prod. Manual verification of
migration apply on the local stack via `npm run dev:db` (which
re-applies migrations on `supabase start`) is the developer's
responsibility. The pgTAP suite (`npm run test:db`) exercises the new
function and will fail loudly if it's missing — that is the CI-side
regression detector.

### Manual verification (AC G)

The developer's manual gate is the curl-against-local-stack flow:

1. `npm run dev:db` — fresh stack with the new migration applied.
2. Login as `admin@local.test` → bearer.
3. `curl -X POST .../rest/v1/rpc/demote_profile_to_user` with
   `{"target_user_id":"<admin's own uid>"}` and the bearer →
   expect HTTP 400 + `{"code":"P0001","message":"cannot demote
   self",...}`.
4. Open the Cmd UI → Brands → Members on the admin's own brand →
   confirm the `(you)` label is visible on the admin's row and no
   DELETE / DEMOTE buttons appear.
5. Confirm a non-self DEMOTE (against a manager row) still flips the
   role + clears `brand_id` + re-fetches the brand admin list.

Reviewer can collapse manual steps 4 and 5 into a single Cmd UI
session if they're confident the existing tests pass.

## Files changed

### Migrations
- `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql` — new SECURITY DEFINER RPC `public.demote_profile_to_user(target_user_id uuid) returns uuid`. Four-gate ordering: null-caller check → `auth_is_privileged()` role gate → self-check → UPDATE → not-found check → return id. SQLSTATE `P0001` for the self refusal and the null-caller refusal (unified string `'cannot demote self'`), `42501` for the role gate (`'forbidden'`), `P0002` for not-found (`'target profile not found'`). `revoke ... from public, anon` + `grant execute ... to authenticated`. Idempotent (`create or replace`).

### Client wrapper
- `src/lib/db.ts` (lines 2747-2766) — `demoteProfileToUser(profileId: string): Promise<string>` body swapped from direct PostgREST UPDATE to `supabase.rpc('demote_profile_to_user', { target_user_id: profileId })`. Signature preserved; no call-site changes outside `db.ts`. Comment block updated to point at spec 050 and the new migration.

### Tests
- `supabase/tests/demote_self_guard.test.sql` — new pgTAP file. `plan(6)`: four arms (i admin self refused; ii admin demotes another user happy-path; iii non-privileged caller refused with `42501 'forbidden'`; iv null caller refused with unified `'cannot demote self'`), with arm (ii) contributing 3 assertions (lives_ok + role-after + brand_id-after). Hermetic `begin; … rollback;`. File-count delta: 29 → 30.
- `scripts/smoke-edge-roles.sh` — new "Arm 7: self-demote refusal (spec 050)" appended after Arm 6, before the final `exit $FAILED`. Reuses Arm 3's `ADMIN_BEARER`. Asserts HTTP 400 AND `"message":"cannot demote self"` (string is load-bearing; status mapping can drift). State-mutation invariant: re-query admin row, role + brand_id unchanged.

### Edge functions
- `supabase/functions/delete-user/index.ts` — **read-only verified** per AC B. The existing self-delete check at lines 168-173 is correctly positioned as the first gate after `requireAdminCaller` and the `userId required` input validation, BEFORE the service-role client init, the spec 043 brand-match gate, the spec 031 last-of-role guard, and any destructive `from(...).delete()` / `auth.admin.deleteUser`. Refusal string is byte-for-byte `'cannot delete self'`. No edit required.

### Convention docs (strictly additive)
- `CLAUDE.md` — new bullet under "Conventions already in use", placed AFTER the existing spec-031 last-of-role bullet. Captures the self-action rule across both edge functions and SECURITY DEFINER RPCs, names both refusal strings (`'cannot delete self'`, `'cannot demote self'`), references both reference shapes, and flags the convention for future role-hierarchy specs.
- `.claude/agents/security-auditor.md` — new audit-rule bullet, placed AFTER the existing spec-031 last-of-role audit bullet. Mirrors the convention in audit-rule shape: any destructive role-change/deletion path that takes a `target_user_id` MUST refuse `caller.id == target.id` with the stable refusal-string convention BEFORE any side-effect. Severity High (operator footgun).

### Verification gates run
- `npx tsc --noEmit` → exit 0.
- `npm run typecheck:test` → exit 0.
- `npm test -- --ci` → 17 suites / 182 tests passed.
- `npm run test:db` → 30/30 DB test files passed (pgTAP delta: +1; total 29 → 30).
- `npm run test:smoke` → all arms passed including new Arm 7 (`demote_profile_to_user RPC refused self (HTTP 400, {"code":"P0001","details":null,"hint":null,"message":"cannot demote self"})`).

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec. Path A confirmed
  (SECURITY DEFINER RPC, no new edge function). Key implementation
  points the design pinned down for you:
    1. New migration `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql`
       creating `public.demote_profile_to_user(target_user_id uuid)
       returns uuid` with the four-gate ordering: null-caller check
       → `auth_is_privileged()` role gate → self-check → UPDATE →
       not-found check → return id. SQLSTATE P0001 for the self
       refusal and the null-caller refusal (unified string
       `'cannot demote self'`), 42501 for the role gate (`'forbidden'`),
       P0002 for not-found (`'target profile not found'`). Grant
       execute to `authenticated` only.
    2. Wrap (not hard-delete) `demoteProfileToUser` at
       [src/lib/db.ts:2757-2766](src/lib/db.ts) — swap the
       PostgREST UPDATE for `supabase.rpc('demote_profile_to_user',
       { target_user_id: profileId })`. Preserve the
       `Promise<string>` signature. Update the comment block to
       point at spec 050.
    3. New pgTAP file `supabase/tests/demote_self_guard.test.sql`
       with the four arms in the design table. File count goes
       29 → 30.
    4. New smoke arm "Arm 7" in `scripts/smoke-edge-roles.sh` per
       the bash sketch in the design. Append after Arm 6, before
       the final `exit $FAILED`.
    5. AC B is verify-only — `delete-user`'s self-check at
       index.ts:168-173 is correctly positioned; no edit needed.
    6. CLAUDE.md and `.claude/agents/security-auditor.md` get the
       two strictly-additive bullets per the design (suggested
       wording is in the design section).
  After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/050-server-side-self-protection-hardening.md
</content>
</invoke>