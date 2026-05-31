// e2e/fixtures/constants.ts — Spec 078 shared E2E constants.
//
// Single source of truth for the seed UUIDs, demo accounts, storageState
// paths, and the staff localStorage keys the specs reference. Keeping
// these here (not inline in each spec) means a seed refresh that moves a
// UUID is a one-file edit, and the §7 contract names live in one place.

// ─── Demo accounts (LOCAL seed only — never prod) ───────────────────────
// admin@local.test / master@local.test / manager@local.test, all password
// `password` (supabase/seed.sql). manager is role='user' (the staff
// branch) and is granted Towson + Frederick.
export const DEMO = {
  adminEmail: 'admin@local.test',
  staffEmail: 'manager@local.test',
  masterEmail: 'master@local.test',
  password: 'password',
} as const;

// ─── Per-role storageState paths (gitignored — carry live auth tokens) ──
export const STORAGE_STATE = {
  admin: 'e2e/.auth/admin.json',
  staff: 'e2e/.auth/staff.json',
  // master@local.test — the ONLY role that sees the Users & access section
  // and the invite-role chips. The Users surface is master-gated (Spec 030,
  // cmdSelectors.ts auth_is_master path): a plain `admin` never sees the
  // sidebar entry, so the invite flow must run under master.
  master: 'e2e/.auth/master.json',
} as const;

// ─── Seed UUIDs the EOD fixture + specs key off (supabase/seed.sql) ─────
// Towson store — manager@local.test is granted it (seed user_stores) and it
// has inventory_items for both vendors below. The OQ-4 fixture schedules
// these two vendors for every weekday so vendor chips + items always render.
export const SEED = {
  towsonStoreId: '00000000-0000-0000-0000-000000000001',
  frederickStoreId: '0f240390-edda-4b25-8c72-45eeb2ce1988',
  // Two vendors with Towson inventory_items → vendor-chip-{id} renders
  // (EODCount only shows the chip switcher when vendors.length > 1).
  vendorUsFoodId: '023cba00-1b67-4218-a906-cb18a8e62964',
  vendorRestaurantDepotId: '67b0d204-5e27-439a-bc06-3675444b3388',
} as const;

// TitleCase full weekday strings — exactly what EODCount.todayWeekday()
// (WEEKDAYS[d.getDay()]) writes/reads on order_schedule.day_of_week.
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// ─── Staff localStorage keys (src/screens/staff/lib/eodQueue.ts) ────────
// On web, AsyncStorage is backed by localStorage. The EOD specs clear the
// queue key in beforeEach (OQ-3c defense-in-depth) and may seed the
// active-store key so the staff session lands on EODCount deterministically
// (manager has two stores → StorePicker otherwise).
export const STAFF_QUEUE_KEY = 'imr-staff:eod-queue:v1';
export const STAFF_ACTIVE_STORE_KEY = 'imr-staff:active-store:v1';

// ─── Per-run token for uniquified inputs (OQ-3b) ────────────────────────
// invite uses e2e-invite+<runId>@local.test so a local re-run doesn't
// collide on a prior run's invited email. Prefer the CI run id when present
// so concurrent CI runs never collide; fall back to a wall-clock stamp.
export const RUN_ID = process.env.GITHUB_RUN_ID ?? String(Date.now());

export function uniqueInviteEmail(): string {
  return `e2e-invite+${RUN_ID}@local.test`;
}

// ─── Admin sidebar section nav testIDs (spec 079 §6 #2 — flake-kill) ─────
// The Cmd shell has no URL/linking config (RoleRouter ships without it);
// sections switch via in-shell state driven by sidebar clicks. Spec 078
// navigated by clicking the visible i18n LABEL text, which is fragile to
// copy/i18n changes AND can match a stray occurrence of the same string
// elsewhere on screen (forcing a brittle `.first()`). Spec 079 added a
// stable `nav-${item.id}` testID to the navigable sidebar TouchableOpacity
// (src/components/cmd/TreeGroup.tsx — the FROZEN §6 contract), so the specs
// navigate by `getByTestId(SIDEBAR_NAV.x)` — no label text, no i18n coupling,
// no `.first()`. The ids are stable code constants from cmdSelectors.ts
// (`Dashboard` / `Reorder` / `AuditLog` / `Users`), NOT the display labels.
export const SIDEBAR_NAV = {
  dashboard: 'nav-Dashboard',
  reorder: 'nav-Reorder',
  auditLog: 'nav-AuditLog',
  users: 'nav-Users',
} as const;
