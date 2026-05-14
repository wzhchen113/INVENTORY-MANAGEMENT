# I.M.R — Inventory Management for Restaurant

Admin console for the **2AM PROJECT** restaurant brand. Tracks ingredients across four locations from purchase to plate, runs end-of-day counts, reconciles POS sales against expected usage, and surfaces food-cost trends.

This repo is the **admin app** — one of three clients that talk to a shared Supabase backend:

| App | Audience | Repo | Auth |
|---|---|---|---|
| **Admin (this repo)** | Owners + managers | `INVENTORY-MANAGEMENT` | Supabase email/password, full RLS bypass via `auth_is_admin()` |
| **Staff app** | Counters + line cooks | sibling repo | Service-token Bearer → `staff-catalog` edge function |
| **PWA** | Customer-facing menu | sibling repo | Service-token Bearer → `pwa-catalog` edge function |

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK 54, React Native 0.81 (web via `react-native-web` 0.21) |
| Language | TypeScript |
| State | Zustand |
| Backend | Supabase — Postgres 17 + Auth + Realtime + Edge Functions (Deno 2) |
| Routing | React Navigation 6 (legacy UI) + custom desktop layout (Cmd UI) |
| CSV | PapaParse |
| Charts | `react-native-chart-kit` + custom SVG (`StockHistoryChart`) |
| Notifications | `expo-notifications` + push subscriptions on Supabase |

---

## Two UIs in one app

The whole UI tree forks at `App.tsx` based on the `EXPO_PUBLIC_NEW_UI` env flag (read at build time via [`src/lib/featureFlags.ts`](src/lib/featureFlags.ts)).

### Cmd theme (`EXPO_PUBLIC_NEW_UI=true`)

The default for desktop web. Single-screen layout with a left sidebar of 14 sections, a ⌘K command palette, and right-anchored form drawers for create / edit. Renders the full desktop UI at ≥1100 px; below that, [`CmdNavigator`](src/navigation/CmdNavigator.tsx) falls back to a native-style mobile stack (`InventoryListScreen` → `ItemDetailScreen`).

Sections live in [`src/screens/cmd/sections/`](src/screens/cmd/sections/):

```
DashboardSection         — KPI cards, food-cost trend, recent activity
InventoryCatalogMode     — items.tsv (per-store) ↔ catalog.tsv (cross-store)
EODCountSection          — week sidebar + dual case+unit count input
WasteLogSection          — waste entry with reason codes
ReceivingSection         — confirm PO deliveries with quantity verification
POsSection               — purchase orders
VendorsSection           — vendor profiles + per-store catalog
RecipesSection           — menu items / BOM
PrepRecipesSection       — prep recipes with sub-recipe support
RestockSection           — items below par, sorted by urgency
ReconciliationSection    — POS-expected vs EOD-counted variance
POSImportsSection        — CSV upload + recipe-based stock adjustment
AuditLogSection          — timestamped event stream, filterable
ReportsSection           — saved report definitions
```

Form drawers in [`src/components/cmd/`](src/components/cmd/):
- `IngredientFormDrawer` — items / catalog ingredients
- `VendorFormDrawer` — vendors
- `RecipeFormDrawer` — menu recipes (with raw-ingredient picker + prep-item editor)
- `PrepRecipeFormDrawer` — prep recipes (with raw|prep type pill per row)
- `AddCountModal`, `UploadCsvModal`, `RunImportModal`, `NewReportModal`, `ExportCsvDrawer`, `MobileNavDrawer`

### Legacy UI (`EXPO_PUBLIC_NEW_UI=false`)

[`AppNavigator`](src/navigation/AppNavigator.tsx) — drawer + bottom tabs + stack. Kept as a fallback for older mobile flows; everything in it is also reachable from the Cmd theme.

---

## Brand-catalog data model

The schema separates **brand-level shared data** from **per-store state**. There's exactly one brand today (`2AM PROJECT`, sentinel `2a000000-0000-0000-0000-000000000001`), but the model is multi-tenant ready.

```
        brands (1)
            │
            ├──── catalog_ingredients (~143)        — name, unit, case_qty, default cost
            │           │
            │           └─◇ inventory_items (~572)  — per-store stock, cost, par, vendor
            │                     │
            │                     └─◇ ingredient_conversions
            │
            ├──── recipes (41)                       ──◇ recipe_ingredients (catalog_id FK)
            │                                         ──◇ recipe_prep_items (prep_recipe_id FK)
            ├──── prep_recipes (10 current)          ──◇ prep_recipe_ingredients (raw|prep)
            └──── vendors (11)

  stores (4)  ── eod_submissions ── eod_entries
              ── waste_log
              ── audit_log
              ── purchase_orders ── po_items
              ── pos_imports     ── pos_import_items
              ── user_stores                          — RLS membership
```

Brand-shared tables (recipes, prep_recipes, vendors, catalog_ingredients) are readable by any authed user; writes are admin-only. Per-store tables go through `auth_can_see_store(uuid)` via `store_member_*` RLS policies.

---

## Project structure

```
App.tsx                              # entry — forks on EXPO_PUBLIC_NEW_UI
src/
  lib/
    featureFlags.ts                  # NEW_UI flag definition
    supabase.ts                      # client init
    auth.ts                          # session management
    db.ts                            # all PostgREST + RPC calls
    cmdSelectors.ts                  # useStockSeries, useRecipesUsingItem, etc.
    paletteAction.ts                 # ⌘K palette → section bridge
  navigation/
    AppNavigator.tsx                 # legacy drawer + tabs
    CmdNavigator.tsx                 # Cmd theme router (desktop ≥1100px)
  screens/
    cmd/
      InventoryDesktopLayout.tsx     # Cmd desktop shell
      InventoryListScreen.tsx        # Cmd mobile list
      ItemDetailScreen.tsx           # Cmd mobile detail
      sections/*.tsx                 # 14 desktop sections
    *.tsx                            # legacy screens
    DBInspectorScreen.tsx            # admin probe + dedup tools
  components/cmd/                    # Cmd UI components
  hooks/useRole.ts                   # role gate (currently always 'admin')
  store/useStore.ts                  # Zustand store with optimistic + revert-on-error
  theme/                             # design tokens for both UIs
  types/index.ts                     # domain models
  utils/
    confirmAction.ts                 # cross-platform confirm (web → window.confirm)
    usageCalculations.ts             # weekly usage trends, recipe cost math
supabase/
  migrations/*.sql                   # 29 timestamped migrations
  functions/                         # 10 edge functions
  seed.sql                           # mirrored from prod 2026-05-02
  config.toml                        # local stack + per-function verify_jwt
.github/workflows/
  test.yml                           # CI: jest + DB pgTAP (spec 022)
```

---

## Local development

The local Supabase stack mirrors prod's schema (pulled via `supabase db pull` on 2026-05-02). Don't drift via the dashboard SQL editor — every change goes through a migration file.

```bash
npm install
npm run dev:db            # boots Supabase: API 54321, Postgres 54322, Studio 54323, Inbucket 54324
npm run dev:db:reset      # re-seeds from supabase/seed.sql
npm run dev:functions     # serves edge functions on 8083
npm run web               # Expo web preview (default port 8081)
```

Default dev login: **`admin@local.test`** / **`password`**.

If you change a Supabase publication mid-session, restart the realtime container so the slot re-snapshots:

```bash
docker restart supabase_realtime_imr-inventory
```

---

## Backend reference

### RLS helpers

Two `SECURITY DEFINER` functions back every per-store policy:

```sql
auth_is_admin()                 -- coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin','master')
auth_can_see_store(p_store_id)  -- auth_is_admin() OR exists in user_stores
```

Per-store tables (`inventory_items`, `eod_submissions`, `eod_entries`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`) all carry granular `store_member_{read,insert,update,delete}` policies that delegate to `auth_can_see_store()`. Child tables without a `store_id` column (e.g. `eod_entries`, `po_items`, `pos_import_items`) scope through their parent's `EXISTS` join.

### Key RPCs

| RPC | Purpose |
|---|---|
| `create_inventory_item_with_catalog` | Atomic find-or-create on `(brand_id, lower(name))` then idempotent insert on `(store_id, catalog_id)`. Fixes the orphan-catalog-row leak that bare REST writes had. |
| `staff_submit_eod` | Idempotent EOD submit (eod_submissions upsert + eod_entries replace + inventory stock update + audit) keyed on a client-supplied UUID. |
| `staff_log_waste` | Atomic waste insert + stock decrement + audit, idempotent on client UUID. |
| `admin_db_inspector_probe` | Returns DB state + JWT/admin status + duplicate groups by `(brand_id, lower(name))`. Used by [`DBInspectorScreen`](src/screens/DBInspectorScreen.tsx). |
| `admin_dedupe_recipes` / `admin_dedupe_prep_recipes` | Repoint-before-delete merge for hard duplicates surfaced by the inspector. |

### Brand-catalog refactor — phase chronology

Migrations dated 2026-05-04 land the refactor in four phases. Every phase is idempotent and re-runnable:

1. **P1 (additive)** — new `brands` + `catalog_ingredients` tables, nullable `brand_id` / `catalog_id` columns on existing tables. Running app keeps working.
2. **P2 (backfill)** — populates the new columns, dedupes per-store recipes (Frederick's "2AM Fries" survives as a brand singleton), dedupes current prep recipes, builds catalog from per-store inventory, links `inventory_items.catalog_id`. **Note**: P2 left 4× duplicate ingredient lines on every canonical recipe/prep; cleaned up by [`20260505000000_dedupe_repointed_ingredient_lines.sql`](supabase/migrations/20260505000000_dedupe_repointed_ingredient_lines.sql) which also adds three logical-key UNIQUE indexes to prevent recurrence.
3. **P3 (lockdown)** — `NOT NULL` on FKs, drop redundant per-store columns (`name`, `unit`, `category`, `case_qty`, `sub_unit_*` on `inventory_items`; `store_id` on recipes/prep_recipes).
4. **P5 (RLS)** — admin-only writes on brand-shared tables.

(There's no P4 — the original plan reserved a number that the lockdown ended up absorbing.)

### Edge functions

Service-token authenticated (verify_jwt = false in [`supabase/config.toml`](supabase/config.toml)):

- `staff-catalog` — `GET /staff-catalog?store_id={uuid}&since={iso8601}` for the staff app's offline cache. Bearer `STAFF_SERVICE_TOKEN`.
- `pwa-catalog` — `GET /pwa-catalog?store_id={uuid}&since={iso8601}` for the customer-facing PWA. Bearer `PWA_SERVICE_TOKEN`.

JWT-protected push paths:

- `staff-eod-submit`, `staff-waste-log` — staff app posts inventory mutations through these.

Cron / external sync:

- `eod-reminder-cron` — sends EOD reminders before vendor cutoffs.
- `breadbot-nightly-sync`, `fetch-breadbot-sales` — POS pull from Breadbot.

User onboarding:

- `send-invite-email`, `send-welcome-email`, `delete-user`.

> **Important for downstream consumers:** after the brand-catalog refactor, recipe/prep ingredient rows reference `catalog_id`, **not** the legacy per-store `item_id` (the column was dropped in P3). Both edge functions return brand-stable joins; clients must `recipe.ingredients[].catalog_id === inventory.catalog_id`.

---

## CI

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs on every push and pull request. Two jobs: jest (Track 1) and DB pgTAP (Track 2). See [`tests/README.md`](tests/README.md#ci) for the full breakdown.

Schema-deploy gating (migration sync between local and prod) is currently manual — push migrations from a clean `main` via `supabase db push --linked`.

---

## Roles & access

This admin app is **admin-only** end-to-end. [`useRole.ts`](src/hooks/useRole.ts) returns `'admin'` for every authed user — there is no in-app staff path. Counters and line cooks use the **separate staff app**, which talks to `staff-catalog` (read) and `staff-eod-submit` / `staff-waste-log` (write).

Per-store visibility is enforced server-side by RLS — non-admins only see stores they're explicitly members of via `user_stores`. Admins see everything.

---

## Building for distribution

```bash
npx eas build --platform ios       # TestFlight / App Store
npx eas build --platform android   # Play Store / APK
npm run build:web                  # static export — Vercel auto-deploys on push to main
```

Requires an [Expo Application Services (EAS)](https://expo.dev/eas) account.

---

## Recent changes

Topics, not PR numbers (PR numbers rot fast):

- **Brand-catalog refactor (Phases 1–5).** Stores share a single brand-level catalog; recipes/preps/vendors are brand-scoped; per-store rows carry only stock + cost + par.
- **Per-store RLS hardening.** Closed a gap where authed users could `curl /rest/v1/inventory_items?store_id=eq.<other-store>`. Granular `store_member_*` policies via `auth_can_see_store()`.
- **Atomic catalog + inventory RPC.** `create_inventory_item_with_catalog` wraps the two writes in one transaction and turns duplicate inserts into find-or-create.
- **Dedup of repointed ingredient lines.** P2 left 4× copies on every canonical recipe/prep; cleaned up + UNIQUE indexes added.
- **DB Inspector + admin dedup RPCs.** Surfaces hard duplicates by `(brand_id, lower(name))` and exposes a one-click merge.
- **Cmd theme CRUD wiring.** Vendors / recipes / prep recipes had dead `<View>` Edit / Duplicate buttons; now full Edit + Duplicate + Delete + + NEW everywhere via dedicated form drawers.
- **CRUD revert+toast sweep.** Every Zustand action now reverts local state on `db.*` rejection and surfaces a `react-native-toast-message` instead of silently `console.warn`-ing.
- **EOD count dual case+unit input.** Counters can enter cases, individual units, or both; `actualRemainingCases` and `actualRemainingEach` are persisted alongside the unit total.
- **Local Supabase dev stack with prod-mirrored schema.** `npm run dev:db` boots the full stack; seed regenerated against the post-P3 brand-catalog schema.
- **CI deploy-gate workflow.** Catches drift between `main` and prod's applied migration list before the next deploy renders blank UIs.
