// src/i18n/matchesQuery.ts
//
// Spec 039 — diacritic-folded, case-insensitive substring matcher for
// translated enum filter inputs. Returns true if `query` matches ANY
// candidate after both sides are normalized.
//
// Normalization:
//   1. NFD decompose (`é` → `e` + combining mark)
//   2. Strip diacritic marks (`\p{Diacritic}`)
//   3. Lowercase
//   4. Trim
//
// Usage:
//   const T = useT();
//   matchesQuery(input, [
//     wasteReasonLabel(r, T),       // localized
//     wasteReasonShortLabel(r, T),  // localized short
//     r,                             // English canonical (DB value)
//   ]);
//
// `String.prototype.normalize('NFD')` + `\p{Diacritic}` is ES2018-built-in
// on web, RN-iOS, and RN-Android+Hermes — no npm dependency needed. The
// existing `toLowerCase()` call sites on stable English data (pos_name,
// menuItem, itemName) stay untouched; this helper is for the translated
// enum surface search only.

// Public signature accepts nullable candidates because real call sites
// build the array from possibly-null DB row fields (e.g.
// `e.actorName ?? ''` would still typecheck, but `e.actorName` alone
// shouldn't force every caller to coalesce defensively). Internal
// `fold()` handles the null/undefined case.
export function matchesQuery(
  query: string,
  candidates: ReadonlyArray<string | null | undefined>,
): boolean {
  const q = fold(query);
  if (!q) return true; // empty filter matches everything
  return candidates.some((c) => fold(c).includes(q));
}

function fold(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}
