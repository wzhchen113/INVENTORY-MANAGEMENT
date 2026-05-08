# Security audit for spec 008

Auditor: security-auditor
Date: 2026-05-08
Scope: Migration `20260508120000_spec008_profiles_sidebar_layout.sql`,
new write paths in `src/lib/db.ts` / `src/store/useStore.ts`, hydration
in `src/lib/auth.ts` / `App.tsx`, new UI in `src/components/cmd/Sidebar.tsx`,
`src/components/cmd/SidebarEditMode.tsx`, `src/lib/sidebarLayout.ts`,
`src/screens/cmd/InventoryDesktopLayout.tsx`, and the three new
`@dnd-kit/*` dependencies in `package.json`.

Verdict: **no Critical findings, no High findings.** The spec is safe
to ship from a security standpoint subject to the Medium/Low items
below — none of them block deploy.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

- `supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql:46-47`
  — **No server-side bound on `sidebar_layout` JSON size or shape.**
  The `jsonb` column accepts arbitrary input; the only validator in the
  pipeline is the client-side `coerceSidebarLayout` in
  `src/lib/auth.ts:23-29` and `isValidOverride` in
  `src/lib/sidebarLayout.ts:46-60`. Both run on read, not write — a
  hostile or buggy client (or a future second admin app sharing the
  same Supabase project) can write a multi-MB JSON blob, deeply nested
  JSON, or items with non-string ids.
  **Impact:** scope is contained — `id = auth.uid()` RLS means a user
  can only mess up their own sidebar (DoS-via-bloat is self-DoS;
  malformed reads are caught by `coerceSidebarLayout` and fall back to
  the hardcoded default; no cross-user leakage). But repeated huge
  writes still consume DB bandwidth on every login (`select('*')` in
  `fetchProfile` at `src/lib/auth.ts:60-64` reads the full row), and
  `notifyBackendError` plus a render-default fallback hide the symptom
  from the user.
  **Fix (cheap, recommended):** add a CHECK constraint to bound size,
  e.g.
  ```sql
  alter table public.profiles
    add constraint profiles_sidebar_layout_size_chk
    check (sidebar_layout is null
           or pg_column_size(sidebar_layout) < 16384);
  ```
  16 KB is ~50× the realistic upper bound for the current 17-item
  sidebar (each entry is ~80 bytes serialized). Optionally also a
  `jsonb_typeof(sidebar_layout) = 'object'` guard. Additive migration,
  no breaking change.
  **Severity rationale:** Medium not High because the user can only
  damage their own UI state, never another user's row (per-user RLS,
  verified below); and the read-side defensive coercion already
  prevents render crashes on malformed data.

### Low

- `src/lib/auth.ts:60-64` — `fetchProfile` does `select('*')` and then
  spreads the profile shape into the `User`/`AuthResult`. This already
  returns the new `sidebar_layout` column as raw JSON to the caller via
  `coerceSidebarLayout`, which is fine. The Low-grade nit: any future
  PII column added to `profiles` will silently flow through `select('*')`
  to wherever the user object goes (logging, error toasts via
  `notifyBackendError`). Not an issue today — informational. Consider
  switching to an explicit column list in a follow-up.

- `App.tsx:165-167` — login hydration calls
  `setSidebarLayoutOverride(result.sidebarLayout)`, which the store
  action treats as a user mutation and immediately writes the just-read
  value back to `profiles.sidebar_layout` (`useStore.ts:1185-1195`).
  This is documented in the comment at `App.tsx:160-164` ("redundant
  UPDATE that writes the just-read value back"). One UPDATE per login
  is acceptable cost, but it does mean a transient DB error on login
  *also* triggers `notifyBackendError('Save sidebar layout', e)` even
  though the user did nothing. Cosmetic, not a security concern. Flag
  for code-reviewer if not already raised. Informational.

- `src/store/useStore.ts:1185-1195` — `setSidebarLayoutOverride` reads
  `userId` from `get().currentUser?.id`, which is the post-login
  trusted store value populated by the `login` action from the
  Supabase session. It does **not** come from a URL param or any
  user-controlled surface. Cross-user write would also be blocked by
  the existing `Users can update own profile` RLS policy
  (`20260502071736_remote_schema.sql:417-422` — `using (id =
  auth.uid())`). Both layers are consistent. **No finding** — this is
  the documented "specifically check #3" item passing.

### Authorization (RLS) — verification of the architect's claim

The architect asserted in design §0.2 that the new `sidebar_layout`
column inherits `profiles`' existing row-level policies for free
because RLS is row-scoped, not column-scoped. **Confirmed by reading
the policies directly:**

`supabase/migrations/20260502071736_remote_schema.sql:372-422` defines:

- `Users can read own profile` — `for select using (id = auth.uid())`
- `Admins can read all profiles` — `for select using (admin/master role
  OR id = auth.uid())`
- `Users can update own profile` — `for update using (id = auth.uid())`
- `Admins can update any profile` — `for update using (admin/master role
  OR id = auth.uid())`
- `Admins can delete profiles` — `for delete` (admin/master only)
- `Anyone can insert own profile or admin can insert any` — INSERT,
  third clause `OR (auth.uid() IS NOT NULL)` (pre-existing oddity, not
  in scope for this spec).

Outcomes for the new column:

- **User A cannot SELECT user B's `sidebar_layout`** — the SELECT
  policies gate the row, the column is part of the row, no separate
  column policy exists. Verified.
- **User A cannot UPDATE user B's `sidebar_layout`** — same logic;
  `saveSidebarLayout(userId, ...)` filtered by `.eq('id', userId)`
  combined with the `id = auth.uid()` policy means a forged userId
  silently produces 0-row writes (PostgREST returns no error, just no
  rows affected — a hostile client cannot escalate). Verified.
- **Admins can read/update any profile's `sidebar_layout`** — yes,
  per the admin-role policies. This is the spec-intended behavior
  ("admin-only app"); it does not leak across the app boundary
  because admin role is JWT-claim-gated, not client-asserted.

No new policy work is required, and no policy work was added by
this spec. **Architect's §0.2 claim is correct.**

### JSONB validation (specifically check #2)

Repeated separately for clarity. The frontend has two layers of
defensive coercion:

1. `src/lib/auth.ts:23-29` — `coerceSidebarLayout` rejects any value
   that isn't `{ v: 1, items: Array }`.
2. `src/lib/sidebarLayout.ts:46-60` — `isValidOverride` does the same
   plus per-entry type checks (`id: string`, `group?: string`,
   `order?: number`, `hidden?: boolean`).

Server-side: nothing. The migration creates a bare `jsonb` column with
no CHECK, no domain, no trigger. See Medium finding above for the
fix recommendation. The user can write a 1 MB blob; on read, the
frontend will return defaults if the shape doesn't match, so the UI
remains stable, but the row stays bloated and the row read on every
login pays the bandwidth cost.

**Per-user blast radius:** RLS scope means a user can only DoS their
own login-time profile read. They cannot affect another user's
performance or render. This is why the finding is Medium, not High.

### `useRole` placeholder (specifically check #4)

`src/hooks/useRole.ts` is unchanged (verified). New code in this spec
does not import or branch on `useRole`:

- `src/components/cmd/Sidebar.tsx` — no useRole import.
- `src/components/cmd/SidebarEditMode.tsx` — no useRole import.
- `src/lib/sidebarLayout.ts` — pure, no React.
- `src/screens/cmd/InventoryDesktopLayout.tsx` — no new useRole branch.
- `src/store/useStore.ts:1185-1195` — gates write on `currentUser?.id`,
  not role.

Edit mode is exposed via the gear icon to every signed-in user. That's
fine — server-side authorization (`id = auth.uid()`) is what protects
the data, and a signed-in user editing their own sidebar is the
intended scope. **No finding.**

### Secrets (specifically check #5)

No secrets introduced. No `EXPO_PUBLIC_*` additions. No service-role
key usage. No third-party API keys. No tokens or PII appearing in
`console.log` / `console.warn` (verified by grep — the new files
have zero log calls). **No finding.**

### Brand-scope leakage (specifically check #7)

N/A — `profiles` is per-user, not store- or brand-scoped. The new
column carries no store_id / brand_id reference and no per-store
selector. **No finding.**

### Realtime publication (specifically check #8)

Architect's design §0.6 states "profiles is not on the
supabase_realtime publication today". This is **not quite accurate** —
`supabase/migrations/20260502190000_realtime_publication.sql:13-14`
recreates the publication as `for all tables`, which includes
`profiles`. The new column is therefore published.

**Why this is not a finding:** Supabase realtime respects RLS on the
client-facing `realtime.list_changes` path. A subscriber receives
only rows that pass the table's SELECT policies for their JWT. With
`Users can read own profile` gated on `id = auth.uid()`, another
user's `sidebar_layout` change is not delivered to a different user's
client. Additionally, the app does not subscribe to `profiles` changes
(`useRealtimeSync` listens on `store-{id}` and `brand-{id}` channels
only — verified by reading the hook's wiring in `CmdNavigator.tsx`).
No code path consumes `profiles` realtime events.

**Recommendation (informational, not a finding):** correct the design
doc's §0.6 wording in a follow-up. The substantive claim ("no
realtime work needed") still holds; only the supporting reason is
wrong.

### Edge functions

None touched. `verify_jwt` config unchanged. **No finding.**

### Input validation summary

- The `sidebar_layout` JSON written by the client is server-unvalidated.
  See Medium finding for the recommended CHECK constraint.
- The merge algorithm (`applySidebarOverride` in
  `src/lib/sidebarLayout.ts`) defends against non-string `id` values
  via the type-guard before the merge runs (`isValidOverride` rejects
  anything where `e.id` is not a non-empty string). Stale ids are
  silently dropped (line 181, `if (!def) return`). No render crash on
  malformed data is reachable from a hostile profile row. **No
  finding.**

### Auth flow

No changes to login, signup, password reset, session management, or
token handling. The `fetchProfile` function gained one extra field
in its return shape; the auth flow is otherwise untouched. **No
finding.**

---

### Dependencies

`npm audit --audit-level=high` summary (run 2026-05-08):

- 1 high, 5 moderate vulnerabilities reported.
- All are in **pre-existing transitive dependencies**, not the three
  new `@dnd-kit/*` packages added by this spec:
  - `@xmldom/xmldom@0.8.12` (high) — pulled by `expo` →
    `@expo/cli` → `@expo/plist`. Pre-existing.
  - `dompurify@3.3.3` (moderate) — pulled by `jspdf@4.2.1`.
    Pre-existing.
  - `postcss@8.4.49` (moderate) — pulled by `expo` →
    `@expo/metro-config`. Pre-existing.
- `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`,
  `@dnd-kit/utilities@3.2.2` introduce **zero** advisories
  (verified by tracing the audit output — none of the affected
  paths route through `@dnd-kit/*`).
- `npm audit fix` is available for the existing issues but it would
  upgrade `expo`, which is out of scope for this spec.

**No new vulnerable dependencies introduced by spec 008.** The
existing audit findings are not blocking for this spec — they
should be tracked as a separate cleanup.

---

## Summary

This spec is well-scoped from a security standpoint. The migration
is purely additive on a column already gated by per-user RLS, the
write path goes through PostgREST (not raw SQL), userId comes from
the trusted store value, no secrets or PII enter logs, no edge
functions or service-role tokens are touched, and the new
`@dnd-kit` dependencies clean.

The one substantive recommendation — a CHECK constraint to bound
JSONB size — is Medium and does not block deploy. It can ship in a
follow-up additive migration whenever convenient.
