# I.M.R Staff (`imr-staff`)

Staff-facing app for 2AM PROJECT end-of-day inventory counts.
Sibling app to [`imr-inventory`](../INVENTORY-MANAGEMENT) — admin
features live there.

## Status

**Scaffold only.** This repo currently contains the project skeleton
per [imr-inventory spec 061](../INVENTORY-MANAGEMENT/specs/061-staff-app-eod-count.md).
The actual EOD count screen, store picker, offline queue, and
sign-in flow are spec 062 (to be written in this repo).

`App.tsx` currently renders a placeholder. Run `npm start` and the
splash will say "Hello from imr-staff."

## Stack

- Expo SDK 54
- React Native 0.81 / react-native-web ^0.21 / React 19.1
- TypeScript 5.3 strict
- Zustand 4.5 (state)
- React Navigation 6 (routing)
- `@supabase/supabase-js` ^2.101 (data layer)
- `@react-native-async-storage/async-storage` (offline queue)
- `@react-native-community/netinfo` (connectivity detection on
  native — see [CLAUDE.md](CLAUDE.md))
- Jest + jest-expo (test track)

Notably absent (intentional, vs imr-inventory): jspdf, papaparse,
react-native-chart-kit, expo-notifications, expo-sqlite, dnd-kit.
The staff app has no admin UI surface, no CSV export, no charts,
no push, no local sqlite cache.

## Setup

```bash
npm install
```

Environment variables (place in `.env.local` or a CI secret store):

| Var | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Shared Supabase project URL (same project as imr-inventory). |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Publishable anon key. Safe to bundle. |

For local development against the imr-inventory dev stack, the
defaults match `supabase status` from imr-inventory. The local
stack runs via `npm run dev:db` from imr-inventory, NOT from here
— this repo has no Supabase backend of its own.

## Running

```bash
npm start          # Expo dev server (interactive)
npm run ios        # iOS simulator
npm run android    # Android emulator / device
npm run web        # Web preview (for engineer iteration only;
                   # production target is native)
```

## Tests

```bash
npm test           # Jest unit tests
npm run typecheck  # tsc --noEmit (strict)
```

The pgTAP DB tests and shell smokes live in `imr-inventory` — the
backend contract is tested there. Staff-frontend tests
(EOD-screen render, offline-queue persistence, auth gate) will be
added by spec 062.

## Deploy targets

- **Native**: EAS Build → TestFlight (iOS) + Play Console (Android).
  Primary target; staff use this on their phones.
- **Web**: Vercel preview is nice-to-have for engineer iteration
  only. Not the production surface.

## Backend

Lives in [imr-inventory](../INVENTORY-MANAGEMENT). Specifically:

- The `staff_submit_eod` RPC contract: spec 061 §7, file
  [supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql](../INVENTORY-MANAGEMENT/supabase/migrations/20260525000000_staff_submit_eod_per_user_jwt.sql).
- RLS posture for staff users (`profiles.role = 'user'`): spec
  061 §0, gated through `auth_can_see_store()` (spec 041).
- Deprecated `/functions/v1/staff-*` edge functions return HTTP
  410 — do not call them.

No edge functions, migrations, or DB tests live in THIS repo.

## Architecture

```
  User signs in
       │
       ▼
  profiles.role check
   ├── 'user' + has user_stores → OK
   └── anything else → sign out + error
       │
       ▼
  Store picker (if user_stores.count > 1)
       │
       ▼
  EOD count screen
   ├── Vendor-day filter (spec 007 logic)
   ├── Numeric inputs per item
   └── Submit → supabase.rpc('staff_submit_eod', ...)
       │
       ├── 200 + conflict=false → success
       ├── 200 + conflict=true → idempotency replay, show existing
       └── Network error → AsyncStorage queue, drain on reconnect
```

## Hard rules

- Don't add an admin UI. Admin lives in imr-inventory.
- Don't add new top-level data layers. supabase-js direct calls
  through small per-feature wrappers in `src/lib/`.
- Don't call any deprecated `/functions/v1/staff-*` endpoint.
- Don't change `imr-inventory/app.json` — it's load-bearing
  there. This repo's `app.json` (`slug: imr-staff`) is owned by
  this repo.

## Roadmap

- ☑ Spec 061 (in imr-inventory): backend contract.
- ☐ Spec 062 (here, future): staff frontend implementation.
- ☐ Spec 063+: prep make, waste log, receiving (deferred).
