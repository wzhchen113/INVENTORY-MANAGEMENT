// src/screens/cmd/sections/phone/weeklyVariance.ts — Spec 144.
//
// Pure, dependency-free variance classifier for the phone-tier weekly
// (inventory) count worksheet. No React, no store, no `supabase` — a cheap jest
// unit surface that pins the ±15% danger boundary + the "matches system" epsilon
// without rendering the section. Consumed by `PhoneWeeklyCount.tsx`.
//
// Mirrors the design prototype 1:1 (`IMR Phone Console.dc.html`, weekly frame):
//   dv = countedTotal - systemOnHand
//   matches when |dv| < 0.01  → ok
//   else  |dv| / max(1, sys) > 0.15  → danger, otherwise warn
// The `Math.max(1, …)` denominator matches the prototype so a tiny system
// on-hand (or 0) can't blow the percentage up to Infinity.

export type VarianceTone = 'ok' | 'warn' | 'danger';

export interface WeeklyVariance {
  /** Signed difference: countedTotal − systemOnHand (>0 = over system). */
  diff: number;
  /** True when the count matches the system within the display epsilon. */
  matches: boolean;
  /** Semantic tone for the variance line (never the accent — §91). */
  tone: VarianceTone;
}

/** Epsilon under which counted and system are treated as equal (prototype). */
export const VARIANCE_MATCH_EPSILON = 0.01;

/** Fractional variance past which the tone escalates to danger (prototype). */
export const VARIANCE_DANGER_THRESHOLD = 0.15;

/**
 * Classify a weekly count entry against the system on-hand. Pure + total.
 *
 * At exactly ±15% the tone is `warn` (danger is `> 0.15`, matching the
 * prototype's strict inequality — the ±15% boundary jest test pins this).
 */
export function weeklyVariance(countedTotal: number, systemOnHand: number): WeeklyVariance {
  const diff = countedTotal - systemOnHand;
  if (Math.abs(diff) < VARIANCE_MATCH_EPSILON) {
    return { diff: 0, matches: true, tone: 'ok' };
  }
  const pct = Math.abs(diff) / Math.max(1, systemOnHand);
  return { diff, matches: false, tone: pct > VARIANCE_DANGER_THRESHOLD ? 'danger' : 'warn' };
}
