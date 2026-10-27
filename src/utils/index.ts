// src/utils/index.ts
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { InventoryItem, Recipe, WasteEntry } from '../types';

/** Filter input to only allow numeric values (digits, one decimal point, max 3 decimal places) */
export const numericFilter = (value: string): string => {
  let v = value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  const dotIndex = v.indexOf('.');
  if (dotIndex !== -1) {
    v = v.slice(0, dotIndex + 4); // dot + max 3 digits
  }
  return v;
};

/** Format a number as US currency */
export const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

/** Format a decimal to 2 places, stripping trailing zeros */
export const formatQty = (value: number, decimals = 2): string => {
  const fixed = value.toFixed(decimals);
  return parseFloat(fixed).toString();
};

/** Calculate inventory value for a single item */
export const itemValue = (item: InventoryItem): number =>
  item.currentStock * item.costPerUnit;

/** Calculate total inventory value */
export const totalInventoryValue = (items: InventoryItem[]): number =>
  items.reduce((sum, item) => sum + itemValue(item), 0);

/** Calculate recipe ingredient cost */
export const recipeCost = (recipe: Recipe, inventory: InventoryItem[]): number =>
  recipe.ingredients.reduce((sum, ing) => {
    const item = inventory.find((i) => i.id === ing.itemId);
    return sum + (item ? item.costPerUnit * ing.quantity : 0);
  }, 0);

/** Calculate food cost % */
export const foodCostPct = (cost: number, sellPrice: number): number => {
  if (sellPrice === 0) return 0;
  return (cost / sellPrice) * 100;
};

/** Total waste value */
export const totalWasteValue = (entries: WasteEntry[]): number =>
  entries.reduce((sum, e) => sum + e.quantity * e.costPerUnit, 0);

/** Get initials from a full name */
export const getInitials = (name: string): string =>
  name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** Check if a date is expiring within N days */
export const isExpiringSoon = (dateStr: string, days = 3): boolean => {
  if (!dateStr) return false;
  const expiry = new Date(dateStr + ' 2025');
  const now = new Date();
  const diff = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= days;
};

/** Format relative time */
export const relativeTime = (timestamp: string): string => {
  const now = new Date();
  const then = new Date(timestamp);
  const diff = now.getTime() - then.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

/** User color map */
export const USER_COLORS: Record<string, string> = {
  'Admin': '#378ADD',
  'Admin (Owner)': '#378ADD',
  'Maria G.': '#1D9E75',
  'Maria Garcia': '#1D9E75',
  'James T.': '#D85A30',
  'James Thompson': '#D85A30',
  'Ana R.': '#D4537E',
  'Ana Rivera': '#D4537E',
};

export const getUserColor = (name: string): string =>
  USER_COLORS[name] || USER_COLORS[name.split(' ').slice(0, 2).join(' ')] || '#888780';

/** Variance status for reconciliation */
export type VarianceResult = 'match' | 'review' | 'mismatch';

export const getVarianceResult = (variance: number, threshold = 5): VarianceResult => {
  const abs = Math.abs(variance);
  if (abs === 0) return 'match';
  if (abs <= threshold) return 'review';
  return 'mismatch';
};

/** Sort comparator: numbers first, then A-Z */
export const numFirstSort = (a: string, b: string): number => {
  const aNum = /^\d/.test(a);
  const bNum = /^\d/.test(b);
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  return a.localeCompare(b);
};

/** Generate PO number */
let poSeq = 6;
export const generatePONumber = (): string => `PO-${String(++poSeq).padStart(3, '0')}`;

/** Export array of objects to CSV string */
/**
 * Download a CSV file in the browser.
 *
 * Spec 139 — prepends a UTF-8 BOM (`﻿`) additively so exports carrying
 * non-ASCII text (accented es / CJK zh-CN ingredient + menu-item names) open
 * with correct characters in Excel instead of mojibake. The BOM is a 3-byte
 * prefix that changes NO column output; every existing caller (the catalog
 * `ExportCsvDrawer`, the RecipesSection menu-BOM export, and the new count
 * exports) keeps working unchanged, and Excel / Google Sheets both treat a
 * leading BOM as the UTF-8 signal. Reorder's separate `triggerDownload` is a
 * distinct code path and is intentionally NOT touched.
 *
 * Spec 181 (C1) — returns a Promise.
 *   - web: the synchronous Blob/anchor body below runs VERBATIM (a synchronous
 *     throw still throws synchronously, so non-awaiting callers' try/catch keeps
 *     working), then an already-resolved promise is returned.
 *   - native: writes the BOM-prefixed CSV to the cache dir and opens the OS
 *     share sheet (`shareCsvNative`). Resolves when the sheet closes; REJECTS
 *     when sharing is unavailable or the write/share fails. It does not toast —
 *     the caller owns the toast.
 */
export const downloadCSV = (filename: string, csvContent: string): Promise<void> => {
  if (Platform.OS !== 'web') {
    return shareCsvNative(filename, '\uFEFF' + csvContent);
  }
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return Promise.resolve();
};

// Native CSV share — mirrors src/screens/staff/lib/shareReorder.ts `nativeShare`
// (duplicated on purpose: admin code must not depend on the verbatim-port staff
// subtree). expo-file-system v19 object API, cache dir (ephemeral, no
// permission prompt). Availability is checked BEFORE writing so an unavailable
// platform leaves no orphaned temp file.
async function shareCsvNative(filename: string, content: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device');
  }
  // The name becomes a path segment under Paths.cache — never let a caller's
  // filename introduce a directory separator.
  const safeName = filename.replace(/[\\/]/g, '_');
  const file = new File(Paths.cache, safeName);
  file.create({ overwrite: true });
  file.write(content);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: safeName,
  });
}

export const toCSV = (data: Record<string, any>[], columns: string[]): string => {
  const header = columns.join(',');
  const rows = data.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === undefined || val === null) return '';
      const str = String(val);
      return str.includes(',') ? `"${str}"` : str;
    }).join(',')
  );
  return [header, ...rows].join('\n');
};
