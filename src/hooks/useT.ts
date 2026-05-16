// src/hooks/useT.ts
//
// Spec 038 — translation hook. Returns a memoized function bound to the
// active locale. Components consume:
//
//   const T = useT();
//   <Text>{T('sidebar.groups.operations')}</Text>
//   <Text>{T('chrome.eodFooter', { submittedCount: 3, totalCount: 5 })}</Text>
//
// `T`'s identity changes when locale changes — consumers that pass `T`
// to `useMemo` / `useCallback` dep arrays re-evaluate correctly on
// locale switch. See architect §8b for the convention on adding `T` to
// dep arrays when memoizing translated text.

import { useCallback } from 'react';
import { useLocale } from './useLocale';
import { t } from '../i18n';

export function useT() {
  const locale = useLocale();
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
}
