// src/screens/staff/lib/unitLabel.ts — on-screen unit token for the staff
// count surfaces (EOD row + keypad sheet).
//
// Same posture as reorderExportStaff's `unitOf`: `en` shows the stored
// `catalog_ingredients.unit` exactly as typed; es / zh-CN go through the
// shared `enum.unit.*` dictionary via `localizeUnit`. Units with no
// dictionary entry pass through unchanged.

import { localizeUnit } from '../../../utils/reorderExport';
import type { Locale } from '../i18n';

export function staffUnitLabel(unit: string, locale: Locale): string {
  return locale === 'en' ? unit : localizeUnit(unit, locale);
}
