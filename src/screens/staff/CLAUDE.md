# Project: I.M.R Staff (`imr-staff`)

## What this is

Staff-facing app for the 2AM PROJECT — phones-in-pocket app for
end-of-day inventory counts. Sibling app to `imr-inventory` (the
admin web/native app). The contract this app builds against is
single-sourced at:

    /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md

The companion admin app and shared backend live at:

    /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT

## Stack

**Frontend**
- Expo SDK 54, React Native 0.81, react-native-web ^0.21, React 19.1
- TypeScript 5.3 strict — [tsconfig.json](tsconfig.json)
- Metro + Babel with `@/*` → `src/*` alias matching imr-inventory
- State: Zustand 4.5 — single store under [src/store/](src/store/)
- Routing: React Navigation 6 stack (sign-in → store picker →
  EOD count)
- Storage: `@react-native-async-storage/async-storage` (offline
  queue), `@react-native-community/netinfo` (connectivity hook
  per spec 061 §1 Q3)

**Backend**
- NONE in this repo. The staff app talks to the shared Supabase
  project (lives in `imr-inventory`) directly via `supabase-js`
  with a per-user JWT. There is no staff-app backend half.

**Database**
- Same Supabase project as imr-inventory. The contract:
  `public.staff_submit_eod()` RPC GRANTed to `authenticated`
  (spec 061). All authorization is enforced at the database
  layer via RLS — no shared service token.

## Project structure

```
App.tsx                       # Root; will mount the stack navigator (spec 062).
src/
  screens/                    # SignIn, StorePicker, EODCount
  hooks/                      # useConnectionStatus, ...
  store/                      # Zustand store (auth, active store, queue)
  lib/                        # supabase client, EOD submit wrapper, queue helpers
  i18n/                       # en.json (only locale in v1)
  navigation/                 # React Navigation stack config
  components/                 # Small UI primitives
```

## Auth model

- Email + password via `supabase.auth.signInWithPassword`.
- On sign-in, fetch `profiles.role` for the authenticated user.
- If `profiles.role !== 'user'`, sign out + show "This app is for
  staff only. Admins should use the imr-inventory app."
- If `profiles.role = 'user'` but `user_stores` is empty for that
  user, sign out + show "Your account is not assigned to any
  store. Contact your manager."
- Otherwise: store picker (B4) → EOD count (B5).

The staff app has NO admin UI, NO brand catalog UI, NO recipe
management. If a feature request implies those, redirect to
`imr-inventory`.

## Conventions

- **All Supabase access goes through `supabase-js` directly.** No
  custom data layer; the staff app is small enough that wrapper
  helpers per-feature in `src/lib/` are sufficient. No need to
  mirror imr-inventory's monolithic `src/lib/db.ts`.
- **All user-facing strings go through `i18n.t()` from day one.**
  English-only in v1 — `src/i18n/en.json`. Future locales add
  sibling files without code changes.
- **Optimistic-then-revert + toast** for any mutation. Same
  posture as imr-inventory. The toast library and error-routing
  helper are TBD in spec 062.
- **Cross-platform confirm** uses `window.confirm` on web vs
  `Alert.alert` on native. Mirror imr-inventory's
  `src/utils/confirmAction.ts` if needed; otherwise the
  store-picker dialog is the only confirm surface in v1.
- **Connectivity detection.** Spec 061 §1 Q3 resolution:
  `@react-native-community/netinfo` on native;
  `navigator.onLine` on web. The spec-059 hook from imr-inventory
  is NOT used here because the staff app has no realtime
  subscriptions for the Phoenix Socket to track.
- **Realtime sync: NONE in v1.** Pull-on-focus + manual refresh
  button. Spec 062 may add realtime later but it's not v1.

## Env vars

- `EXPO_PUBLIC_SUPABASE_URL` — shared Supabase project URL.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — publishable anon key. Safe to
  ship in the bundle.

NOT included: any service token. The staff app authenticates with
the user's own credentials via supabase-js; no shared secrets.

## Backend coupling

- The RPC contract is `public.staff_submit_eod(p_client_uuid,
  p_store_id, p_date, p_submitted_by, p_status, p_entries,
  p_vendor_id)` returning a JSONB envelope. The full contract
  (request shape, 200/conflict response, error semantics) is
  documented in `imr-inventory/specs/061-staff-app-eod-count.md`
  §7.
- The RPC body re-derives audit attribution from `auth.uid()`
  (spec 061 §2), so `p_submitted_by` is functionally ignored by
  the server. The frontend sends it for compatibility with the
  legacy signature — it can be `null`.
- The RPC includes a server-side `auth_can_see_store(p_store_id)`
  gate. A staff user calling for a store they don't have
  `user_stores` for will get a 42501 PG error (HTTP 403 via
  PostgREST). The frontend handles this as a "you've been removed
  from this store" UI, not a generic error.

## Spec-061 deprecated edge functions

`/functions/v1/staff-catalog`, `/functions/v1/staff-eod-submit`,
and `/functions/v1/staff-waste-log` return HTTP 410. Do NOT call
them. Catalog reads now go through PostgREST directly under the
staff user's RLS. Waste-log is out of scope for v1.

## Local development gotchas (inherited from imr-inventory)

**Realtime publication gotcha** (only if/when spec 062 adds
realtime): adding a table to `supabase_realtime` mid-session
requires `docker restart supabase_realtime_imr-inventory` to
re-snapshot the slot. Same docker container name — the staff
app shares the imr-inventory local Supabase stack.

**Edge runtime bind-mount captures CWD at boot**: doesn't apply
to imr-staff (we have no edge functions of our own), but the
shared local stack does. See imr-inventory's CLAUDE.md if
something feels wrong.

## Hard rules

- DO NOT change the slug in `imr-inventory/app.json`. It is
  load-bearing for EAS in that repo. This repo (`imr-staff`)
  has its own slug `imr-staff` per [app.json](app.json) — that
  slug IS our choice to set and is not coupled to imr-inventory.
- DO NOT add an admin UI. Staff are scoped to EOD count + future
  waste/prep/receiving flows. Brand catalog, recipe management,
  sales reports, user management — those live in imr-inventory.
- DO NOT call any deprecated `/functions/v1/staff-*` endpoint.
  They return 410.

## Roadmap

- **Spec 061 (in imr-inventory)**: backend contract — RPC GRANT
  swap, edge function deprecation, pgTAP coverage. Lands first.
- **Spec 062 (in this repo, future)**: staff frontend
  implementation — sign-in, store picker, EOD screen, offline
  queue, connectivity hook. Builds against the contract from
  spec 061.
- **Spec 063+**: prep make, waste log, receiving — future
  expansions. None are in v1 scope.
