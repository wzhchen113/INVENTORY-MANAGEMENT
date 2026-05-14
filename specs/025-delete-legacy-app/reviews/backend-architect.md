# Spec 025 — Backend architect drift review (post-impl)

Reviewer: backend-architect
Mode: post-implementation drift review
Date: 2026-05-13

## Summary

Implementation matches the design with **zero Critical findings**. The
file-deletion sweep is clean (no orphan imports anywhere in `src/`), the
new client surface (`UsersSection`, `InviteUserDrawer`, `sendPasswordReset`)
follows the contracts from the design pass, and no DB schema / RLS / RPC /
edge-function contracts were touched. The `typecheck-base` CI gate landed
with the correct shape (least-privilege permissions, `timeout-minutes: 10`,
Node 20 + `npm ci`).

Three Should-fix items and a small handful of Nits below.

The dispatching prompt's claim that the Admin sidebar group is "gated by
`useIsSuperAdmin()`" is **inaccurate** — the spec §2.E explicitly says it
is NOT gated (visible to all admins; per-row gating lives inside the
section). The implementation correctly follows the spec, not the prompt.
No drift.

---

## Critical (block release)

**None.**

---

## Should-fix

### S1 — No guard against deleting the last super-admin / master
`src/screens/cmd/sections/UsersSection.tsx:270-276`

The `canDelete` predicate prevents users from deleting **themselves** when
they are master / super_admin (`isMaster && !isSelf`). But a master CAN
delete another master, and a super-admin CAN delete another super-admin
or a master. There is no "are you about to remove the last super-admin
from the project?" guard. With one super-admin in the system, a master
who has been told their own delete is blocked can still delete the
super-admin — orphaning the global admin surface.

This is the "admin-self-harm" edge case the dispatching prompt flagged.
The spec §Q5 / AC24 inherits the legacy gates verbatim and does not call
out a last-of-role guard; this is a gap the implementation now exposes
because there is no path back to the legacy `UsersScreen` if you brick
the only super-admin.

Two acceptable mitigations:
1. **Client-side warning gate.** Before opening `TypeToConfirmModal`,
   count rows where `role === target.role` (within visible scope). If
   `count === 1 && target.role in ('master', 'super_admin')`, surface a
   second-stage confirm ("This is the last super-admin. The Tenancy
   surface will be inaccessible after this delete. Type LAST-SUPER-ADMIN
   to proceed.") or refuse with a toast.
2. **Server-side guard in `delete-user` edge function.** Belt-and-
   suspenders — reject deletes that would leave the system with zero
   super-admins. Migration-free; the edge function does the count.

Recommend doing (1) now (client-only, no backend change, low effort) and
filing (2) as a follow-up so a future client bug or direct API call
can't bypass it.

### S2 — Stale user list when a peer admin acts concurrently
`src/screens/cmd/sections/UsersSection.tsx:58-72`

The section refetches on mount and after each own action, but never
subscribes to realtime. The design §7 explicitly said this is the
intended posture for admin-only / low-frequency surfaces, so this is
**not a drift finding**. It's flagged here because the implementation
now makes the gap discoverable:

- Admin A opens `UsersSection`. Sees admins A, B, C.
- Admin B deletes admin C from a different browser.
- Admin A's list still shows admin C until A clicks delete or reset.
- A clicks delete on C → `deleteProfile` returns success (idempotent
  delete on an already-deleted user) or an error toast surfaces.

The legacy `UsersScreen` had the same posture. **No action required**;
flagging so the release-coordinator can decide whether to surface as a
known limitation in release notes. If realtime is later wanted, the
cheap add is a per-component subscription to `profiles` (channel name
`profiles-list-{currentUser.id}` or similar) — same shape as the
`store-{id}` / `brand-{id}` pattern. Would require a publication-
membership check (CLAUDE.md realtime publication gotcha) since
`profiles` may not be on `supabase_realtime` today.

### S3 — `json-server` devDep follow-up is safe to remove now
`package.json:72`

Spec dev's note (lines 1550-1553 of spec.md) flagged this as a follow-up
because of the CLAUDE.md "Ask before expanding scope" rule. The dep is
already orphaned:
- Its only call sites (`db.json`, `src/lib/api.ts`, `src/store/useJsonServerSync.ts`,
  and the `"db"` npm script) are all deleted in this change set.
- Confirmed via grep across the repo: zero remaining references to
  `json-server` outside `package-lock.json` and `node_modules/`.

Recommendation: **remove `json-server` from `devDependencies` in a
follow-up cleanup PR** (or as a fast-follow on this one, with user
approval). It's dev-only so the production bundle is unaffected, but
carrying a dead dep increases `npm install` time and audit surface.
Doing it now (one-line `package.json` edit + `npm install` to update
`package-lock.json`) is low risk. Doing it later is also fine — it's
inert.

---

## Nits

### N1 — Section dispatch arm placement diverges from spec §2.F (cosmetic)
`src/screens/cmd/InventoryDesktopLayout.tsx:184`

Design §2.F said: "Add a single line to the `section ===` ternary
(right before the `Reports` arm at line 181)". Implementation placed
the `Users` arm **after** `Reports` instead. Functionally identical (an
else-if chain doesn't care about sibling order). Not a drift — just a
nit. The placement after `Reports` and before `Brands` is arguably
cleaner because it groups admin-global surfaces together.

### N2 — Two toasts fire on a non-self delete
`src/screens/cmd/sections/UsersSection.tsx:110-132` +
`src/store/useStore.ts:805-810`

`useStore.deleteProfile` already fires a "Profile deleted" toast on
success. `UsersSection.handleConfirmDelete` then fires nothing additional
on a non-self delete (good) — but on a **self** delete, it fires an
additional "Account deleted / Signing out…" toast. Two toasts stack on
self-delete. Not broken; minor UX polish. Could be addressed by
suppressing `deleteProfile`'s toast when `isSelf` (would require a flag
parameter on `deleteProfile`) or by removing the second toast and letting
the page navigation cover the message. Neither change is urgent.

### N3 — `canResetPassword` blocks master ↔ super-admin resets
`src/screens/cmd/sections/UsersSection.tsx:286-288`

For an `isMaster` actor, the predicate is
`!isSelf && user.role !== 'master' && user.role !== 'super_admin'`. This
means:
- A super-admin cannot send a password reset to a master.
- A master cannot send a password reset to a super-admin.

Spec AC25 said: "master sees this on every user except master itself".
The implementation generalized "master" to include super_admin (per
design §2.G.1's generalization) and then applied the
"not-master-and-not-super-admin" filter to the target row too. This is
a reasonable forward-compat tightening (preventing a junior super-admin
from password-resetting the founding master), but it's stricter than
the AC. Not a drift — it's a defensible interpretation of the
generalization §2.G.1 made — but worth surfacing for the
release-coordinator. If the user expects a super-admin to be able to
reset a master's password from this UI, the gate would need adjustment.

### N4 — Comment-only NEW_UI / EXPO_PUBLIC_NEW_UI references survive
Four files retain comment-only references to the deleted flag:
- `src/screens/dev/CmdAtomsPreview.tsx:31`
- `src/screens/cmd/ComingSoonScreen.tsx:34`
- `src/screens/cmd/ComingSoonScreen.tsx:122` (this one is a visible
  `NEW_UI=true` label on the dev-mode "coming soon" panel — see
  architect §4.B / §9 nit 8 in spec)
- `src/components/cmd/ThemeToggle.tsx:10`

Spec §1d and §9 nit 8 already flagged these as intentional carve-outs
for the CLAUDE.md follow-up edit pass. **No action required.** Listed
here for completeness.

### N5 — `inviteUserLegacy` shim removal — confirmed
`src/lib/auth.ts` no longer exports `inviteUserLegacy`. Repo-wide grep
returns matches only in spec files (specs/012b-super-admin-ui*, specs/025-delete-legacy-app/spec.md).
Per design §1c. **No action.**

---

## Architectural drift cross-check (per dispatcher's checklist)

| Item | Design source | Implementation | Verdict |
| ---- | ------------- | -------------- | ------- |
| §1c — `inviteUserLegacy` shim removed | Spec §1c | `src/lib/auth.ts` — gone. No callers remain. | Match |
| §2.B — `sendPasswordReset(email): Promise<{error: string \| null}>` | Spec §2.B | `src/lib/auth.ts:408` — exact signature; wraps `supabase.auth.resetPasswordForEmail`. | Match |
| §2.E — Admin sidebar group at END, gated by `useIsSuperAdmin()` | Spec §2.E says VISIBLE TO ALL ADMINS, NOT gated | `cmdSelectors.ts:1081-1086` — unconditional add. | **Match (prompt's wording was wrong; spec was right; impl follows spec)** |
| §3 — CSV/PDF export web-only, dynamic imports, per-vendor PDF, fixed CSV column order | Spec §3.A, §3.B, §3.C | `ReorderSection.tsx:395-426` (CSV with `Papa.unparse(rows, { columns })` and fixed column array), `:455-538` (PDF with dynamic `import('jspdf')` / `import('jspdf-autotable')` and per-vendor autoTable loop), `:595-600` (`Platform.OS === 'web'` gate). | Match |
| §4 — tsconfig exclude additions: tests + supabase/functions + scripts | Spec §5.C / AC12 / AC13 | `tsconfig.json:10-16` — array exactly as specified. | Match |
| §5 — `typecheck-base` CI job alongside existing jobs; permissions least-privilege; timeout-minutes set | Spec §5.A | `.github/workflows/test.yml:83-103` — Track 1b job, Node 20, `npm ci`, `timeout-minutes: 10`, inherits `permissions: contents: read` from line 36. | Match |

### File deletion sweep — orphan import scan
Grep for `from ['"]...((navigation/AppNavigator)|(screens/AdminScreens|DashboardScreen|EODCountScreen|EODHistoryScreen|IngredientsScreen|ItemsScreen|OrderReportScreen|OrdersScreen|POSImportScreen|PrepRecipesScreen|ReconciliationScreen|WasteLogScreen)|(components/IngredientEditor)|(store/useSupabaseStore|useJsonServerSync)|(lib/api|featureFlags))['"]` across `src/`: **zero matches**. Clean.

### RLS / RPC / edge function contracts
- **No new migrations.** Confirmed — `supabase/migrations/` shows the
  same set as `main` head (latest: `20260513000000_inventory_counts.sql`).
- **No edits to `src/lib/db.ts` RPC helpers.** Spec said the
  UsersSection uses `src/lib/auth.ts` helpers, not `db.ts`. Confirmed.
- **`UsersSection`'s SELECT path.** Routes through
  `fetchAllUsers({ brandId })` at `src/lib/auth.ts:309`. Reads from
  `profiles` + `user_stores` + `invitations` via PostgREST. All three
  tables have pre-existing RLS policies (`auth_is_admin()` for
  cross-row reads on `profiles`; `auth_can_see_store()` on
  `user_stores`; `auth_is_admin()` on `invitations`). No new RLS path,
  no new RPC.
- **`sendPasswordReset`.** Hits Supabase's built-in GoTrue endpoint
  via `supabase.auth.resetPasswordForEmail`. No edge function, no
  custom mailer. The GoTrue endpoint is authenticated by the caller's
  session JWT and rate-limited at the Supabase platform level. Per
  spec §2.A — no new contract.

### Realtime channels
- `UsersSection` does not subscribe to realtime (per design §7).
  Confirmed at `UsersSection.tsx:58-72` — on-mount fetch + post-action
  refetch only.
- No `supabase_realtime` publication membership change (no new
  migration, no `alter publication`). The CLAUDE.md
  `docker restart supabase_realtime_imr-inventory` gotcha does NOT
  fire for this spec.

### Edge-case admin-self-harm scenarios
- **Super-admin deletes themselves.** `useIsMaster()` returns true;
  `canDelete = !isSelf` evaluates to false; delete button hidden.
  Blocked at the UI. (Not blocked server-side — a direct edge-function
  call could still self-delete. Out of scope; same as legacy.)
- **Only super-admin's role is downgraded.** `UsersSection` has no
  role-change UI; role is only set at invite time. Not a reachable
  edge case from this section.
- **A master deletes the only super-admin.** `canDelete = !isSelf =
  true` for the master; delete proceeds. **See S1 above** — this is
  the real admin-self-harm gap.

### `json-server` devDep
Spec dev correctly flagged this. **See S3 above** — safe to remove
now (orphaned by the AC3/§1b deletes); flag as fast-follow or do in
this PR per user preference.

---

## Files inspected

- `specs/025-delete-legacy-app/spec.md`
- `App.tsx`
- `src/lib/auth.ts` (offsets 200-280, 380-417)
- `src/lib/cmdSelectors.ts:1015-1098`
- `src/screens/cmd/sections/UsersSection.tsx` (entire file)
- `src/components/cmd/InviteUserDrawer.tsx` (entire file)
- `src/screens/cmd/InventoryDesktopLayout.tsx:175-198`
- `src/screens/cmd/sections/ReorderSection.tsx:385-540, 575-650`
- `src/store/useStore.ts:789-816`
- `src/hooks/useRealtimeSync.ts:1-50`
- `tsconfig.json`
- `.github/workflows/test.yml`
- `tests/README.md:40-60`
- `.env.example`
- `README.md`
- `package.json:18-22, 70-75`
- `app.json:4` (slug untouched — confirmed)
- `supabase/migrations/` directory listing (no new migrations)

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. Zero Criticals; 3
  Should-fix items (S1 last-super-admin guard, S2 stale-list-on-peer-
  action posture which is per-spec, S3 orphan `json-server` devDep);
  4 Nits. Implementation matches the design. Recommend release-coordinator
  flag S1 as a known limitation pending a follow-up admin-self-harm
  guard spec, and S3 for a fast-follow cleanup PR.
payload_paths:
  - specs/025-delete-legacy-app/reviews/backend-architect.md
