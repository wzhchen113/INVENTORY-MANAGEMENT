// src/hooks/useLocale.ts
//
// Spec 038 — single-slice selector that returns the active locale.
// Mirrors the useColors() / useCmdColors() hook shape: components that
// only need to read the locale subscribe to this hook and re-render
// when locale changes.

import { useStore } from '../store/useStore';
import type { Locale } from '../i18n';

export type { Locale };

export function useLocale(): Locale {
  return useStore((s) => s.locale);
}
