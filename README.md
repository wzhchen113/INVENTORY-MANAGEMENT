# I.M.R — Inventory Management for Restaurant

Admin **and staff** app for the **2AM PROJECT** restaurant brand. Tracks ingredients across four locations from purchase to plate, runs end-of-day and weekly counts, reconciles POS sales against expected usage, manages the purchase-order loop (reorder → send → receive → cost update), and surfaces food-cost trends.

One Supabase backend, two surfaces in this repo, one sibling client:

| Surface | Audience | Where | Auth |
|---|---|---|---|
| **Admin (Cmd UI)** | Owners + managers | this repo — [`src/screens/cmd/`](src/screens/cmd/) | Supabase email/password; privileged roles via JWT `app_metadata.role` |
| **Staff (EOD app)** | Counters + line cooks | this repo — [`src/screens/staff/`](src/screens/staff/) (merged from the former `imr-staff` repo, spec 063) | Supabase email/password; routed by `profiles.role` |
| **PWA** | Customer-facing menu | sibling repo | Service-token Bearer → `pwa-catalog` edge function |

[`RoleRouter`](src/navigation/RoleRouter.tsx) dispatches after login: privileged roles (`admin` / `master` / `super_admin`) get the Cmd UI, everyone else gets the staff app.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK 54, React Native 0.81 (web via `react-native-web` 0.21), React 19 |
| Language | TypeScript (strict) |
| State | Zustand — admin store at [`src/store/useStore.ts`](src/store/useStore.ts), slice-isolated staff store at [`src/screens/staff/store/`](src/screens/staff/store/) |
| Backend | Supabase — Postgres 17 + Auth + Realtime + Edge Functions (Deno 2) |
| Routing | React Navigation 6 + `RoleRouter` role gate + custom desktop layout (Cmd UI) |
| i18n | `en` / `es` / `zh-CN` — admin catalog in [`src/i18n/`](src/i18n/), staff-only catalog in [`src/screens/staff/i18n/`](src/screens/staff/i18n/) |
| CSV / PDF | PapaParse, jsPDF export |
| Charts | `react-native-chart-kit` + custom SVG (`StockHistoryChart`) |
| Notifications | `expo-notifications` + custom web-push ([`src/lib/webPush.ts`](src/lib/webPush.ts)) |

---

## UI

**Admin** is a single-screen Cmd UI layout with a left sidebar of sections, a ⌘K command palette, and right-anchored form drawers for create / edit. Renders the full desktop UI at ≥1100 px; below that, [`CmdNavigator`](src/navigation/CmdNavigator.tsx) falls back to a native-style mobile stack (`InventoryListScreen` → `ItemDetailScreen`).

**Staff** is a phone-first, light-only flow: store picker → EOD count / weekly count / reorder, with an offline submit queue ([`src/screens/staff/lib/eodQueue.ts`](src/screens/staff/lib/eodQueue.ts)) and no realtime (by design, spec 062).

Admin sections live in [`src/screens/cmd/sections/`](src/screens/cmd/sections/):

```
DashboardSection         — KPI cards, food-cost trend, recent activity
InventoryCatalogMode     — items.tsv (per-store) ↔ catalog.tsv (cross-store)
EODCountSection          — week sidebar + dual case + loose-units count input
InventoryCountSection    — weekly/inventory counts; history rows carry par status
                           (✓ at/above par, red = below) + inline reorder math
WasteLogSection          — waste entry with reason codes
ReceivingSection         — PO-driven receiving (outstanding-remainder prefill,
                           partials) + per-line "case $ this delivery" with a
                           >30% price-change confirm; freeform fallback
POsSection               — PO lifecycle: draft → sent → partial → received /
                           cancelled; share as message/WeChat text
ReorderSection           — suggested orders grouped by vendor (par gap − pending
                           PO qty), one-click CREATE PO per vendor card
OrderScheduleSection     — vendor order-day schedules
VendorsSection           — vendor profiles + per-store catalog
RecipesSection           — menu items / BOM
PrepRecipesSection       — prep recipes with sub-recipe support
MenuImpactSection        — cost/margin impact per menu item
RestockSection           — items below par, sorted by urgency
ReconciliationSection    — POS-expected vs EOD-counted variance
POSImportsSection        — CSV upload + recipe-based stock adjustment
AuditLogSection          — timestamped event stream, filterable
ReportsSection           — saved report definitions
BrandsSection            — brand records (multi-tenant scaffolding)
CategoriesSection        — ingredient categories
RecipeCategoriesSection  — recipe categories
UsersSection             — invite, role management, password reset, delete
```

Form drawers in [`src/components/cmd/`](src/components/cmd/): `IngredientFormDrawer`, `VendorFormDrawer`, `RecipeFormDrawer`, `PrepRecipeFormDrawer`, `InviteAdminDrawer`, `InviteUserDrawer`, plus `AddCountModal`, `UploadCsvModal`, `RunImportModal`, `NewReportModal`, `ExportCsvDrawer`, `MobileNavDrawer`.

---

## Brand-catalog data model

The schema separates **brand-level shared data** from **per-store state**. There's exactly one brand today (`2AM PROJECT`, sentinel `2a000000-0000-0000-0000-000000000001`), but the model is multi-tenant ready.

```
        brands (1)
            │
            ├──── catalog_ingredients (~143)        — name, unit, case_qty, sub_unit_size, default cost
            │           │
            │           └─◇ inventory_items (~576)  — per-store stock, cost, par, vendor
            │                     ├─◇ item_vendors  — per-vendor case_price / cost_per_unit, is_primary
            │                     └─◇ ingredient_conversions
            │
            ├──── recipes (41)                       ──◇ recipe_ingredients (catalog_id FK)
            │                                         ──◇ recipe_prep_items (prep_recipe_id FK)
            ├──── prep_recipes                       ──◇ prep_recipe_ingredients (raw|prep)
            └──── vendors                            ──◇ order_schedule

  stores (4)  ── eod_submissions    ── eod_entries
              ── inventory_counts   ── inventory_count_entries
              ── user_count_drafts                   — save-draft / resume for counts
              ── waste_log
              ── audit_log
              ── purchase_orders    ── po_items      — draft→sent→partial→received/cancelled
              ── pos_imports        ── pos_import_items
              ── user_stores                         — RLS membership
```

Brand-shared tables (recipes, prep_recipes, vendors, catalog_ingredients) are readable by any authed user; writes are admin-only. Per-store tables go through `auth_can_see_store(uuid)` via `store_member_*` RLS policies.

### Costing model (★)

Since spec 104, the stored cost is the **true per-each (smallest-unit) cost**:

```
cost_per_unit = case_price / (case_qty × sub_unit_size)
```

on `inventory_items`, `item_vendors`, and `catalog_ingredients.default_cost` alike (columns are `numeric(12,6)` — per-each is sub-cent for split-pack items). Consumers that display or aggregate per-counted-unit dollars bridge back with `× sub_unit_size`. The editor's cost field is read-only/derived.

Costs also move **operationally**: receiving a PO line at a different case price updates the `(item, vendor)` link *and* the item's headline cost through the same ★ formula — any vendor's delivery, by owner decision — with an old→new trail in `audit_log` (`'PO price change'`) and a client-side >30% confirm in front of it. `default_cost` is never touched by receiving.

---

## Project structure

```
App.tsx                              # entry — mounts RoleRouter
src/
  lib/
    supabase.ts                      # client init
    auth.ts                          # session management + callEdgeFunction helper
    authGate.ts, sessionRestore.ts   # pre-store auth-path probes
    db.ts                            # all PostgREST + RPC calls (single choke point)
    countDrafts.ts, countDraftLocal.ts  # server + offline count drafts
    cmdSelectors.ts                  # useStockSeries, useRecipesUsingItem, etc.
    paletteAction.ts                 # ⌘K palette → section bridge
  navigation/
    RoleRouter.tsx                   # role gate: admin roles → Cmd, others → staff
    CmdNavigator.tsx                 # Cmd theme router (desktop ≥1100px)
  screens/
    cmd/
      InventoryDesktopLayout.tsx     # Cmd desktop shell
      InventoryListScreen.tsx        # Cmd mobile list
      ItemDetailScreen.tsx           # Cmd mobile detail
      sections/*.tsx                 # desktop sections
      lib/priceGuard.ts              # expected case price + 30% guard math
    staff/                           # staff EOD app (screens, store, i18n, lib)
    DBInspectorScreen.tsx            # admin probe + dedup tools
    LoginScreen.tsx, RegisterScreen.tsx
  components/cmd/                    # Cmd UI components
  hooks/useRole.ts                   # 'admin' inside the Cmd surface; real gate is RoleRouter
  store/useStore.ts                  # admin Zustand store, optimistic + revert-on-error
  theme/                             # design tokens (Light / Dark / Cmd)
  utils/
    confirmAction.ts                 # cross-platform confirm (web → window.confirm)
    poShareText.ts                   # PO → localized share text (no prices)
    usageCalculations.ts             # weekly usage trends, recipe cost math
supabase/
  migrations/*.sql                   # timestamped migrations
  functions/                         # edge functions (Deno)
  tests/*.test.sql                   # pgTAP DB tests
  seed.sql                           # mirrored from prod
  config.toml                        # local stack + per-function verify_jwt
scripts/                             # test-db.sh (pgTAP runner) + smoke scripts
e2e/                                 # Playwright browser tests
.github/workflows/
  test.yml                           # jest + both typechecks + pgTAP
  db-migrations-applied.yml          # repo ↔ prod migration drift gate
  e2e.yml                            # Playwright suite
```

---

## Local development

The local Supabase stack mirrors prod's schema (pulled via `supabase db pull`, kept in sync by migrations since). Don't drift via the dashboard SQL editor — every change goes through a migration file.

```bash
npm install
npm run dev:db            # boots Supabase: API 54321, Postgres 54322, Studio 54323, Inbucket 54324
npm run dev:db:reset      # re-seeds from supabase/seed.sql
npm run dev:functions     # serves edge functions on 8083
npm run web               # Expo web preview (default port 8081)
```

Default dev login: **`admin@local.test`** / **`password`**.

Tests:

```bash
npm test                  # jest (unit + component)
npm run test:db           # pgTAP DB tests (hermetic begin/rollback per file)
npm run typecheck && npm run typecheck:test
npm run e2e               # Playwright against the local stack
npm run test:smoke        # edge-function + RPC curl smokes
```

If you change a Supabase publication mid-session, restart the realtime container so the slot re-snapshots:

```bash
docker restart supabase_realtime_imr-inventory
```

---

## Backend reference

### RLS helpers

`SECURITY DEFINER` functions back every per-store policy:

```sql
auth_is_admin()                 -- app_metadata.role in ('admin','master')
auth_is_super_admin()           -- app_metadata.role = 'super_admin'
auth_is_privileged()            -- auth_is_admin() OR auth_is_super_admin()
auth_can_see_store(p_store_id)  -- super_admin, OR admin within their brand,
                                -- OR explicit user_stores membership
```

Per-store tables (`inventory_items`, `eod_submissions`, `eod_entries`, `inventory_counts`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`, …) carry granular `store_member_{read,insert,update,delete}` policies that delegate to `auth_can_see_store()`. Child tables without a `store_id` column (e.g. `eod_entries`, `po_items`) scope through their parent's `EXISTS` join.

Two policy disciplines are CI-enforced: no trivially-wide permissive policies (pgTAP lint, spec 053), and destructive role ops guard against self-targeting and last-of-role deletion (`assert_not_last_of_role`, `'cannot delete self'` / `'cannot demote self'`).

### Key RPCs

| RPC | Purpose |
|---|---|
| `create_inventory_item_with_catalog` | Atomic find-or-create on `(brand_id, lower(name))` then idempotent insert on `(store_id, catalog_id)`. |
| `staff_submit_eod` / `staff_log_waste` | Idempotent EOD submit / waste log (stock update + audit), keyed on a client UUID. Called via PostgREST from the in-repo staff app. |
| `report_reorder_list` | The reorder engine: par gap − on-hand − pending PO qty, grouped by vendor with order-schedule awareness. |
| `report_reorder_for_counted_onhand` | Sibling engine for count-history rows: same math against a historical counted on-hand (kept in byte-parity with the main engine by pgTAP). |
| `receive_purchase_order` | Additive, idempotent PO receiving; optional per-line `new_case_price` drives the ★ cost update + `'PO price change'` audit rows. |
| `close_short_purchase_order` / `cancel_purchase_order` | Close a partial as received / cancel an open PO. |
| `demote_profile_to_user` | Role demotion with self- and last-of-role guards. |
| `admin_db_inspector_probe`, `admin_dedupe_recipes`, `admin_dedupe_prep_recipes` | DB inspector + repoint-before-delete merges for hard duplicates. |

### Brand-catalog refactor — phase chronology

Migrations dated 2026-05-04 land the refactor in four phases. Every phase is idempotent and re-runnable:

1. **P1 (additive)** — new `brands` + `catalog_ingredients` tables, nullable `brand_id` / `catalog_id` columns on existing tables. Running app keeps working.
2. **P2 (backfill)** — populates the new columns, dedupes per-store recipes (Frederick's "2AM Fries" survives as a brand singleton), dedupes current prep recipes, builds catalog from per-store inventory, links `inventory_items.catalog_id`. **Note**: P2 left 4× duplicate ingredient lines on every canonical recipe/prep; cleaned up by [`20260505000000_dedupe_repointed_ingredient_lines.sql`](supabase/migrations/20260505000000_dedupe_repointed_ingredient_lines.sql) which also adds three logical-key UNIQUE indexes to prevent recurrence.
3. **P3 (lockdown)** — `NOT NULL` on FKs, drop redundant per-store columns (`name`, `unit`, `category`, `case_qty`, `sub_unit_*` on `inventory_items`; `store_id` on recipes/prep_recipes).
4. **P5 (RLS)** — admin-only writes on brand-shared tables.

(There's no P4 — the original plan reserved a number that the lockdown ended up absorbing.)

### Edge functions

JWT-protected (default):

- `send-invite-email`, `send-welcome-email`, `delete-user` — user onboarding/offboarding (delete-user enforces the self- and last-of-role guards).
- `send-po-email` — emails a purchase order to a vendor via Resend (admin-gated; in practice vendors are reached via the in-app message/WeChat share text instead).
- `translate-on-save` — DeepL-backed suggestions translating ingredient / recipe / category names into the other locales on save (user-editable before persisting).

Service-token / public (verify_jwt = false, validated in-function):

- `pwa-catalog` — `GET /pwa-catalog?store_id={uuid}&since={iso8601}` for the customer-facing PWA. Bearer `PWA_SERVICE_TOKEN`.
- `username-resolve` — pre-auth username → email resolution for login, rate-limited server-side.

Cron:

- `eod-reminder-cron`, `weekly-reminder-cron` — count reminders before vendor cutoffs.
- `breadbot-nightly-sync`, `fetch-breadbot-sales` — POS pull from Breadbot.

Retired (permanent HTTP 410 stubs — intentional, do not clean up):

- `staff-catalog`, `staff-eod-submit`, `staff-waste-log` — the staff v1 API (spec 061). The staff app now lives in this repo and talks to PostgREST/RPCs directly. CORS headers are kept for preflight.

> **Important for downstream consumers:** after the brand-catalog refactor, recipe/prep ingredient rows reference `catalog_id`, **not** the legacy per-store `item_id` (the column was dropped in P3). `pwa-catalog` returns brand-stable joins; clients must match `recipe.ingredients[].catalog_id === inventory.catalog_id`.

---

## CI

Three workflows run on every push and pull request:

- [`test.yml`](.github/workflows/test.yml) — jest (Track 1), test-graph typecheck (1a), base typecheck (1b), and DB pgTAP (Track 2). See [`tests/README.md`](tests/README.md#ci).
- [`db-migrations-applied.yml`](.github/workflows/db-migrations-applied.yml) — bi-directional drift check between `supabase/migrations/*.sql` and prod's `schema_migrations`. **Hard-fails** when a repo migration was never applied to prod; warns on dashboard-only drift. An independent signal from `test.yml` — a green test run alone does not prove the branch is healthy.
- [`e2e.yml`](.github/workflows/e2e.yml) — Playwright suite against a fresh local stack.

Prod migration flow: `supabase db push` isn't used (no prod DB password in the loop). Migrations are applied to prod deliberately — execute the SQL, insert the exact version into `supabase_migrations.schema_migrations`, verify function bodies match local via normalized md5 — after which the drift gate re-greens.

---

## Roles & access

[`RoleRouter`](src/navigation/RoleRouter.tsx) reads `profiles.role` from the auth session and mounts exactly one surface: `admin` / `master` / `super_admin` get the Cmd UI, everyone else gets the staff EOD app. Inside the Cmd surface, [`useRole.ts`](src/hooks/useRole.ts) returns `'admin'` unconditionally — the real gate is the router boundary plus server-side RLS.

Per-store visibility is enforced server-side — non-privileged users only see stores they're members of via `user_stores`. Edge functions that gate on caller role mirror `auth_is_privileged()` (`admin` / `master` / `super_admin`), and destructive role operations refuse self-targeting and last-of-role deletion at both the SQL and edge-function layers.

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

Topics, not PR numbers (PR numbers rot fast), newest first:

- **Cost-on-receipt.** Receiving a delivery at a different case price updates the vendor link *and* the item's headline cost through the ★ pipeline, with per-line audit rows and a >30% fat-finger confirm.
- **Share PO via message/WeChat.** Vendors don't use email — POs render as localized plain text (no prices) for the share sheet / clipboard, with an honest "did you send it?" status flip.
- **Purchase-order loop.** Reorder vendor card → draft PO → sent → receive (partials, idempotent) → `pending_po_qty` feeds back into both reorder engines so suggestions don't double-order.
- **Count save-draft + resume.** EOD and weekly counts can be saved mid-count (server-first, offline fallback) and resumed where you left off.
- **Count-history par status + inline reorder.** History rows show ✓ at/above par or a red below-par note with real reorder math from the counted on-hand.
- **Per-each cost basis (★).** `cost_per_unit` is now the true smallest-unit cost `case_price / (case_qty × sub_unit_size)`; columns widened to `numeric(12,6)`; all consumer dollar totals unchanged via the `× sub_unit_size` bridge.
- **"Loose Units" relabel.** Count inputs say Loose Units (staff + admin, all three locales) so cases vs singles can't be conflated.
- **Staff app merged in (spec 063).** The former `imr-staff` repo now lives at `src/screens/staff/`; the staff v1 edge API was retired to 410 stubs (spec 061) in favor of direct PostgREST/RPC.
- **CI gates hardened.** `db-migrations-applied.yml` drift gate (spec 064), Playwright e2e workflow, and a pinned supabase CLI (2.108.0) after a CLI regression broke the gate's parser.
- **Brand-catalog refactor (Phases 1–5).** Stores share a single brand-level catalog; recipes/preps/vendors are brand-scoped; per-store rows carry only stock + cost + par.
- **Per-store RLS hardening.** Closed a gap where authed users could `curl /rest/v1/inventory_items?store_id=eq.<other-store>`. Granular `store_member_*` policies via `auth_can_see_store()`.
- **Atomic catalog + inventory RPC.** `create_inventory_item_with_catalog` wraps the two writes in one transaction and turns duplicate inserts into find-or-create.
- **DB Inspector + admin dedup RPCs.** Surfaces hard duplicates by `(brand_id, lower(name))` and exposes a one-click merge.
- **CRUD revert+toast sweep.** Every Zustand action reverts local state on `db.*` rejection and surfaces a toast instead of silently `console.warn`-ing.
- **EOD count dual case+unit input.** Counters can enter cases, loose units, or both; `actualRemainingCases` and `actualRemainingEach` are persisted alongside the unit total.
- **Local Supabase dev stack with prod-mirrored schema.** `npm run dev:db` boots the full stack; seed regenerated against the post-P3 brand-catalog schema.
