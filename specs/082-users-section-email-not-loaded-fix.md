# Spec 082: Users & access — fix "(email not loaded)" for registered users

Status: READY_FOR_REVIEW

## Summary (confirmed prod bug)

In the admin **Users & access** section ([src/screens/cmd/sections/UsersSection.tsx](../src/screens/cmd/sections/UsersSection.tsx)), every REGISTERED (status `active`) user shows "**(email not loaded)**" instead of their email. Reported by the user with a prod screenshot (Bobby/admin and Charles/user both show it). Root-caused in code and confirmed against prod by main Claude.

This is NOT cosmetic. With `email = ''`:
- "**Reset PW**" bails with the toast "No email on file" for every registered user ([UsersSection.tsx:77-85](../src/screens/cmd/sections/UsersSection.tsx)).
- The DELETE confirmation text loses the email.

So the bug degrades real admin actions, not just a label.

## Root cause (already verified — do not re-derive)

`profiles` has no email column. The Users page infers each user's email from the `invitations` table.

1. The loader for this section is `fetchBrandAdmins(brandId)` in [src/lib/db.ts:3225](../src/lib/db.ts) (called from [src/store/useStore.ts:724](../src/store/useStore.ts)). Its invitations query filters `.eq('used', false)` ([db.ts:3240](../src/lib/db.ts)) — i.e. it only loads PENDING invites.
2. Registration ([src/lib/auth.ts:402](../src/lib/auth.ts) → `consume_invitation` RPC, [supabase/migrations/20260424211733_security_fixes.sql:99-104](../supabase/migrations/20260424211733_security_fixes.sql)) flips the invitation to `used = true` and does **not** set `invitations.profile_id`.
3. The `db.ts` comment at [:3267-3271](../src/lib/db.ts) claims `profile_id` "is set by `consume_invitation`". It is **not** — the RPC only sets `used = true`. So the `inviteByProfileId` map is always empty in practice; email resolves by **name-match only** ([db.ts:3286](../src/lib/db.ts) `inviteByName.get(p.name)`).
4. Net: once a user registers, their invitation becomes `used = true` → excluded by the `used = false` filter → no invitation row left to name-match → `email = ''` → "(email not loaded)" at [UsersSection.tsx:344](../src/screens/cmd/sections/UsersSection.tsx).

**Prod-confirmed (PII-free):** the 2 active admin + 2 active user profiles each have a name-matching invitation, and ALL of those invitations are `used = true` (zero `used = false`). The invitations exist and would resolve by name if not filtered out.

**Consistency proof:** the sibling loader `fetchInvitationsForUserLookup` ([db.ts:120-129](../src/lib/db.ts), used by `fetchAllUsers` / BrandsSection members tab) has NO `used` filter and resolves emails fine for the same users. Only `fetchBrandAdmins` carries the bug.

## User story

As an admin in **Users & access**, I want each registered user's email to display so that I can identify accounts and use **Reset PW** / **Delete** with the correct email — instead of seeing "(email not loaded)" and being blocked from those actions.

## Acceptance criteria

- [ ] In **Users & access**, every registered (status `active`) profile that has a name-matching `invitations` row renders that email at [UsersSection.tsx:344](../src/screens/cmd/sections/UsersSection.tsx) instead of "(email not loaded)". Verified specifically for the 4 reported prod accounts (2 admin, 2 user) in the local prod-mirror seed.
- [ ] For a registered user with a resolved email, "**Reset PW**" no longer bails with "No email on file" ([UsersSection.tsx:77](../src/screens/cmd/sections/UsersSection.tsx)) — `u.email` is non-empty so `sendPasswordReset(u.email)` runs.
- [ ] For a registered user with a resolved email, the DELETE confirmation text includes the email.
- [ ] PENDING invitations still appear exactly once as synthetic `status: 'pending'` rows. An invitation that has been consumed (`used = true`) must NOT also appear as a duplicate pending row for a user already present in the active list — the existing dedup at [db.ts:3304-3306](../src/lib/db.ts) (skip invites whose email matches an active row) continues to hold.
- [ ] `fetchBrandAdmins` returns the same row count it does today for a brand: one row per active profile + one row per genuinely-outstanding (unconsumed, undeduped) invitation. No registered user gains a phantom second row.
- [ ] The misleading `db.ts:3267-3271` comment is corrected to match reality (whatever matching strategy the chosen option lands on — name-match and/or `profile_id`).
- [ ] Brand scoping is unchanged: `fetchBrandAdmins` continues to read only invitations/profiles for the passed `brandId`. No cross-brand email bleed.

## Chosen approach + options (architect decides final implementation)

The PM-recommended in-scope fix is **Option A**. The other two are documented because there is a real architecture decision here (the dual-purpose `invites` array, and name-match-vs-`profile_id` robustness) — the architect picks in design mode. The recommendation does not bind the architect.

- **Option A — minimal, no migration (RECOMMENDED for the reported bug).** In `fetchBrandAdmins`, source the email-inference from ALL brand invitations (drop the `used = false` filter on the inference source). Apply `!used` only when building the synthetic PENDING rows so consumed invites don't become phantom pending entries; the existing email-match dedup at [db.ts:3304-3306](../src/lib/db.ts) stays. Pure `db.ts` read change. Prod-confirmed to resolve the 4 reported users (their `used = true` invites name-match). This is the splitting of the currently-dual-purpose `invites` array — one query/derivation feeds email inference (all invites), a filtered view feeds pending rows (`!used`) — which is the architecture call the architect should bless.

- **Option B — robustness add-on, small migration (pairs naturally with A).** ALSO set `invitations.profile_id` in `consume_invitation` ([migration :99-104](../supabase/migrations/20260424211733_security_fixes.sql)) on consume, plus optionally a one-time backfill of existing consumed rows, so email-inference can match by id instead of name. Removes the "two users sharing a display name → swapped emails" fragility the `db.ts` comment frets about. That fragility is currently moot (the `profile_id` path never fires because it's never set) but the name-match path IS genuinely fragile, so B converts the comment from aspirational to true.

- **Option C — deepest, bigger (likely paired as A+C).** Store email ON `profiles` (new column + backfill from `auth.users` via a service-role/edge path + sync on registration), eliminating invitation-inference entirely. This is the ONLY option that also gives an email to the bootstrap `super_admin` and to any account created WITHOUT an invitation (prod-confirmed: the super_admin has no matching invitation, so A and B will NOT give it an email). Heavier: migration + backfill + a service-role/edge path to read `auth.users` emails (admins cannot read `auth.users` directly under RLS).

## In scope

- Fix `fetchBrandAdmins` in `db.ts` so registered users in **Users & access** show their inferred email (Option A as the recommended baseline; the architect may upgrade to A+B per the open question below).
- Correct the stale/false `db.ts:3267-3271` comment.
- Preserve existing pending-row behavior and dedup.

## Out of scope (explicitly)

- **Accounts created WITHOUT an invitation (e.g. the bootstrap `super_admin`).** Prod-confirmed: the super_admin has no name-matching invitation, so Options A and B will NOT resolve its email — it will still show "(email not loaded)". Fixing that requires Option C (email-on-profiles). This is the load-bearing scoping decision (see Open questions) — if the user wants the super_admin fixed too, scope expands to C/A+C and the acceptance criteria above must add a super_admin case. Left out of the baseline so the gap is a conscious decision, not a silent miss.
- The sibling loader `fetchInvitationsForUserLookup` ([db.ts:120](../src/lib/db.ts)) and the BrandsSection members tab — they already resolve emails correctly; not touched. (Rationale: not part of the reported bug; touching them is scope creep.)
- Any change to how `sendPasswordReset` / the delete-user edge function work — they already behave correctly once `u.email` is populated.
- Adding a realtime channel to **Users & access** — out of scope per the existing on-mount + post-action fetch design ([UsersSection.tsx:20-23](../src/screens/cmd/sections/UsersSection.tsx)). Not introducing it here.

## Open questions resolved

- Q: Which accounts must show their email after the fix — just the reported registered-via-invitation users, or also no-invitation accounts like the bootstrap super_admin? → A: **UNRESOLVED — load-bearing, surfaced to the user.** Could not prompt in this subagent context (AskUserQuestion unavailable inside subagents). PM default for this draft: fix the **reported** users via **Option A** (baseline), document A+B and C as options, and explicitly carve the no-invitation super_admin into "Out of scope". If the user wants the super_admin / all accounts fixed, the architect should scope to **Option C (or A+C)** and the super_admin case must be added to the acceptance criteria. **The user should confirm A / A+B / C before or during architect design.**
- Q: Name-match vs `profile_id` matching robustness? → A: Surfaced as Option B. Architect decides whether to land the `consume_invitation` `profile_id` write + backfill now (A+B) or accept name-match for the baseline (A) and defer B.

## Dependencies

- [src/lib/db.ts:3225-3322](../src/lib/db.ts) `fetchBrandAdmins` — the buggy loader (primary change site).
- [src/lib/db.ts:120-129](../src/lib/db.ts) `fetchInvitationsForUserLookup` — correct sibling, for contrast / consistency reference.
- [src/screens/cmd/sections/UsersSection.tsx](../src/screens/cmd/sections/UsersSection.tsx) — consumer (`:344` label, `:77` Reset-PW bail, delete confirmation).
- [src/store/useStore.ts:724](../src/store/useStore.ts) — calls `fetchBrandAdmins`.
- [supabase/migrations/20260424211733_security_fixes.sql:87-110](../supabase/migrations/20260424211733_security_fixes.sql) `consume_invitation` — only relevant if Option B (set `profile_id`) or C is chosen.
- [src/lib/auth.ts:390-414](../src/lib/auth.ts) `registerInvitedUser` — calls `consume_invitation`; relevant if B/C.
- `auth.users` email source — only relevant if Option C is chosen (requires a service-role/edge path; admins can't read `auth.users` under RLS).
- Local prod-mirror seed ([supabase/seed.sql](../supabase/seed.sql), pulled from prod 2026-05-02) — the verification fixture for the 4 reported accounts.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI — `src/screens/cmd/sections/UsersSection.tsx`. No legacy surface.
- **Per-store or admin-global:** Admin-global users surface, but `fetchBrandAdmins` is **brand-scoped** (`brandId`). Brand scoping must be preserved; no cross-brand email bleed.
- **Edge function or PostgREST:** Option A is a pure PostgREST read change in `db.ts` — no new backend logic. Option B touches the `consume_invitation` RPC (PostgREST RPC, migration). Option C would add a service-role/edge path to read `auth.users` emails.
- **Realtime channels touched:** none. Users & access uses on-mount + post-action fetch, no realtime channel.
- **Migrations needed:** Option A — **no**. Option B — **yes** (alter `consume_invitation` + optional backfill). Option C — **yes** (add `profiles.email` column + backfill + sync).
- **Edge functions touched:** Option A/B — none. Option C — likely a new or extended service-role/edge path to read `auth.users` emails for the backfill/sync.
- **Web/native scope:** both. This is shared `db.ts` + Cmd UI logic with no platform-specific code; no `app.json` / slug impact.
- **Tests (spec 022 tracks):** 
  - **jest** — unit-test `fetchBrandAdmins`'s row-shaping against a fixture covering: (a) a registered profile with a `used = true` name-matching invite resolves a non-empty email; (b) an unconsumed invite still yields exactly one pending row; (c) a consumed invite for an already-active user does NOT duplicate. 
  - **pgTAP** — only if Option B/C lands (e.g. `consume_invitation` sets `profile_id`; or the `profiles.email` backfill). Not needed for Option A.
  - **shell smoke / E2E (Playwright, web-only, specs 078-080)** — optional: assert the Users & access list renders a real email (not "(email not loaded)") for a seeded registered user. Architect/test-engineer route the track.

---

## Backend / Frontend design

Scope decided by the user: **Option A + B** (the `db.ts` read fix AND the `consume_invitation` + backfill migration). Option C (email-on-`profiles`) is NOT in scope; the super_admin / no-invitation account stays "(email not loaded)" — see "Documented out-of-scope gap" below, which the user accepted.

This is a **backend / data-layer-only** change. There is **no frontend surface** (see §7). The recommended dev split at the bottom is `backend-developer` SOLO.

### 0. Ground truth discovered while reading the code (corrections to the spec's premises)

Two facts the spec did not capture; both change the design and the test fixtures, so they are called out before the design proper.

1. **`invitations.profile_id` is `NOT NULL` in prod, with no DB default and no FK.**
   - `recover_undeclared_tables` ([:106](../supabase/migrations/20260424211732_recover_undeclared_tables.sql)) declares `profile_id uuid` (nullable, no default).
   - `remote_schema` ([:95](../supabase/migrations/20260502071736_remote_schema.sql)) then does `alter column profile_id set not null`. There is no FK to `profiles` or `auth.users`.
   - `createInvite` ([src/lib/auth.ts:296](../src/lib/auth.ts)) inserts the **sentinel** `'00000000-0000-0000-0000-000000000000'` to satisfy NOT NULL on pending invites (the inviter does not yet know the invitee's future profile id).
   - **Consequence:** the backfill (and the `db.ts` "is it set?" test) must treat the **sentinel**, not literal `NULL`, as "unset". A used invite in prod today has `profile_id = '00000000-…'`, never NULL. The migration must NOT try to set the column NULL anywhere (it would violate NOT NULL).

2. **The local seed has ZERO `invitations` rows and does NOT contain the 4 reported prod accounts as registered-via-invitation users.**
   - [supabase/seed.sql](../supabase/seed.sql) seeds exactly three auth users / profiles: `admin@local.test`, `manager@local.test`, `master@local.test` (lines 17–177). "Charles" at [seed.sql:179](../supabase/seed.sql) is a **store** (`2018 N Charles St`), not a user.
   - There are no `INSERT INTO public.invitations` statements in the seed.
   - **Consequence:** acceptance criterion #1 ("Verified specifically for the 4 reported prod accounts ... in the local prod-mirror seed") **cannot be satisfied against the seed as it exists** — there is nothing in the seed to resolve an email from. This does not block the fix (it is correct against prod), but it does change the test strategy: verification is via **hermetic test fixtures** (jest fixture array + pgTAP `begin; … rollback;` that inserts its own invitation rows), NOT the seed. See §6 and "Open question for the PM/test-engineer" below. **This is a should-fix on the spec's wording, not a blocker on the build.**

### 1. Data model changes

**Migration:** `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql` (next in sequence after `20260530000000_record_missed_orders_rpc.sql`; today is 2026-05-31).

No new tables, columns, or indexes. The migration does two things, both **additive / non-destructive**:

**(a) Redefine `public.consume_invitation(uuid, text)`** — `CREATE OR REPLACE FUNCTION`, preserving the existing signature, `language plpgsql`, `security definer`, and `set search_path = public` (CLAUDE.md migration conventions — pinned `search_path` on every SECURITY DEFINER function). The only change to the body is the `SET` clause of the UPDATE:

```
update public.invitations
   set used = true,
       profile_id = auth.uid()        -- NEW: link the invite to the registering profile
 where id = p_invitation_id
   and lower(email) = lower(p_email)
   and used = false
   and (expires_at is null or expires_at > now());
```

- `auth.uid()` is the freshly-authenticated registering user, whose `profiles.id == auth.users.id` (the profile is created with `id = authData.user.id` in `registerInvitedUser`). The existing `if auth.uid() is null then return false; end if;` guard above stays — `auth.uid()` is guaranteed non-null past that line, so we never write the sentinel or NULL here.
- The `where used = false` predicate is unchanged, so the function remains idempotent: a second consume of an already-used invite updates zero rows and returns `false`, exactly as today. It will not overwrite a previously-set `profile_id`.
- Re-grant is **not** required (`CREATE OR REPLACE` preserves the existing `grant execute … to authenticated`), but the developer SHOULD re-issue `grant execute on function public.consume_invitation(uuid, text) to authenticated;` in the migration for self-documentation / drift-safety (it is a no-op if already granted). Do NOT grant to `anon` — consume requires `auth.uid()`.

**(b) One-time idempotent backfill** of existing used invites, in the same migration, AFTER the function redefinition:

```
update public.invitations inv
   set profile_id = u.id
  from auth.users u
 where inv.used = true
   and inv.profile_id = '00000000-0000-0000-0000-000000000000'::uuid   -- sentinel only; never overwrite a real link
   and lower(inv.email) = lower(u.email)
   and exists (select 1 from public.profiles p where p.id = u.id);      -- only link if a profile actually exists
```

Design decisions baked into that statement, addressing the three cases the user named:

- **(a) case normalization** — `lower(inv.email) = lower(u.email)`. `consume_invitation` already lowercases on write, and `createInvite` lowercases on insert, but `auth.users.email` casing is not guaranteed, so both sides are lowered defensively.
- **(b) multiple invitations sharing an email (resends)** — the `profile_id = sentinel` predicate means each matching row is set to the same `u.id`. Resends for the *same person* all point at that person's profile, which is correct (they are all "this user's invite"). We deliberately do NOT try to pick "the most recent" — every used invite for `bob@x.com` belongs to Bob's profile, and `fetchBrandAdmins`' name/id maps are last-write-wins over the set anyway (see §4). A used invite whose email belongs to a *different* current auth user is impossible (email is unique in `auth.users`).
- **(c) invites whose email has no auth user (never registered, or user later deleted)** — excluded by the `exists` join on `profiles` (and implicitly by the inner join to `auth.users`). They keep the sentinel; they are pending-or-orphan invites and are out of this fix's path.
- **idempotent / safe to re-apply** — the `profile_id = sentinel` guard means a second run matches zero rows (everything resolvable is already resolved). Re-applying the migration (e.g. `db reset`) is a no-op on already-linked rows. Combined with `CREATE OR REPLACE` on the function, the whole migration is re-runnable.

**NOT NULL interaction:** the backfill only ever sets `profile_id` to a concrete `auth.users.id` (never NULL/sentinel), so it cannot violate the NOT NULL constraint. No constraint change is needed and none is proposed.

**Rollout safety:** additive. On prod apply the backfill runs once and resolves the 4 currently-registered accounts' invites (all `used = true` per the prod confirmation). New registrations from then on are linked live by the redefined function. No lock concern of note — `invitations` is a tiny table.

### 2. RLS impact

**None.** No new tables, no policy changes.

- `consume_invitation` is `SECURITY DEFINER` and runs as its owner, so the new `profile_id = auth.uid()` write bypasses the `invitations` UPDATE policy exactly as the existing `used = true` write already does. No policy edit needed.
- The backfill runs inside the migration as the `postgres` superuser (RLS does not apply to the table owner / superuser), and reading `auth.users` from a migration is permitted for the same reason. This is the standard pattern; cf. `staff_brand_id_backfill` and `legacy_permissive_policy_dropout` which both read `auth.users` in-migration.
- The admin-only SELECT/INSERT/UPDATE/DELETE policies on `invitations` (from `20260424211733_security_fixes.sql` + the super_admin broadening in `20260514150000`) are unchanged. `fetchBrandAdmins` reads `invitations` under the existing admin SELECT policy — no change to what an admin can see.

### 3. API contract

**`consume_invitation(p_invitation_id uuid, p_email text) → boolean`** — signature unchanged. Return semantics unchanged (`true` = one row consumed, `false` = nothing matched / already used / expired / unauthenticated). The only observable difference is that on success the row's `profile_id` is now the caller's id instead of the sentinel. The single caller — `registerInvitedUser` ([src/lib/auth.ts:402](../src/lib/auth.ts)) — already ignores the boolean and needs **no change**. PostgREST RPC; no shape change, no new error case.

No new PostgREST tables/views, no new RPC.

### 4. `src/lib/db.ts` surface

**No new exported helper. No signature change. No new TS types.** The fix is internal to the existing `fetchBrandAdmins(brandId: string): Promise<User[]>` ([db.ts:3225](../src/lib/db.ts)). The change is the "Option A" split of the dual-purpose `invites` array:

**(A.1) Drop the `.eq('used', false)` filter on the invitations query** ([db.ts:3240](../src/lib/db.ts)) so the query returns ALL brand invitations. The select list (`id, email, name, role, store_ids, brand_id, used, expires_at, profile_id`) already includes `used` and `profile_id`, so no select change is needed — `used` is now actually consulted instead of being pre-filtered.

**(A.2) Build `inviteByProfileId` / `inviteByName` from ALL invites** (the loop at [db.ts:3272-3279](../src/lib/db.ts) already iterates the full `invites` array — it requires no change once the query stops filtering). With B populating `profile_id`, the sentinel guard at [db.ts:3275](../src/lib/db.ts) (`inv.profile_id !== '00000000-…'`) now does real work: registered users' invites land in `inviteByProfileId`. The existing precedence at [db.ts:3286](../src/lib/db.ts) — `inviteByProfileId.get(p.id) ?? inviteByName.get(p.name)` — is **already correct** for A+B: id-match wins (eliminating the same-display-name fragility the comment frets about), name-match is the fallback for legacy/sentinel rows the backfill could not resolve (e.g. an invite whose auth user was deleted — though those won't match a live profile either). **No change to line 3286.**

**(A.3) Build the synthetic pending rows from only the `!used` subset.** The pending-row block at [db.ts:3305-3319](../src/lib/db.ts) currently maps over the full `invites` array (which, today, IS only the unused ones because of the dropped filter). To preserve behavior, it must now filter `!inv.used` first. Cleanest shape — derive the subset once and reuse it:

```
// after the maps are built from the full `invites`:
const pendingInvites = invites.filter((inv: any) => !inv.used);
// …
const pendingRows: User[] = pendingInvites
  .filter((inv: any) => !activeEmails.has(inv.email.toLowerCase()))
  .map(/* unchanged */);
```

**Dedup confirmation (AC #4 / #5):** the existing email dedup at [db.ts:3304-3306](../src/lib/db.ts) (`activeEmails` = lowercased emails of active rows; skip any invite whose email is already active) **still holds and is now strictly more effective**: active rows now actually HAVE emails (that was the bug), so a consumed invite for an already-active user is excluded on TWO independent grounds — (i) it's `used = true` so it's not in `pendingInvites` at all, and (ii) even a hypothetical unused duplicate invite for that email would be caught by `activeEmails`. Row count is unchanged: one row per active profile + one row per genuinely-outstanding (`!used`, not-deduped) invite. No registered user gains a phantom second row.

**(A.4) Correct the misleading comment at [db.ts:3266-3271](../src/lib/db.ts).** It currently claims `profile_id` "is set by `consume_invitation`" (aspirational/false until this spec). After B it becomes TRUE for new registrations and backfilled legacy rows. Reword to state: email is inferred from the invitation row; `profile_id` (set by `consume_invitation` on accept, and backfilled for pre-spec-082 rows) is preferred so same-display-name users don't get swapped emails; name-match is the fallback for any invite whose `profile_id` is still the `00000000-…` sentinel (unresolvable legacy / never-registered). Also drop/repair the "always empty in practice" reality that the spec's root-cause section documented at [db.ts:3267-3271]. (Comment-only; no behavior.)

**snake_case → camelCase mapping:** unchanged. `fetchBrandAdmins` hand-builds `User` objects inline (it does not use a `mapItem` helper); `email` is already mapped from `fallback?.email`. `profile_id` is consumed internally for the map key and never surfaced on the returned `User`, so there is no new field to map.

**Sibling `fetchInvitationsForUserLookup` ([db.ts:120](../src/lib/db.ts)) — IN SCOPE for B's benefit, but NO CODE CHANGE required; verify only.** The function already has no `used` filter and already selects `profile_id`, so it resolves emails today. Its consumers — `fetchAllUsers` / BrandsSection — do the id-vs-name matching on the *caller* side. The developer should:
   - Confirm the helper itself needs no change (it doesn't — it just returns rows).
   - **Verify (read-only) that whatever consumes it in `fetchAllUsers` already prefers `profile_id` over name** the way `fetchBrandAdmins` does. If `fetchAllUsers`' matching is name-only, it AUTOMATICALLY improves once B populates `profile_id` ONLY IF it consults `profile_id`. **Decision: do not refactor `fetchAllUsers` in this spec** (the spec explicitly carves the BrandsSection members tab out of scope at line 61, and it already resolves emails — the same-name fragility there is a pre-existing latent issue, not this bug). If the developer finds `fetchAllUsers` is name-only, note it as a **Minor follow-up**, do not fix it here. This keeps the blast radius to the one buggy loader.

### 5. Edge function changes

**None.** No edge function is created or modified. `consume_invitation` is a PostgREST RPC called from the client via `supabase.rpc` ([auth.ts:402](../src/lib/auth.ts)); no `verify_jwt` / service-token consideration. `sendPasswordReset` and the `delete-user` edge function already behave correctly once `u.email` is populated (spec out-of-scope line 62) — they are not touched.

### 6. Realtime impact

**None.** Users & access uses on-mount + post-action fetch (`loadBrandAdmins` → `fetchBrandAdmins`), not a realtime channel ([UsersSection.tsx:20-23](../src/screens/cmd/sections/UsersSection.tsx); spec out-of-scope line 63). The migration does **not** touch `supabase_realtime` publication membership, so the **publication gotcha does NOT apply** — no `docker restart supabase_realtime_imr-inventory` is needed for this spec. (Flagged explicitly because it's a standard checklist item; here the answer is "no action".)

### 7. Frontend store impact

**None.** `loadBrandAdmins` in [useStore.ts:721-734](../src/store/useStore.ts) calls `db.fetchBrandAdmins` and stores the result under `brandAdminsByBrandId[brandId]`. The shape of the returned `User[]` is unchanged (same fields, `email` now populated). No slice change, no new action, and the **optimistic-then-revert / `notifyBackendError` pattern does NOT apply** — this is a read path, not a mutation. The consumer `UsersSection.tsx` already renders `user.email` at [:344](../src/screens/cmd/sections/UsersSection.tsx) and already gates Reset-PW on `u.email` at [:77](../src/screens/cmd/sections/UsersSection.tsx); both start working the moment `email` is non-empty. **No new `testID`, no JSX change, no copy change.** This is why the dev split is backend-only.

### 8. Tests

- **pgTAP** — new `supabase/tests/consume_invitation_sets_profile_id.test.sql`, hermetic `begin; … rollback;`, modeled on [supabase/tests/invitations_super_admin_rls.test.sql](../supabase/tests/invitations_super_admin_rls.test.sql) (same seeded-user reuse pattern — `profiles.id` FKs `auth.users(id)`, so reuse seed ids `11111111…`/`22222222…`, do NOT mint synthetic profile UUIDs). Cover:
  1. **`consume_invitation` sets `profile_id = auth.uid()`** — insert a fresh invite with `profile_id = '00000000-…'` sentinel and `used = false` for `email = X`; set `request.jwt.claims.sub` to a seeded user id; `set local role authenticated`; call `consume_invitation(id, X)`; assert it returns `true` AND the row now has `profile_id = <that sub>` and `used = true`. (Note: the test reuses the seeded user's id as both the JWT `sub` and the email so `lower(email)=lower(p_email)` matches.)
  2. **Idempotency** — second `consume_invitation` on the now-used row returns `false` and does NOT change `profile_id` (proves the `where used = false` guard).
  3. **Backfill links used invites** — insert a `used = true` invite with sentinel `profile_id` whose `email` matches a seeded `auth.users.email` (e.g. `admin@local.test`); run the SAME backfill UPDATE statement the migration ships; assert the row's `profile_id` is now that auth user's id. Insert a second `used = true` invite whose email matches NO auth user; assert it KEEPS the sentinel (the `exists`/join exclusion). Because pgTAP can't easily re-run a migration mid-transaction, the test should execute the backfill UPDATE inline (copy of the migration statement) — flag in a comment that the inline copy must stay byte-identical to the migration's statement (same drift discipline CLAUDE.md applies to the escapeHtml mirrors).
  4. **Backfill idempotency** — run the backfill UPDATE a second time; assert it affects the already-resolved row's `profile_id` not at all (re-run safety).
  - Runner: [scripts/test-db.sh](../scripts/test-db.sh) walks `supabase/tests/*.test.sql`; the new file is auto-picked-up. Gated by [.github/workflows/test.yml](../.github/workflows/test.yml).

- **jest** — extend / add a unit test for the `fetchBrandAdmins` row-shaping (the spec's jest track). Because `fetchBrandAdmins` calls `supabase.from(...).select(...).eq(...)`, the test mocks the supabase client (mirror whatever existing `db.ts` jest test does for query-builder mocking — search for an existing `db.*.test.ts` pattern). Fixture covers:
  - (a) a registered profile with a `used = true`, name-matching invite → resolves a **non-empty** email (the headline bug). 
  - (b) **id-match precedence over name-match** — two active profiles share a display name; their invites carry distinct `profile_id`s matching each profile's id → each profile gets ITS OWN email, not the other's (proves [db.ts:3286](../src/lib/db.ts) id-first ordering with B in play).
  - (c) an unused invite still yields exactly one pending row; a `used = true` invite for an already-active user does NOT duplicate (AC #4/#5).
  - (d) a `used = true` invite whose `profile_id` is still the sentinel but whose `name` matches an active profile → still resolves by name fallback (proves the legacy/unbackfillable path).
- **No-regression:** `userPermissions.test.ts` and the InviteUserDrawer tests exercise role-derivation and invite *creation*, not `fetchBrandAdmins`' email inference or `consume_invitation`'s `profile_id` write — they should not break. The developer should run the full `npm test` to confirm.

**Open question for the PM / test-engineer (should-fix on the spec, NOT a build blocker):** AC #1 names "the 4 reported prod accounts ... in the local prod-mirror seed" as the verification fixture, but [supabase/seed.sql](../supabase/seed.sql) contains **zero invitation rows** and only 3 `@local.test` users — so the seed cannot demonstrate the fix. The design verifies via hermetic jest + pgTAP fixtures instead. If the team wants a live local-seed demonstration (e.g. for the optional Playwright E2E in AC's test notes), the seed must first be amended to add a registered user WITH a name-matching `used = true` invitation (and, post-B, a populated `profile_id`). Recommend either (i) the test-engineer adds that seed row in a follow-up, or (ii) AC #1's "in the local prod-mirror seed" clause is relaxed to "in the test fixtures." Flagging, not auto-deciding.

### 9. Documented out-of-scope gap (user-accepted)

**Accounts created WITHOUT a name-matching invitation — notably the bootstrap `super_admin` — will still show "(email not loaded)" after this fix.** Prod-confirmed: the super_admin has no matching invitation row, so neither A (name-match) nor B (`profile_id` link, which is only ever set by `consume_invitation` for invitation-based registrations) can supply its email. The backfill cannot help either — there is no invitation row to link. **The user explicitly accepted this gap.** The future path if they ever want it is **Option C** (an `email` column on `profiles`, backfilled from `auth.users` via a service-role/edge path, kept in sync on registration) — out of scope here, would require a new migration + a service-role read of `auth.users` (admins cannot read `auth.users` under RLS).

### 10. Security review of the migration (CLAUDE.md conventions)

- **SECURITY DEFINER `search_path`** — `consume_invitation` keeps `set search_path = public` (required for every SECURITY DEFINER function per CLAUDE.md). The `CREATE OR REPLACE` must re-state the `SET search_path = public` clause or it is lost; the developer must include it verbatim.
- **`auth.uid()` write target** — writing `profile_id = auth.uid()` is safe: `auth.uid()` is non-null past the existing guard, is server-derived (not caller-supplied), and equals the registering profile's id by construction. No injection surface; `p_invitation_id` / `p_email` are already parameterized and the existing `lower(email)=lower(p_email)` + `id =` predicates are unchanged.
- **Backfill `auth.users` read** — reading `auth.users` in a migration is acceptable (runs as `postgres`; same pattern as `staff_brand_id_backfill`). It is one-time, additive, and does not expose `auth.users` to any client path.
- **No new grants** beyond re-affirming the existing `grant execute … to authenticated` on `consume_invitation`. Specifically NOT granted to `anon`. No new table/column → no new RLS to write.
- **No destructive op** → the last-of-role / self-guard conventions (CLAUDE.md) do not apply (this is not a role-change or deletion path).
- **No edge-function parity** concern (no edge function touched), no HTML-email escaping concern (no email body rendered).

### 11. Risks and tradeoffs (explicit)

- **Migration ordering.** `20260531000000` sorts after `20260530000000` and after all `20260528*` migrations — clean tail append, no reordering of applied prod migrations. The `db-migrations-applied` drift gate will see one new local migration not yet in prod → the user MUST run `npx supabase db push --linked` post-merge (see prod-apply note). After push, both CI gates should be green; per CLAUDE.md, confirm the latest `test.yml` run on `main` is green after the push.
- **Backfill correctness on prod.** Relies on `auth.users.email` being populated and matching (lowercased) the invitation email. The prod confirmation (4 accounts each have a name-matching `used = true` invite) strongly implies the emails match; the `lower()` on both sides covers casing. Worst case for an unmatched row: it keeps the sentinel and falls back to name-match in `db.ts` — i.e. it degrades to today's behavior for that row, never worse.
- **Same-name fragility is reduced, not the new bug.** Before B, name-match could swap emails between two same-named users; after B the id-match path wins for any backfilled/newly-registered row, so the swap can only happen for rows the backfill couldn't resolve (no auth user) — which also can't be active profiles, so the practical risk is nil.
- **Performance on the 286 KB seed dataset.** `invitations` is tiny (single digits to low hundreds of rows in prod; zero in seed). Dropping the `used = false` filter in `fetchBrandAdmins` fetches a few extra rows per brand — negligible. The backfill is a single small UPDATE. No index needed.
- **Edge function cold-start** — N/A, no edge function involved.
- **`app.json` slug** — untouched; this spec has no native/identity surface.
- **Seed/test-fixture gap** (§0.2 / §8 open question) — the only genuine wrinkle; surfaced to the PM/test-engineer, does not block the backend build.

## Handoff
next_agent: backend-developer
prompt: Implement Spec 082 against the design above — A+B, backend-only. (1) New
  migration supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql:
  CREATE OR REPLACE consume_invitation to also set profile_id = auth.uid() (keep
  SECURITY DEFINER + SET search_path = public verbatim; re-affirm the
  authenticated grant), then the one-time idempotent backfill UPDATE (sentinel-only
  guard, lower(email) join to auth.users, exists-join to profiles) per §1. (2)
  src/lib/db.ts fetchBrandAdmins: drop the .eq('used', false) filter, build the
  pending rows from a !used subset, leave the inviteByProfileId ?? inviteByName
  precedence at :3286 as-is, and rewrite the false :3266-3271 comment per §4.
  Verify (read-only, do NOT refactor) fetchInvitationsForUserLookup / fetchAllUsers
  per §4. (3) Tests: new pgTAP supabase/tests/consume_invitation_sets_profile_id.test.sql
  (4 arms per §8) and the jest fetchBrandAdmins inference test (4 cases per §8);
  confirm npm test still passes userPermissions / InviteUserDrawer. Note for the
  user in your handoff: post-merge requires `npx supabase db push --linked` (the
  backfill resolves existing registered users at apply time). There is NO frontend
  surface — UsersSection already renders user.email correctly. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/082-users-section-email-not-loaded-fix.md

---

## Files changed

### Migrations
- `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql` — NEW. (a) `CREATE OR REPLACE public.consume_invitation(uuid, text)` keeping the exact existing shape (boolean / plpgsql / SECURITY DEFINER / `SET search_path = public` / the `auth.uid()` null-guard / `get diagnostics` → `return v_updated > 0`), changing ONLY the UPDATE `SET` clause to also set `profile_id = auth.uid()`; re-affirms `grant execute … to authenticated` (no anon grant). (b) one-time idempotent backfill `do $$ … $$` block linking pre-existing used+sentinel invites to registered profiles via `invitations.email → auth.users.email → auth.users.id (= profiles.id)`, sentinel-guarded (`profile_id = '00000000-…'`) + `exists`-join to `public.profiles`, with a `raise notice` count breadcrumb (mirrors the spec-069/075 style).

### src/lib/db.ts
- `fetchBrandAdmins` (~3225-3329) — Option A read fix: (A.1) dropped `.eq('used', false)` from the invitations query so email inference sources from ALL brand invitations; (A.3) build the synthetic pending rows from a new `pendingInvites = invites.filter(!used)` subset so consumed invites never become phantom pending rows (existing `activeEmails` dedup preserved); (A.4) rewrote the false `:3266-3271` comment to state profile_id is set by `consume_invitation` as of spec 082 and legacy rows are linked by the 082 backfill, with name-match as the sentinel fallback. The `inviteByProfileId ?? inviteByName` precedence and the maps' build-from-full-`invites` loop are unchanged (per §4). Read-only verification (no change): `fetchInvitationsForUserLookup` (~120) already has no `used` filter + selects `profile_id`; `fetchAllUsers` (in `src/lib/auth.ts` ~471-485) already prefers `profile_id` over name — both auto-benefit from B with no edit. No Minor follow-up surfaced.

### Tests
- `supabase/tests/consume_invitation_sets_profile_id.test.sql` — NEW pgTAP, hermetic `begin; … rollback;`, `plan(7)`. Arm A: `consume_invitation` as an authed user sets `profile_id = auth.uid()` + `used=true`. Arm B: idempotency — second consume returns `false`, no overwrite. Arm C: backfill links a used+sentinel invite to the matching profile AND leaves a no-matching-auth-user invite on the sentinel. Arm D: backfill idempotency. The inline backfill UPDATE is byte-identical to the migration's (drift note in the header).
- `src/lib/db.fetchBrandAdmins.test.ts` — NEW jest, 5 cases (4 inference + empty-brandId guard): (a) registered user's used invite resolves a non-empty email (the bug); (b) id-match precedence over name-match for two same-display-name profiles; (c) unconsumed invite → one pending row, consumed invite for an active user → no duplicate; (d) sentinel profile_id → name-match fallback.

### Verification
- Migration applied to LOCAL via `npx supabase db reset` — clean; `082: backfilled profile_id on 0 legacy used invitation(s)` notice fired (0 expected — local seed has no invitations). Confirmed live `consume_invitation` now sets `profile_id`, is SECURITY DEFINER, `search_path=public`.
- `npm run test:db` → 39/39 DB test files pass (was 38; +1 new file).
- `npx jest` → 42 suites / 402 tests pass (was 41 suites; +1 new file). `userPermissions` + InviteUserDrawer/EODCount unaffected.
- `npx tsc --noEmit -p tsconfig.json` → exit 0.

### NOT changed
- No frontend surface (`UsersSection.tsx` already renders `user.email`). No store change. No edge function. No `supabase_realtime` publication change → realtime restart ritual does NOT apply.

### Post-merge action required (user)
- This adds a prod migration. Run `npx supabase db push --linked` post-merge. The backfill resolves EXISTING registered users' emails at apply time (no per-user action). The drift gate will flag the new local-only migration until pushed. Per CLAUDE.md, confirm the latest `test.yml` run on `main` is green after the push.

### Documented out-of-scope (user-accepted, spec §9)
- Accounts created WITHOUT a name-matching invitation — notably the bootstrap `super_admin` — stay "(email not loaded)" (no invitation row to link; A+B cannot supply their email). Future path is Option C (email-on-`profiles`).

### Flagged for security-auditor (NOT introduced by this spec)
- `consume_invitation` carries pre-existing `EXECUTE` grants to `PUBLIC` and `anon` (verified in `pg_proc` / `routine_privileges` on local). These predate spec 082 — `CREATE OR REPLACE` preserved them; the design (§1a, §10) directed me to re-affirm only the `authenticated` grant and NOT to grant anon, which I followed. The function's internal `if auth.uid() is null then return false` guard makes anon callers a no-op. I did not revoke the pre-existing PUBLIC/anon grants because that is outside this spec's scope and the design did not direct it — surfacing for the auditor's call rather than silently changing the grant surface.
