# Inventory Management

A mobile inventory management system built for multi-location restaurant operations. The app provides end-to-end tracking of ingredients from vendor purchase through kitchen usage, with daily reconciliation against POS sales data.

## Purpose

Restaurant inventory is typically managed through manual spreadsheets and disconnected processes, leading to waste, stockouts, and unreliable food cost numbers. I.M.R consolidates these workflows into a single mobile app so that kitchen staff can count stock, log waste, and receive deliveries from their phone, while managers get real-time visibility into costs and variances across locations.

## Features

- **Dashboard** — KPI overview of inventory value, low-stock alerts, waste totals, and open purchase orders
- **Item management** — Track ingredients by category (protein, produce, dairy, dry goods, seafood, bakery, spices) with par levels, cost per unit, and vendor assignments
- **End-of-day counts** — Staff submit remaining quantities at close; the app compares against expected stock
- **Waste logging** — Record spoilage, over-prep, quality issues, and other loss with reason codes and automatic cost calculation
- **Recipe / BOM mapping** — Define ingredient quantities per menu item so POS sales automatically deduct inventory
- **POS import** — Upload CSV sales data from any POS system (Toast, Square, Clover, etc.) and auto-reconcile sold quantities against recipe-based expected usage
- **Reconciliation** — Side-by-side view of POS-expected vs. EOD-counted stock with match/mismatch/review flags
- **Vendor & purchase orders** — Manage vendor contacts, create POs, track draft/sent/received status, and confirm deliveries with quantity verification
- **Restock reports** — Identify items below par level that need reordering
- **Audit log** — Timestamped trail of every stock adjustment, waste entry, PO action, and POS import, filterable and exportable as CSV
- **User roles** — Admin (full access) and staff (counting, waste logging) with per-store assignments
- **Multi-store support** — Separate inventory and reporting per location (e.g. Towson, Baltimore)

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK 54 (React Native 0.81) |
| Language | TypeScript |
| Backend | Supabase (Auth, Postgres, real-time) |
| State | Zustand |
| Navigation | React Navigation (Drawer + Bottom Tabs + Stack) |
| CSV parsing | PapaParse |
| Animations | react-native-reanimated + react-native-gesture-handler |
| Icons | @expo/vector-icons (Ionicons) |

## Project Structure

```
App.tsx                          # Entry point with notification setup
src/
  navigation/AppNavigator.tsx    # Auth gate, drawer, and tab navigators
  screens/
    LoginScreen.tsx              # Email login with demo quick-login buttons
    DashboardScreen.tsx          # KPI cards and summary widgets
    ItemsScreen.tsx              # Inventory list with search, filters, add/edit
    EODCountScreen.tsx           # End-of-day remaining count form
    WasteLogScreen.tsx           # Log waste entries with reason codes
    POSImportScreen.tsx          # Upload and process POS CSV files
    ReconciliationScreen.tsx     # Compare expected vs. actual stock
    ReceivingScreen.tsx          # Confirm PO deliveries
    AdminScreens.tsx             # Recipes, vendors, POs, restock, audit log, users
  store/
    useSupabaseStore.ts          # Zustand store wired to Supabase
    useStore.ts                  # Offline/seed-data store (local mode)
  lib/
    supabase.ts                  # Supabase client initialization
    auth.ts                      # Sign in, sign out, session management
    db.ts                        # All database CRUD operations
  components/index.tsx           # Shared UI: Card, Badge, KpiCard, Button, etc.
  theme/colors.ts                # Design tokens (colors, spacing, radii, shadows)
  types/index.ts                 # TypeScript interfaces for all domain models
  data/seed.ts                   # Demo data for local development
  utils/index.ts                 # Formatting, calculations, CSV export helpers
```

## Getting Started

```bash
# Install dependencies
npm install

# Start the Expo dev server
npx expo start --clear --tunnel
```

Scan the QR code with Expo Go (iOS/Android) to run on a physical device.

## Demo Accounts

The login screen includes quick-login buttons for testing:

| Name             | Email              | Role  | Store Access        |
|------------------|--------------------|-------|---------------------|
| Admin (Owner)    | admin@towson.com   | Admin | Towson + Baltimore  |
| Maria Garcia     | maria@towson.com   | Staff | Towson              |
| James Thompson   | james@towson.com   | Staff | Towson              |
| Ana Rivera       | ana@baltimore.com  | Staff | Baltimore           |

## Role Permissions

### Admin
- Full access to all screens
- Add/edit inventory items with cost tracking
- Create and manage recipes (bill of materials)
- Manage vendors and create purchase orders
- Receive deliveries and update stock
- Upload POS CSV files and run reconciliation
- View reports and food cost analysis
- Full audit log access
- Invite users and assign store access

### Staff
- View inventory list
- Submit end-of-day counts
- Log waste/spoilage entries
- View restock report

## Building for Distribution

```bash
# iOS (TestFlight / App Store)
npx eas build --platform ios

# Android (Play Store / APK)
npx eas build --platform android
```

Requires an [Expo Application Services (EAS)](https://expo.dev/eas) account.
