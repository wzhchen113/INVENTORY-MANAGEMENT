// src/i18n/localizedName.ts
//
// Spec 040 P3 — pure resolver from a translatable row + active locale to a
// rendered display string. Single source of truth for the "silent English
// fallback" rule documented in spec 040 §Acceptance / Q3 — no `(en)` tag,
// no `[untranslated]` placeholder.
//
// Resolution order:
//   1. English mode → return the canonical English column (`menuItem` if
//      present — recipes — else `name`).
//   2. Non-English mode with a non-empty `i18nNames[locale]` → return the
//      localized string.
//   3. Otherwise → return the canonical English column (silent fallback).
//
// Whitespace-only translations count as "missing" — `.trim().length > 0`.
// This shields the UI from `{"es": "   "}` rows that would otherwise
// render a blank in Spanish mode where the English canonical is non-empty.
//
// Null / undefined rows are tolerated and return `''`. This matches the
// callsites that pass `inventory.find(...)` or `recipes.find(...)` which
// can resolve to `undefined`. The hook avoids these by guarding upstream,
// but the pure function is the test surface and must be total.

import type { Locale } from './index';
import type { LocalizedNames } from '../types';

/**
 * Row shape consumed by `getLocalizedName`. The fields are all optional /
 * nullable so a single helper covers all five translatable entity types
 * (catalog ingredients, recipes, prep recipes, recipe categories,
 * ingredient categories). Callers pass whichever fields exist on their
 * own row type — `name` for four of the five, `menuItem` for recipes.
 *
 * Spec 040 architect §5 — the helper picks `menuItem` first to support
 * the recipes table, falling back to `name`. The five tables never carry
 * BOTH columns on a single row, so there's no ambiguity.
 */
export type LocalizableRow = {
  name?: string | null;
  menuItem?: string | null;
  i18nNames?: LocalizedNames | null;
};

/**
 * Pure resolver. See module docstring for rules.
 */
export function getLocalizedName(
  row: LocalizableRow | null | undefined,
  locale: Locale,
): string {
  if (!row) return '';
  const canonical = (row.menuItem ?? row.name ?? '') || '';
  if (locale === 'en') return canonical;
  const localized = row.i18nNames?.[locale];
  if (typeof localized === 'string' && localized.trim().length > 0) {
    return localized;
  }
  return canonical;
}
