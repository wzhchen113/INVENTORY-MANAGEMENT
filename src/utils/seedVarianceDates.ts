// src/utils/seedVarianceDates.ts
//
// Spec 018 (REPORTS-3) — variance template seeds the prior/current EOD
// inputs from the most-recent two submitted EODs. Extracted from
// `src/components/cmd/NewReportModal.tsx` (spec 023 / B4) so the
// db.ts-boundary mock pattern can be exercised cleanly in a wired
// jest test — see `src/utils/seedVarianceDates.test.ts`.
//
// Behavior contract (preserved verbatim from the inlined original):
//   (a) Call fetchRecentEodDates(storeId, 2).
//   (b) If the helper returns >= 2 dates, return { from: dates[1],
//       to: dates[0], eodCount: dates.length }. The helper returns
//       descending: index 0 is most-recent (current anchor),
//       index 1 is second-most-recent (prior anchor).
//   (c) If shorter, return blank strings + the observed count (0/1).
//   (d) On throw, return all blanks with eodCount: 0.
// The try/catch and the descending-order convention are part of the
// contract — the modal's "danger hint" branch reads eodCount = 0/1
// to surface "Submit at least two EODs to enable variance".

import { fetchRecentEodDates } from '../lib/db';

export async function seedVarianceDates(
  storeId: string,
): Promise<{ from: string; to: string; eodCount: number }> {
  try {
    const dates = await fetchRecentEodDates(storeId, 2);
    if (Array.isArray(dates) && dates.length >= 2) {
      return { from: dates[1], to: dates[0], eodCount: dates.length };
    }
    return { from: '', to: '', eodCount: Array.isArray(dates) ? dates.length : 0 };
  } catch {
    return { from: '', to: '', eodCount: 0 };
  }
}
