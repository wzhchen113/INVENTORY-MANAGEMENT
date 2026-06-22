// src/utils/enumLabels.ts
//
// Spec 039 — display-side translators for the curated enum families
// (waste reason / user role / inventory-count kind / user status /
// day-of-week / unit). Each resolver is a pure function that takes the
// stored canonical value plus the active-locale `T` and returns the
// translated display string.
//
// Pattern: every call site is already inside a component that has
// `T = useT()` in scope; pure functions stay testable without
// renderHook + keep the lookup-as-data shape obvious. See spec 039
// §1(a) for the rationale (pass-T over new-hook).
//
// Fallbacks mirror `formatAuditAction`: an unknown value flows through
// unchanged so legacy / unmapped rows don't render as `undefined`.

import type { WasteReason, UserRole, InventoryCountKind } from '../types';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

export type UserStatus = 'active' | 'pending';

export type DayName =
  | 'Sunday'
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

// ─── Waste reason ────────────────────────────────────────────────────
// Display form (Sentence case) + sibling short form for the
// filter-chip rendering used in WasteLogSection.
const WASTE_REASON_KEY: Record<WasteReason, string> = {
  'Expired':         'expired',
  'Dropped/spilled': 'droppedSpilled',
  'Over-prepped':    'overPrepped',
  'Quality issue':   'qualityIssue',
  'Theft':           'theft',
  'Other':           'other',
};

export function wasteReasonLabel(r: WasteReason, T: TFn): string {
  const key = WASTE_REASON_KEY[r];
  return key ? T(`enum.wasteReason.${key}`) : r;
}

export function wasteReasonShortLabel(r: WasteReason, T: TFn): string {
  const key = WASTE_REASON_KEY[r];
  return key ? T(`enum.wasteReason.short.${key}`) : r.toLowerCase();
}

// ─── User role ───────────────────────────────────────────────────────
const ROLE_KEY: Record<UserRole, string> = {
  user:        'user',
  admin:       'admin',
  master:      'master',
  super_admin: 'superAdmin',
};

export function roleLabel(role: UserRole, T: TFn): string {
  const key = ROLE_KEY[role];
  return key ? T(`enum.role.${key}`) : role;
}

// ─── Inventory-count kind ────────────────────────────────────────────
const KIND_KEY: Record<InventoryCountKind, string> = {
  spot:      'spot',
  open:      'open',
  mid_shift: 'midShift',
  close:     'close',
  weekly:    'weekly',   // spec 098 — staff weekly full-store count
};

export function inventoryCountKindLabel(k: InventoryCountKind, T: TFn): string {
  const key = KIND_KEY[k];
  return key ? T(`enum.inventoryCountKind.${key}`) : k;
}

export function inventoryCountKindSubLabel(k: InventoryCountKind, T: TFn): string {
  const key = KIND_KEY[k];
  return key ? T(`enum.inventoryCountKind.sub.${key}`) : '';
}

// ─── User status ─────────────────────────────────────────────────────
export function userStatusLabel(s: UserStatus, T: TFn): string {
  return T(`enum.userStatus.${s}`);
}

// ─── Day-of-week ─────────────────────────────────────────────────────
// DB join keys (`order_schedule.day` and the literal arrays in
// EOD / OrderSchedule sections) continue to use the English canonical
// (`'Monday' ... 'Sunday'`); only the rendered text routes through `T`.
const DAY_KEY: Record<DayName, string> = {
  Sunday:    'sunday',
  Monday:    'monday',
  Tuesday:   'tuesday',
  Wednesday: 'wednesday',
  Thursday:  'thursday',
  Friday:    'friday',
  Saturday:  'saturday',
};

export function dayOfWeekShortLabel(d: DayName, T: TFn): string {
  const key = DAY_KEY[d];
  return key ? T(`enum.dayOfWeek.short.${key}`) : d;
}

export function dayOfWeekLongLabel(d: DayName, T: TFn): string {
  const key = DAY_KEY[d];
  return key ? T(`enum.dayOfWeek.long.${key}`) : d;
}

// ─── Unit ────────────────────────────────────────────────────────────
// The DB stores `fl_oz` with an underscore; JSON dot-paths use the
// camelCase `flOz`. Other CANONICAL_UNITS entries already match a-z.
// Unknown one-off purchase units (e.g. a free-text conversion row
// not on `CANONICAL_UNITS`) fall through to the raw value unchanged —
// same shape as formatAuditAction's fallback.
const UNIT_KEY: Record<string, string> = {
  g:     'g',
  kg:    'kg',
  oz:    'oz',
  lbs:   'lbs',
  fl_oz: 'flOz',
  cups:  'cups',
  qt:    'qt',
  gal:   'gal',
  each:  'each',
  cases: 'cases',
  bags:  'bags',
};

export function unitLabel(unit: string | null | undefined, T: TFn): string {
  const u = (unit || '').toLowerCase().trim();
  if (!u) return '';
  const camel = UNIT_KEY[u];
  return camel ? T(`enum.unit.${camel}`) : unit ?? '';
}
