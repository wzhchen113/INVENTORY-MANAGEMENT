// src/hooks/useLocalizedName.ts
//
// Spec 040 P3 — convenience hook that resolves a row to its localized
// display name. Subscribes to the locale slice the same way `useT()` does,
// so a locale switch re-renders every consumer.
//
// Usage:
//   const name = useLocalizedName(item);
//   <Text>{name}</Text>
//
// Per architect §5 the function body is O(1) (two property reads + one
// ternary); per-row memoization at the hook level would cost more in
// React render bookkeeping than it saves. Callers that compose into a
// large list and need a stable identity can wrap their own
// `useMemo(() => rows.map((r) => getLocalizedName(r, locale)), [rows, locale])`
// instead of memoizing the hook return.

import { useLocale } from './useLocale';
import { getLocalizedName, LocalizableRow } from '../i18n/localizedName';

export function useLocalizedName(row: LocalizableRow | null | undefined): string {
  const locale = useLocale();
  return getLocalizedName(row, locale);
}
