# Towson Inventory — React Native App

A full MarketMan-style restaurant inventory management app built with Expo + React Native.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK 51 (React Native 0.74) |
| Language | TypeScript |
| Navigation | React Navigation (Drawer + Stack) |
| State | Zustand |
| CSV parsing | PapaParse |
| File picker | expo-document-picker |
| Notifications | expo-notifications |
| Icons | @expo/vector-icons (Ionicons) |

---

## Quick Start

### 1. Install Expo CLI

```bash
npm install -g expo-cli
```

### 2. Install dependencies

```bash
cd towson-inventory
npm install
```

### 3. Start the dev server

```bash
npx expo start
```

### 4. Run on device

- **iOS**: Scan QR code with iPhone Camera app (requires Expo Go app)
- **Android**: Scan QR code with Expo Go app
- **iOS Simulator**: Press `i` in terminal
- **Android Emulator**: Press `a` in terminal

---

## Project Structure

```
towson-inventory/
├── App.tsx                      # Root entry point
├── app.json                     # Expo config
├── package.json
├── tsconfig.json
└── src/
    ├── types/
    │   └── index.ts             # All TypeScript interfaces
    ├── data/
    │   └── seed.ts              # Sample data (inventory, users, recipes, etc.)
    ├── store/
    │   └── useStore.ts          # Zustand global state + all actions
    ├── theme/
    │   └── colors.ts            # Design tokens (colors, spacing, radius, fonts)
    ├── components/
    │   └── index.tsx            # Shared UI components (Card, Badge, WhoChip, etc.)
    ├── navigation/
    │   └── AppNavigator.tsx     # Drawer + Stack navigation with auth gate
    ├── screens/
    │   ├── LoginScreen.tsx      # Login + demo account quick-select
    │   ├── DashboardScreen.tsx  # KPIs, alerts, EOD status, open POs
    │   ├── ItemsScreen.tsx      # Inventory list with cost tracking + add/edit
    │   ├── EODCountScreen.tsx   # End-of-day count form (with user attribution)
    │   ├── WasteLogScreen.tsx   # Log waste/spoilage with reason + cost calc
    │   ├── POSImportScreen.tsx  # Upload POS CSV, map columns, reconcile
    │   ├── ReconciliationScreen.tsx  # POS vs EOD variance analysis
    │   ├── ReceivingScreen.tsx  # Confirm deliveries against POs
    │   └── AdminScreens.tsx     # Recipes, Vendors, POs, Restock, Audit, Reports, Users
    └── utils/
        └── index.ts             # Helper functions (formatting, calculations)
```

---

## Demo Accounts

| Email | Role | Store |
|---|---|---|
| admin@towson.com | Admin (all access) | Towson + Baltimore |
| maria@towson.com | Store user | Towson only |
| james@towson.com | Store user | Towson only |
| ana@baltimore.com | Store user | Baltimore only |

No password required in demo mode — just tap the account.

---

## Role Permissions

### Admin
- Full access to all screens
- Add/edit inventory items with cost tracking
- Create and manage recipes (bill of materials)
- Manage vendors and create purchase orders
- Receive deliveries and update stock
- Upload POS CSV files from third-party systems
- View reconciliation (POS vs EOD variance)
- View reports: food cost %, usage trends, waste analysis
- Full audit log (filterable, exportable)
- Invite users and assign store access
- View all users and their activity

### Store User
- View inventory list (read-only)
- Submit end-of-day count (attributed to their name)
- Log waste/spoilage entries (attributed to their name)
- View restock report
- Cannot access: POS import, reconciliation, vendors, purchase orders, audit log, user management

---

## Key Features

### 1. Full Audit Trail
Every action is recorded: who entered what, when, and from which store. Filter by user, action type, or store. Export as CSV.

### 2. Recipe / Bill of Materials
Map each POS menu item to exact ingredient quantities. When you import sales data, the app deducts the precise ingredient amounts rather than estimates.

### 3. EOD Count with User Attribution
Staff submit end-of-day remaining quantities from their account. The reconciliation screen shows exactly who entered each count and at what time.

### 4. POS CSV Import
Upload a CSV from any POS system (Toast, Square, Clover, etc.). The app auto-detects columns, matches menu items to recipes, and deducts inventory accordingly.

### 5. Waste Log
Staff log any waste with reason (expired, dropped, over-prepped, etc.). The app calculates the dollar cost automatically and feeds it into food cost reporting.

### 6. Receiving Workflow
When a delivery arrives, open the purchase order and enter actual received quantities. Short deliveries are flagged automatically.

### 7. Food Cost Reporting
Real-time food cost % by category and by recipe. Flags items above target threshold immediately.

---

## Connecting to a Real Backend (Supabase)

This app ships with local Zustand state. To make it persistent and multi-device:

### 1. Create a Supabase project at supabase.com

### 2. Install the client
```bash
npm install @supabase/supabase-js
```

### 3. Create tables (SQL)
```sql
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  store_id text, name text, category text, unit text,
  cost_per_unit numeric, current_stock numeric, par_level numeric,
  vendor_id text, usage_per_portion numeric, expiry_date text,
  last_updated_by text, last_updated_at text, eod_remaining numeric
);

create table users (
  id uuid primary key default gen_random_uuid(),
  name text, email text unique, role text,
  stores text[], status text, initials text, color text
);

create table waste_log (
  id uuid primary key default gen_random_uuid(),
  item_id text, item_name text, quantity numeric, unit text,
  cost_per_unit numeric, reason text, logged_by text,
  logged_by_user_id text, timestamp text, notes text, store_id text
);

create table eod_submissions (
  id uuid primary key default gen_random_uuid(),
  date text, store_id text, submitted_by text,
  submitted_by_user_id text, timestamp text,
  item_count int, status text
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  timestamp text, user_id text, user_name text,
  user_role text, store_id text, store_name text,
  action text, detail text, item_ref text, value text
);
```

### 4. Replace Zustand store with Supabase calls
Update `src/store/useStore.ts` to call `supabase.from('table').insert(...)` etc.

---

## Building for Distribution

### iOS (TestFlight / App Store)
```bash
npx eas build --platform ios
```

### Android (Play Store / APK)
```bash
npx eas build --platform android
```

Requires an [Expo Application Services (EAS)](https://expo.dev/eas) account — free tier available.

---

## Next Steps

1. Connect to Supabase for persistent multi-device data
2. Add barcode scanning with `expo-barcode-scanner`
3. Add offline support with `expo-sqlite`
4. Add push notification alerts for low stock
5. Add Google Sheets sync for existing inventory data
6. Build a multi-location roll-up dashboard
