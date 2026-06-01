# Spec 083: Fix "(email not loaded)" for registered users — NULL-brand invitations hide email inference (the REAL loader)

Status: READY_FOR_REVIEW

## Background / corrected root-cause narrative

This is the **second attempt** at fixing the admin **Users & access** "(email not loaded)" bug. Spec 082 (shipped, applied to prod) fixed a *different* loader — `fetchBrandAdmins` in `src/lib/db.ts`, which feeds the **Brands** tab detail pane. That was a real, correct fix for the Brands tab: it dropped a `.eq('used', false)` filter, added a `consume_invitation` → `profile_id` link, and backfilled `profile_id` on legacy used invitations. **That `profile_id` linkage infrastructure is correct and prod-confirmed; spec 083 treats it as landed infrastructure and builds on it.**

But the screen the user is actually complaining about — `src/screens/cmd/sections/UsersSection.tsx` — does **not** call `fetchBrandAdmins`. It calls `fetchAllUsers` (`src/lib/auth.ts:440`), which never had a `used` filter, so spec 082 never touched the actual broken code path. The user (a super_admin) still reports: "super admin still dont see the emails of others users." Two affected prod users: **Bobby** (an admin) and **Charles** (a user). Reset-Password and Delete on those rows also break because `UsersSection.tsx` bails when `u.email` is empty (`UsersSection.tsx:77` for reset; the same empty-email guard gates delete).

### The real, prod-verified root cause: NULL-brand invitations

`profiles` has no email column — email is **inferred** from the `invitations` table. The chain for the affected screen:

1. `UsersSection.tsx:44-52` calls `fetchAllUsers(opts)` with `opts.brandId = brand?.id` (or `undefined` for the super_admin all-brands view).
2. `fetchAllUsers` (`src/lib/auth.ts:440`) calls `fetchInvitationsForUserLookup(opts?.brandId)` (`src/lib/db.ts:120-129`) to get invitation rows, then maps each profile to an email: it indexes invitations by `profile_id` (winning) then by `name` (fallback), and sets `email: invitation?.email || ''` (`src/lib/auth.ts:483-502`). Empty string renders as "(email not loaded)" in the UI.
3. `fetchInvitationsForUserLookup(brandId?)` runs `supabase.from('invitations').select('email, profile_id, name, brand_id')` and, **when a `brandId` is passed, adds `.eq('brand_id', brandId)`** (`src/lib/db.ts:124-125`).

Prod queries (PII-free aggregates, verified by the user) confirmed: every name-matching invitation for Bobby and Charles has **`brand_id = NULL`** (`invite_brand_null = 2` for each), while their `profiles.brand_id` is a real brand (`profile_brand_null = 0`). So whenever a brand is selected/scoped, the `.eq('brand_id', brandId)` filter **excludes their NULL-brand invitations**, the email lookup misses, and the row renders "(email not loaded)".

This is the same **NULL-brand bug class** fixed before in specs 068/069 (on the `profiles`/staff side); spec 083 is the same class landing on the `invitations` table.

### Note on the super_admin all-brands case

When `brand?.id` is null, `fetchAllUsers(undefined)` is called and **no** brand filter is applied — so the NULL-brand invites *should* resolve there. The user still seeing "(email not loaded)" as super_admin suggests either (a) a brand IS selected in their session, or (b) a secondary path. The architect should confirm which, but the backfill (Part 1 below) fixes it robustly regardless of which view is active, and the filter relaxation (Part 2) makes the inference resilient to any future NULL-brand invitation in either view.

## User story

As a **super_admin (and any brand admin) in the Users & access section**, I want **every registered user's email to render correctly**, so that **I can see who each row is and successfully run Reset-Password and Delete on those users** instead of being blocked by an empty-email guard.

## Acceptance criteria

Data / migration (backfill):
- [ ] After the migration, for every `invitations` row where `brand_id IS NULL` **and** the invitation is linked to a profile (via `profile_id` ≠ sentinel `00000000-0000-0000-0000-000000000000`, falling back to a `name` match against `profiles.name`) **and** that linked profile has a non-NULL `profiles.brand_id`, the invitation's `brand_id` equals the linked profile's `brand_id`. Stated as a checkable invariant: an invitation resolvable to a profile with brand X has `brand_id = X` (no longer NULL).
- [ ] The migration is idempotent: a second run links/updates zero additional rows (the backfill predicate matches only `brand_id IS NULL` rows, so re-running no-ops).
- [ ] The migration does NOT write NULL or the sentinel back to any column, and does NOT touch `invitations.brand_id` for rows whose linked profile has a NULL brand (nothing to derive — left NULL, matching the accepted bootstrap gap below).
- [ ] The migration does NOT modify any function/RPC body (it is data-only) — OR, if the architect elects a function change, grants are re-affirmed and an anon-lockdown check applies. (Default expectation: data-only DO block, no function change.)
- [ ] Migration file timestamp sorts AFTER `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082) — clean tail append, no reordering of applied prod migrations.

Query relaxation (TS):
- [ ] `fetchInvitationsForUserLookup` returns an invitation row that matches a profile by `profile_id` **even when a `brandId` is passed and that invitation's `brand_id` is NULL** (i.e. the brand filter no longer hides a NULL-brand invitation from email inference). The architect finalizes the exact mechanism (drop the `.eq('brand_id', brandId)` on this query, or fetch unfiltered and let the `profile_id`/name join scope).
- [ ] `fetchAllUsers(opts)` returns a non-empty `email` for a profile whose only matching invitation is NULL-brand, in BOTH the brand-scoped (`opts.brandId` set) and all-brands (`opts.brandId` undefined) calls.

UI behavior (consequence, verified manually — see test notes):
- [ ] In Users & access, Bobby and Charles render their email (not "(email not loaded)") in both the super_admin all-brands view and a brand-scoped view.
- [ ] Reset-Password and Delete are no longer blocked by the empty-email guard for those rows.

## In scope

- A new idempotent migration that **backfills `invitations.brand_id`** from each linked profile's `brand_id` for rows where the invitation's `brand_id` is NULL but the linked profile (via `profile_id`, falling back to `name` match) has a real brand. Same shape/posture as the spec 069 NULL-brand backfill (`supabase/migrations/20260528020000_staff_brand_id_backfill.sql`) and the spec 082 backfill DO block.
- **Relaxing the brand filter** on the email-inference query `fetchInvitationsForUserLookup` (`src/lib/db.ts:120-129`) so a NULL/odd `brand_id` can never hide a user's own invitation. The per-user `profile_id`/name match already scopes the lookup to the correct person, so `.eq('brand_id', brandId)` is over-scoping for the purpose of *email inference*.
- A pgTAP test asserting the post-backfill `brand_id` linkage invariant (DB track).
- A jest test asserting the relaxed query/`fetchAllUsers` behavior — a NULL-brand invitation matched by `profile_id` resolves an email even when a `brandId` is supplied (jest track).

## Out of scope (explicitly)

- **Re-touching `fetchBrandAdmins` or `consume_invitation` / its used-filter — spec 082 territory.** The architect MAY *flag* whether `fetchBrandAdmins` (`src/lib/db.ts:3225`, which carries the same `.eq('brand_id', brandId)` shape on its invitations read) warrants the same relaxation as a follow-up, but the primary and only required target for this spec is `fetchInvitationsForUserLookup`/`fetchAllUsers`. Do not modify `consume_invitation` (spec 082 already linked `profile_id` correctly).
- **The bootstrap super_admin who was created with NO invitation row at all** will still show "(email not loaded)" — there is simply no invitation to infer an email from. Known, accepted gap, not part of this fix. The backfill and relaxation cannot help a user who has zero invitation rows.
- **Adding an email column to `profiles`** — large schema change; explicitly not doing this. Email inference via `invitations` remains the model.
- **Changing `app.json` slug** — untouched; not relevant to this fix, noted for completeness.
- **Realtime** — `UsersSection.tsx` deliberately uses no realtime channel (on-mount + post-action fetch per its own header comment); this spec adds none.

## Open questions resolved

- Q: Which loader is actually broken — `fetchBrandAdmins` (spec 082) or `fetchAllUsers`? → A: `fetchAllUsers` (`src/lib/auth.ts:440`) via `fetchInvitationsForUserLookup` (`src/lib/db.ts:120-129`). Confirmed by reading `UsersSection.tsx:44-52`, which imports and calls `fetchAllUsers`, never `fetchBrandAdmins`.
- Q: What is the root cause? → A: NULL-brand invitations. Bobby's and Charles's name-matching invitations carry `brand_id = NULL` while their profiles carry a real brand; the `.eq('brand_id', brandId)` filter on the inference query excludes those rows when a brand is scoped. Prod-verified via PII-free aggregates.
- Q: Backfill, query relaxation, or both? → A: **Both** (belt-and-suspenders). The backfill repairs the data so even brand-scoped views resolve; the filter relaxation makes inference resilient to any future NULL-brand invitation. Recommended together unless the architect finds a reason to split.
- Q: Why does Bobby (an admin) even have NULL-brand invitations, given admin invites are supposed to carry a non-NULL `brand_id` (the spec 012b/`profiles_role_brand_consistent` invariant)? → A: An anomaly in the historical invite data (pre-012b invites, or resend/legacy rows that predate the column). It does NOT change the fix — the backfill repairs them from the linked profile's brand. Flagged for the architect to note, not to chase.
- Q: Does the super_admin all-brands view need a separate code path? → A: No. The all-brands call already passes no brand filter, so NULL-brand invites should resolve there; the backfill + relaxation cover both views. The architect should confirm whether a brand is selected in the reporting user's session, but the fix is robust either way.
- Q: Is `invitations.profile_id` nullable? → A: No. Per spec 082 §0, it is NOT NULL with sentinel default `00000000-0000-0000-0000-000000000000`. "Unlinked" means `== sentinel`. The backfill must treat the sentinel (not literal NULL) as "unlinked" when deciding the `profile_id` join, and fall back to `name` match for sentinel-still rows.

## Dependencies

- **Spec 082 (landed):** `consume_invitation` now sets `profile_id = auth.uid()` on consume, and `20260531000000_consume_invitation_sets_profile_id.sql` backfilled `profile_id` on legacy used invitations. This makes the `profile_id` join the **primary** backfill path for spec 083; the `name`-match fallback covers any invitation still carrying the sentinel.
- `invitations` table with columns `email, name, role, brand_id, profile_id, used, expires_at` — `supabase/migrations/20260510000000_invitations_brand_id.sql` (added `brand_id`, nullable, FK to `brands(id)` on delete cascade).
- `profiles.brand_id` (the backfill source) and the `profiles_role_brand_consistent` CHECK — `supabase/migrations/20260509000000_multi_brand_schema_rls.sql`.
- Template for the backfill DO block + posture (pre-flight notices, post-backfill invariant assertion, idempotency, "no realtime change" note): `supabase/migrations/20260528020000_staff_brand_id_backfill.sql` (spec 069) and the backfill half of `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082).
- Affected TS: `src/lib/db.ts` (`fetchInvitationsForUserLookup`, ~lines 120-129), `src/lib/auth.ts` (`fetchAllUsers`, ~lines 440-510), consumed by `src/screens/cmd/sections/UsersSection.tsx`.
- Prod apply: user runs `npx supabase db push --linked` after merge. The `db-migrations-applied` drift gate will flag one new local migration not yet in prod until then.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI — `src/screens/cmd/sections/UsersSection.tsx` (admin Users & access). No legacy surface (spec 025 deleted `AdminScreens.tsx`).
- **Per-store or admin-global:** Admin-global users surface, but the data is **brand-scoped** in the brand-selected view (`fetchAllUsers({ brandId })`) and all-brands for super_admin. The bug is precisely an over-scoping of the email-inference sub-query to brand. The fix relaxes that sub-query's brand scope for the narrow purpose of email inference; it does NOT loosen the brand scope of the `profiles` query itself (`fetchAllUsers` still filters profiles by `brand_id` when supplied — `src/lib/auth.ts:446-448`).
- **Edge function or PostgREST:** PostgREST. No edge function involved. The migration is a data-only backfill (no RPC change expected); if the architect elects an RPC change instead of a raw TS query relaxation, the anon-lockdown grant convention (spec 005) applies.
- **Realtime channels touched:** None. `UsersSection` uses no realtime; the migration changes no `supabase_realtime` publication membership → the `docker restart supabase_realtime_imr-inventory` ritual does NOT apply (call out so it is not cargo-culted).
- **Migrations needed:** Yes — one new idempotent backfill migration, timestamp AFTER `20260531000000`.
- **Edge functions touched:** None.
- **Web/native scope:** Both (the loader is shared TS; no web-only or native-only surface). No CSS/web-push involved.
- **Tests (spec 022 tracks):** pgTAP (assert post-backfill `invitations.brand_id` linkage invariant) + jest (assert relaxed `fetchInvitationsForUserLookup`/`fetchAllUsers` resolves a NULL-brand invitation matched by `profile_id` when a `brandId` is passed). No shell-smoke track needed.
- **app.json slug:** Untouched (`towson-inventory` remains; not relevant here).

---

## Backend design (architect)

Backend-only. Two artifacts: (1) one idempotent data-only migration backfilling
`invitations.brand_id` from the linked profile, (2) a one-line relaxation of the
`fetchInvitationsForUserLookup` PostgREST query in `src/lib/db.ts`. Plus a pgTAP
arm and a jest arm. No RLS / edge-function / realtime / frontend changes.

### 0. Decisions the PM left to the architect — finalized

| Decision | Verdict |
|---|---|
| **Relaxation mechanism for `fetchInvitationsForUserLookup`** | **Drop the `.eq('brand_id', brandId)` entirely** on this query; keep the `brandId?` parameter in the signature (no caller change — see §4). Rationale below. |
| **Backfill predicate** | Two UPDATE statements: **(1) `profile_id` join** (sentinel-aware) as the primary path, **(2) name-match fallback** for sentinel-still rows, with an **exactly-one-profile** ambiguity guard so a duplicate display name across brands is skipped, not mis-stamped. Derive `brand_id` from the linked profile; skip rows whose linked profile has NULL brand. |
| **Migration timestamp** | `20260531010000_invitations_brand_id_backfill.sql` — sorts AFTER `20260531000000_consume_invitation_sets_profile_id.sql` (spec 082), clean tail append. |
| **Does `fetchBrandAdmins` warrant the same relaxation?** | **Not-needed for spec 083; recommended as a FOLLOW-UP, not in-scope-now.** Reasoning in §7. |

#### Why drop `.eq('brand_id', brandId)` rather than "fetch unfiltered and let the join scope"

These are the *same outcome* mechanically — dropping the `.eq` IS fetching
unfiltered. Stating it as "drop the `.eq`" makes the one-line diff unambiguous
for the developer. The per-row scoping that actually matters happens on the
**caller** side in `fetchAllUsers` (`src/lib/auth.ts:481-496`): it builds
`invByProfileId` / `invByName` and resolves each profile's email by
`invByProfileId.get(p.id) ?? invByName.get(p.name)`. That join is what ties an
invitation to the *correct person*. The brand filter on the sub-query was only
ever a table-read optimization ("don't pull every tenant's invitations" —
spec 012b cleanup #16), and it is precisely that optimization that hides the
NULL-brand rows. The real brand scoping of *which users appear* is unchanged:
`fetchAllUsers` still filters the **profiles** query by `brand_id`
(`src/lib/auth.ts:446-448`), so a non-super-admin still only sees their brand's
users — they just now resolve emails for those users even when the matching
invitation carries NULL brand.

**Performance note (the only real cost):** dropping the filter means a
brand-scoped Users view now reads the **whole** `invitations` table instead of
one brand's slice. Acceptable: `invitations` is a tiny, low-cardinality table
(a few rows per real user; the 286 KB seed has zero invitation rows). This is
not the `inventory_items` / `eod_submissions` hot path. The post-backfill data
also means most rows now carry a real `brand_id`, but we still drop the filter
for resilience against any *future* NULL-brand invitation (the belt-and-suspenders
the spec asks for). Documented as a deliberate tradeoff, not an oversight.

### 1. Data model changes

**No schema change.** `invitations.brand_id` already exists (nullable, FK to
`brands(id)` on delete cascade — `20260510000000_invitations_brand_id.sql`),
with the partial index `invitations_brand_id_idx` already covering the
backfilled rows. This is a **data-only** backfill — additive, fully reversible
by nulling a `brand_id`, no DDL.

**Proposed migration:** `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql`

Posture mirrors `20260528020000_staff_brand_id_backfill.sql` (spec 069) and the
backfill half of `20260531000000_consume_invitation_sets_profile_id.sql`
(spec 082): a header comment block, pre-flight `raise notice`, the UPDATE(s), a
post-backfill invariant assertion, an idempotency note, and the explicit
"no realtime publication change → no `docker restart` ritual" call-out.

**Backfill SQL — two UPDATEs inside one DO block:**

```sql
do $$
declare
  v_via_profile  int;
  v_via_name     int;
  v_ambiguous    int;
  v_remaining    int;
begin
  -- ── Pre-flight: ambiguous name-only rows (defense-in-depth notice).
  --    Count NULL-brand, sentinel-profile_id invitations whose name matches
  --    >1 profile carrying DISTINCT non-null brands. These are deliberately
  --    LEFT NULL by UPDATE #2's exactly-one guard (cannot safely pick a brand).
  select count(*) into v_ambiguous
  from public.invitations i
  where i.brand_id is null
    and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
    and (
      select count(distinct p.brand_id)
        from public.profiles p
       where p.name = i.name
         and p.brand_id is not null
    ) > 1;
  if v_ambiguous > 0 then
    raise notice
      '083: % NULL-brand sentinel invitation(s) name-match >1 distinct-brand profile — left NULL (ambiguous, cannot derive a single brand)',
      v_ambiguous;
  end if;

  -- ── UPDATE #1 (primary): profile_id join. For NULL-brand invitations
  --    LINKED to a profile (profile_id <> sentinel) whose profiles.brand_id
  --    is non-null, set invitations.brand_id to that profile's brand.
  --    profile_id is NOT NULL with the sentinel default (spec 082 §0); a real
  --    profile_id is unambiguous (one profile per id), so no ambiguity guard
  --    is needed on this path. Predicated on brand_id IS NULL → idempotent.
  update public.invitations i
     set brand_id = p.brand_id
    from public.profiles p
   where i.brand_id is null
     and i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
     and p.id = i.profile_id
     and p.brand_id is not null;
  get diagnostics v_via_profile = row_count;
  raise notice '083: backfilled invitations.brand_id via profile_id on % row(s)', v_via_profile;

  -- ── UPDATE #2 (fallback): name match for SENTINEL-still rows only.
  --    For NULL-brand invitations whose profile_id is STILL the sentinel,
  --    derive brand from a name match against profiles — but ONLY when the
  --    name resolves to EXACTLY ONE distinct non-null brand (the exactly-one
  --    guard). Rows matching 0 or >1 distinct brands are left NULL. The
  --    subquery returns the single distinct brand; the `= 1` cardinality
  --    guard in the WHERE makes the scalar subquery safe.
  update public.invitations i
     set brand_id = (
       select distinct p.brand_id
         from public.profiles p
        where p.name = i.name
          and p.brand_id is not null
     )
   where i.brand_id is null
     and i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
     and (
       select count(distinct p.brand_id)
         from public.profiles p
        where p.name = i.name
          and p.brand_id is not null
     ) = 1;
  get diagnostics v_via_name = row_count;
  raise notice '083: backfilled invitations.brand_id via name fallback on % row(s)', v_via_name;

  -- ── Post-backfill invariant: every NULL-brand invitation that STILL
  --    remains must be unresolvable — i.e. NOT (linked-to-a-branded-profile)
  --    AND NOT (name-matches exactly one branded profile). If any row is
  --    resolvable yet still NULL, the backfill was incomplete → fail closed.
  --    This is the checkable AC, duplicated as a pgTAP arm.
  select count(*) into v_remaining
  from public.invitations i
  where i.brand_id is null
    and (
      -- resolvable via profile_id to a branded profile …
      (i.profile_id <> '00000000-0000-0000-0000-000000000000'::uuid
       and exists (
         select 1 from public.profiles p
          where p.id = i.profile_id and p.brand_id is not null))
      or
      -- … OR resolvable via an unambiguous (exactly-one) name match
      (i.profile_id = '00000000-0000-0000-0000-000000000000'::uuid
       and (
         select count(distinct p.brand_id)
           from public.profiles p
          where p.name = i.name and p.brand_id is not null
       ) = 1)
    );
  if v_remaining > 0 then
    raise exception
      '083: post-backfill invariant violated — % resolvable NULL-brand invitation(s) still have NULL brand_id',
      v_remaining;
  end if;
end $$;
```

**Predicate rationale / edge cases:**
- **Sentinel awareness.** `profile_id` is NOT NULL with sentinel default
  `00000000-0000-0000-0000-000000000000` (spec 082 §0). UPDATE #1 keys off
  `profile_id <> sentinel`; UPDATE #2 keys off `profile_id = sentinel`. The two
  WHERE clauses are mutually exclusive, so no row is touched twice and the order
  of the two UPDATEs does not matter. Bobby/Charles were `profile_id`-linked by
  the spec-082 backfill, so they take the **UPDATE #1** path.
- **Ambiguity (two profiles, same name, different brands).** Decided: **prefer
  the `profile_id` path and skip ambiguous name-only rows.** UPDATE #1 is
  inherently unambiguous (one profile per id). UPDATE #2's `count(distinct
  p.brand_id) = 1` guard means a sentinel row whose name matches profiles in two
  different brands is **left NULL** (flagged by the pre-flight notice), never
  guessed. Same-name profiles in the *same* brand collapse to one distinct
  brand → safely backfilled. This matches `fetchAllUsers`' own precedence
  (`profile_id` wins over name) so the data and the loader agree.
- **NULL-brand profile → skip.** `p.brand_id is not null` on both paths means an
  invitation linked to a profile that itself has NULL brand is left NULL — the
  accepted bootstrap gap (spec 083 AC #3). Nothing to derive.
- **Never writes sentinel/NULL.** Both UPDATEs only ever set `brand_id =
  <concrete non-null brand>`; the `brand_id IS NULL` predicate is the idempotency
  guard (a second run matches zero rows because the just-filled rows are no
  longer NULL).
- **Idempotency.** Re-run links/updates zero additional rows. AC #2 satisfied.

**Local-seed reality:** the 286 KB seed has **zero** invitation rows
(confirmed in spec 082 §0.2 and the spec-082 pgTAP header). So on `db reset`
both UPDATEs report `0 row(s)` and the post-backfill invariant trivially holds
(no rows to violate it). All test fixtures are created in-txn (see §5).

### 2. RLS impact

**None.** No new tables, no policy changes. The migration runs as the migration
role (postgres superuser → bypasses RLS), so the UPDATEs are unaffected by the
`invitations` write policies — the same posture as the spec-069 and spec-082
backfills. The `fetchInvitationsForUserLookup` query change is a client-side
PostgREST `.select`; it does not alter any policy. The CLAUDE.md "permissive
policies are ORed" lint (spec 053) is **not engaged** — no policy text changes.

One sanity note for the developer to confirm, not act on: dropping the brand
filter does not widen what a non-super-admin can *read* from `invitations` —
the `invitations` SELECT policy (012a admin/super-admin gate) already governs
row visibility regardless of the `.eq('brand_id', …)` predicate. The `.eq` was
a client-side narrowing, not a security boundary. A brand admin who could read
brand X's invitations before can read the same set now; they simply no longer
*hide* a NULL-brand row that their own policy already admits. No privilege
change.

### 3. API contract

**PostgREST, unchanged shape.** `fetchInvitationsForUserLookup` keeps reading
`invitations` via `supabase.from('invitations').select('email, profile_id,
name, brand_id')`. The only change is removing the conditional
`.eq('brand_id', brandId)`. No RPC. No request/response-shape change. No new
error cases (the function already swallows errors and returns `data || []`).

### 4. `src/lib/db.ts` surface

**Exact edit — `fetchInvitationsForUserLookup` (`src/lib/db.ts:120-129`):**

Remove the two lines that apply the brand filter:

```ts
    let q = supabase.from('invitations').select('email, profile_id, name, brand_id');
    if (brandId) q = q.eq('brand_id', brandId);   // ← DELETE this line
    const { data } = await q.abortSignal(signal);
```

becomes:

```ts
    const { data } = await supabase
      .from('invitations')
      .select('email, profile_id, name, brand_id')
      .abortSignal(signal);
```

**Signature: keep `brandId?` in the parameter list, do NOT remove it.** Grep
confirms exactly one caller: `fetchAllUsers` at `src/lib/auth.ts:471` passes
`opts?.brandId`. Keeping the (now-ignored) parameter means:
- The one caller compiles with no edit (`fetchAllUsers` is otherwise untouched).
- No churn in the `auth.ts` carve-out.

Update the parameter to reflect it is intentionally accepted-but-ignored:
`brandId?: string` stays, and the **doc comment** must change. The current
comment says "When `brandId` is supplied (cleanup #16) the query is scoped at
the SQL layer" — that is now false and would be a documentation lie. Replace the
relevant lines of the JSDoc with a spec-083 note: the brand filter is
**deliberately not applied** because this query exists only for *email
inference*, and the per-user `profile_id`/name match in `fetchAllUsers` already
scopes the lookup to the correct person; filtering by brand hid NULL-brand
invitations (the spec-083 bug). Keep the `brandId?` param for call-site
compatibility; note it is currently unused.

**snake_case → camelCase mapping:** none changes. This helper already returns
raw snake_case rows (`{ email, profile_id, name, brand_id }`); the camelCase
mapping for the *user* shape happens downstream in `fetchAllUsers`
(`src/lib/auth.ts:498-510`), which is **not** modified.

**`fetchAllUsers` (`src/lib/auth.ts:440`): no code change required.** It already
does the `profile_id`-then-name resolution (`src/lib/auth.ts:481-496`) that
makes the now-unfiltered invitation set resolve correctly. The developer should
**read-only verify** this and not refactor it (same discipline spec 082 applied
to this exact function). The AC "`fetchAllUsers(opts)` returns a non-empty
email … in BOTH brand-scoped and all-brands calls" is satisfied transitively by
the `db.ts` one-liner — no `auth.ts` edit.

### 5. Test contract

#### pgTAP (DB track) — new file `supabase/tests/invitations_brand_id_backfill.test.sql`

Template: `supabase/tests/consume_invitation_sets_profile_id.test.sql` (spec 082)
and `supabase/tests/staff_brand_id_backfill.test.sql` (spec 069) — same
`begin; … rollback;` hermetic isolation, same seeded-user reuse
(`11111111-…` admin, `22222222-…` manager; their `profiles.id` FK `auth.users`),
same `set_config` constant stashing.

**Critical drift-discipline rule (carry the spec-082 header convention):**
pgTAP cannot re-run a migration mid-transaction, so the test executes the
backfill UPDATEs **inline**, and those inline copies MUST stay **byte-identical**
to the two UPDATE statements in the migration's DO block — same rule CLAUDE.md
applies to the `escapeHtml` mirrors and spec 082 applies to its backfill copy.
State this in the test header.

Because the seed has zero invitations, **all fixtures are created in-txn.**
Suggested arms (plan ~6):

1. **fixture sanity** — `isnt(current_setting('test.admin_id'), '')`.
2. **UPDATE #1 (profile_id path)** — insert a NULL-brand invitation with
   `profile_id = <seed manager id>` (a profile whose seed `brand_id` is the seed
   brand `2a000000-…-0001`). Run UPDATE #1 inline. Assert the invitation's
   `brand_id` now equals the manager's `profiles.brand_id`. **The core invariant
   (AC #1).**
3. **NULL-brand profile → left NULL** — set a profile's `brand_id = NULL` in-txn,
   insert a NULL-brand invitation linked to it by `profile_id`, run UPDATE #1.
   Assert the invitation's `brand_id` is **still NULL** (the `p.brand_id is not
   null` guard; AC #3 accepted bootstrap gap).
4. **UPDATE #2 (name fallback, exactly-one)** — insert a NULL-brand,
   sentinel-`profile_id` invitation whose `name` matches exactly one branded
   profile. Run UPDATE #2 inline. Assert `brand_id` = that profile's brand.
5. **UPDATE #2 ambiguity → left NULL** — create two in-txn profiles with the same
   `name` but DISTINCT non-null brands (mint a second brand like the spec-069
   `b1000000-…` fixture), insert a sentinel invitation with that name, run
   UPDATE #2. Assert `brand_id` is **still NULL** (the `count(distinct …) = 1`
   guard).
6. **idempotency** — re-run BOTH inline UPDATEs; assert the row filled in arm 2
   is unchanged (the `brand_id IS NULL` guard excludes it). AC #2.

**No grant / no `set role anon` check.** This migration changes no function and
no grant (data-only). Therefore **no `has_function_privilege` arm and
absolutely no `set role anon` + `throws_ok`** (that is the spec-067 pattern that
segfaults the CI Postgres image — explicitly avoid it). Confirmed: default
data-only expectation holds, no grant check needed.

#### jest (TS track) — new file `src/lib/db.fetchInvitationsForUserLookup.test.ts`

Template: `src/lib/db.fetchBrandAdmins.test.ts` (spec 082) — the same
`jest.mock('./supabase')` per-table-chainable-builder stub, `jest.mock('./inflight')`
`track`-passthrough, `jest.mock('./auth')` light stub. This is the cleanest
locus because `fetchInvitationsForUserLookup` lives in `db.ts` and the assertion
is purely "the brand filter no longer hides a NULL-brand row."

Required arms:
1. **NULL-brand invitation is returned even when `brandId` is passed.** Mock the
   `invitations` table to return one row with `brand_id: null`. Call
   `fetchInvitationsForUserLookup('brand-1')`. Assert the row is in the result
   (pre-fix it would have been filtered out). **The headline assertion (AC for
   the query relaxation).**
2. **`.eq` is not called with `brand_id`** (mechanism pin) — spy on the builder's
   `eq` and assert it was **not** invoked with `('brand_id', …)`. This detects a
   regression that re-adds the filter. (Builder stub already exposes `eq:
   jest.fn().mockReturnThis()`.)

**Optionally** (recommended, higher-value, asserts the end-to-end AC #
"`fetchAllUsers` resolves an email"): a second jest file
`src/lib/auth.fetchAllUsers.test.ts` (template: `src/lib/auth.test.ts` +
`db.fetchBrandAdmins.test.ts`) that **mocks `./db`'s
`fetchInvitationsForUserLookup`** to return a NULL-brand invitation matched by
`profile_id`, mocks `supabase` for the `profiles` / `user_stores` reads, calls
`fetchAllUsers({ brandId: 'brand-1' })`, and asserts the returned `User.email`
is non-empty. This is the literal spec AC ("assert `fetchAllUsers` resolves an
email for a NULL-brand invitation matched by `profile_id` when a `brandId` is
supplied"). Developer's discretion whether to fold this into one file or two;
the spec asks for the `fetchAllUsers` assertion, so **at least one arm must
exercise `fetchAllUsers`**, not only the bare `db.ts` helper.

### 6. Realtime / edge-function / frontend impact

- **Realtime: none.** The migration changes **no** `supabase_realtime`
  publication membership (`invitations` is not a realtime-published table and
  membership is untouched). `UsersSection.tsx` uses no realtime channel
  (on-mount + post-action fetch). Therefore the **`docker restart
  supabase_realtime_imr-inventory` ritual does NOT apply** — flagged here so it
  is not cargo-culted into the deploy steps. This is a deploy/dev concern that is
  simply absent for this spec, not a runtime one.
- **Edge functions: none.** No `verify_jwt` decisions, no service-token logic.
- **Frontend store: none.** `src/store/useStore.ts` is untouched. `UsersSection.tsx`
  consumes `fetchAllUsers` with an unchanged signature; no optimistic-then-revert
  pattern applies (this is a read-path correctness fix, not a mutation). **No
  `frontend-developer` needed** — I concur with the dispatch note.

### 7. `fetchBrandAdmins` — follow-up, not in-scope-now (with reasoning)

`fetchBrandAdmins` (`src/lib/db.ts:3225`) carries the same
`.eq('brand_id', brandId)` shape on its invitations read (`src/lib/db.ts:3242`)
and would have the **symmetric** NULL-brand blind spot: a registered user whose
only invitation is NULL-brand would not have their email resolved in the
**Brands** tab detail pane for a brand-scoped query. The data argument *is*
symmetric.

**Why I still scope it out of spec 083 (recommend as a fast follow-up):**
1. **The spec explicitly lists it out-of-scope** and the user's reported bug is
   the Users & access section (`fetchAllUsers`), not the Brands tab. Spec 082
   just shipped a careful, prod-confirmed fix to `fetchBrandAdmins`; re-touching
   it in the very next spec risks destabilizing freshly-reviewed code for a
   bug **no user has reported on that surface**.
2. **The backfill (Part 1) already repairs the data for both loaders.** After the
   migration, Bobby/Charles carry a real `brand_id` on their invitations, so
   `fetchBrandAdmins`' brand-scoped query resolves them too — the data fix is
   loader-agnostic. The only residual `fetchBrandAdmins` gap is resilience to a
   *future* NULL-brand invitation, which is exactly the same belt-and-suspenders
   we are adding to `fetchInvitationsForUserLookup` — worth doing, but
   independently and with its own pgTAP/jest arm.
3. **`fetchBrandAdmins` is load-bearing differently** — it also builds synthetic
   "pending" rows from the `!used` subset and uses `brand_id` in that row-shaping
   (`src/lib/db.ts:3289+`). Dropping the `.eq` there needs its own analysis of
   whether the unfiltered set pollutes the pending-row construction (e.g. a
   NULL-brand *unconsumed* invite showing up as a pending row in the wrong
   brand). That is more than a one-liner and deserves its own spec slice — not a
   silent ride-along on spec 083.

**Recommendation:** open a follow-up (spec 084-ish) to apply the same relaxation
to `fetchBrandAdmins` *plus* the pending-row-construction analysis. Flagged, not
fixed here.

### 8. Risks and tradeoffs (explicit)

- **Whole-table `invitations` read on brand-scoped Users view** (§0 performance
  note). Accepted — tiny table, not a hot path, justified by resilience. The
  alternative (keep the filter, rely only on the backfill) leaves the loader
  fragile to the next NULL-brand invitation, which is the exact failure class
  spec 083 exists to kill.
- **Migration ordering.** `20260531010000` sorts strictly after spec 082's
  `20260531000000`. This matters because the backfill's **UPDATE #1 depends on
  spec 082's `profile_id` backfill having already run** (that is what links
  Bobby/Charles to their profiles). If the two migrations were reordered, UPDATE
  #1 would find sentinel `profile_id`s and fall through to the weaker name-match
  path. The timestamp ordering guarantees the dependency. The
  `db-migrations-applied` drift gate will flag one new local migration not yet in
  prod until the user runs `npx supabase db push --linked` post-merge (expected,
  noted in the spec's Dependencies).
- **Name-match ambiguity residue.** Rows left NULL by the exactly-one guard
  (two same-name profiles, different brands, sentinel `profile_id`) stay NULL and
  still render "(email not loaded)" for that user in a brand-scoped view *if*
  their invitation is also NULL-brand AND their `profile_id` was never linked.
  This is a genuinely-unresolvable case (we cannot know which brand the
  invitation belonged to) and the pre-flight `raise notice` surfaces the count
  for operator visibility. Prod footprint is expected to be zero (the spec
  identifies only Bobby/Charles, both `profile_id`-linked → UPDATE #1). Accepted,
  flagged.
- **The Bobby-is-an-admin anomaly** (why an admin has NULL-brand invitations at
  all, vs. the `profiles_role_brand_consistent` invariant). The spec's open
  questions flag this as historical invite-data drift, "to note, not to chase."
  The backfill repairs it from the linked profile's brand regardless of how it
  arose; no action.
- **RLS gap: none identified.** §2 covers why dropping the client-side `.eq` is
  not a privilege change — the `invitations` SELECT policy is the real boundary.
- **Edge-function cold-start: N/A** (no edge function touched).
- **Seed-coverage gap.** The local seed has zero invitations, so the migration is
  a literal no-op on `db reset` and the pgTAP arms must construct every fixture
  in-txn. The migration's own post-backfill `raise exception` invariant therefore
  gets no real-data exercise locally — it is exercised only by the in-txn pgTAP
  arms. This is the same posture spec 082/069 accepted; called out so the
  developer writes genuine in-txn fixtures rather than assuming seed data.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec — (1) the data-only migration
  `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql` (two
  sentinel-aware UPDATEs + ambiguity guard + post-backfill invariant, per §1),
  (2) the one-line relaxation of `fetchInvitationsForUserLookup` in
  `src/lib/db.ts` plus its corrected doc comment (keep the `brandId?` param,
  per §4; do NOT edit `fetchAllUsers` beyond read-only verification), (3) the
  pgTAP file `supabase/tests/invitations_brand_id_backfill.test.sql` with the
  byte-identical-inline-UPDATE discipline (§5), (4) the jest coverage asserting
  a NULL-brand invitation matched by profile_id resolves through
  `fetchInvitationsForUserLookup`/`fetchAllUsers` when a brandId is passed (§5).
  No RLS / edge-function / realtime / frontend changes. After implementation,
  set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/083/spec.md

---

## Files changed

### Migrations (data-only)
- `supabase/migrations/20260531010000_invitations_brand_id_backfill.sql` (new) —
  idempotent two-UPDATE DO block backfilling `invitations.brand_id` from the
  linked profile: UPDATE #1 profile_id join (primary, sentinel-aware), UPDATE #2
  name fallback with the `count(distinct …) = 1` exactly-one guard, pre-flight
  ambiguity `raise notice`, post-backfill `raise exception` invariant. Header
  block per the spec-069/082 posture (bug narrative, two-path predicate,
  sentinel/NULL safety, idempotency, ordering dependency on spec 082, explicit
  "no realtime publication change → no `docker restart`" call-out). No DDL, no
  RLS, no grant change.

### src/lib (query relaxation + read-only verify)
- `src/lib/db.ts` — `fetchInvitationsForUserLookup`: removed the conditional
  `.eq('brand_id', brandId)` so the query reads `invitations` unfiltered; kept
  the now-unused `brandId?` param (zero caller churn — one caller,
  `fetchAllUsers`); rewrote the doc comment to the spec-083 rationale (brand
  filter deliberately not applied; the per-user profile_id/name match scopes
  inference; filtering hid NULL-brand invitations).
- `src/lib/auth.ts` — **read-only verified, NOT modified.** `fetchAllUsers`
  already does profile_id-then-name resolution; the AC is satisfied transitively
  by the db.ts one-liner (confirmed by the new jest arm).

### Tests
- `supabase/tests/invitations_brand_id_backfill.test.sql` (new) — pgTAP,
  `plan(6)`, hermetic `begin; … rollback;`, all fixtures in-txn (seed has zero
  invitations). 6 arms: fixture sanity, UPDATE #1 profile_id fill (core
  invariant), NULL-brand profile left NULL, UPDATE #2 name fallback fill,
  UPDATE #2 ambiguity left NULL (second brand `b1000000-…` minted in-txn),
  idempotency. The two inline UPDATEs are byte-identical (de-indented, per the
  spec-082 convention) to the migration's DO-block statements. No grant /
  `set role anon` arm (data-only).
- `src/lib/db.fetchInvitationsForUserLookup.test.ts` (new) — jest, 2 arms:
  (a) a NULL-brand invitation IS returned when `brandId` is passed (headline
  AC), (b) the builder's `eq` was NOT called with `('brand_id', …)` (mechanism
  pin against re-adding the filter).
- `src/lib/auth.fetchAllUsers.test.ts` (new) — jest, 2 arms exercising
  `fetchAllUsers`: brand-scoped call resolves a non-empty email for a NULL-brand
  invitation matched by profile_id (the literal spec AC), and the all-brands
  (no brandId) call resolves it too.

### Verification (local)
- `npx jest src/lib/db.fetchInvitationsForUserLookup src/lib/auth.fetchAllUsers`
  → 4/4 green. Full jest suite → 44 suites / 406 tests green.
- `npx tsc --noEmit` (base) → exit 0. `npx tsc -p tsconfig.test.json --noEmit`
  (test graph) → exit 0.
- `npm run test:db` → 40/40 DB test files pass (new file + all anchors).
- Migration DO block executed in a rolled-back txn against the local stack →
  both UPDATEs report `0 row(s)` (seed has no invitations), pre-flight notice
  did not fire, post-backfill invariant held (no exception). Exit 0.
- Sanity: migration filename sorts after `20260531000000`; inline pgTAP UPDATEs
  confirmed byte-identical to the migration's.
