// Spec 132 (D-4) — per-item success/failure report assembly (AC-7). Pure +
// total: combines the plan (what we intended) with the execution results (what
// the site did) into the report the admin sees BEFORE reviewing/paying. Renders
// in dry-run too, as 'would-add' (AC-10). Adapter-agnostic — unit-tested (AC-12).

import type { ExecutionResult, PlannedAction, ReportLine, ReportStatus } from '../lib/types';

const UNMATCHED_DETAIL = 'No vendor order code and no product-page URL — resolve in I.M.R (AC-5).';
const WOULD_ADD_DETAIL_URL = 'Dry-run: would open the stored product page and add to cart.';
const WOULD_ADD_DETAIL_SEARCH = 'Dry-run: would search the site for the order code and add to cart.';
const NO_RESULT_DETAIL = 'No execution result returned for this line.';

/**
 * Assemble the per-item report (AC-7).
 *
 *   • An 'unmapped' plan line is ALWAYS 'unmatched' (both modes) — never guessed
 *     (AC-5).
 *   • dry-run  → every resolvable line renders 'would-add' with the intended
 *     action logged in `detail`; NO execution results are consulted (there are
 *     none — the dry-run gate performed no side effect, D-5).
 *   • live     → each resolvable line maps its ExecutionResult.outcome →
 *     'added' | 'ambiguous' | 'failed'. A resolvable line with no matching
 *     result is reported 'failed' (fail-loud, never silently dropped).
 */
export function assembleReport(
  plan: PlannedAction[],
  results: ExecutionResult[],
  dryRun: boolean,
): ReportLine[] {
  const resultById = new Map<string, ExecutionResult>();
  for (const r of results) resultById.set(r.itemId, r);

  return plan.map((a) => {
    const base = {
      itemId: a.itemId,
      orderCode: a.orderCode,
      itemName: a.itemName,
      qty: a.qty,
      unit: a.unit,
    };

    if (a.resolution === 'unmapped') {
      return { ...base, status: 'unmatched' as ReportStatus, detail: UNMATCHED_DETAIL };
    }

    if (dryRun) {
      return {
        ...base,
        status: 'would-add' as ReportStatus,
        detail: a.resolution === 'url' ? WOULD_ADD_DETAIL_URL : WOULD_ADD_DETAIL_SEARCH,
      };
    }

    const result = resultById.get(a.itemId);
    if (!result) {
      return { ...base, status: 'failed' as ReportStatus, detail: NO_RESULT_DETAIL };
    }
    const status: ReportStatus =
      result.outcome === 'added' ? 'added' : result.outcome === 'ambiguous' ? 'ambiguous' : 'failed';
    return { ...base, status, detail: result.detail };
  });
}

/** A compact summary for the popup header (AC-7). */
export interface ReportSummary {
  added: number;
  wouldAdd: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
  total: number;
}

export function summarizeReport(report: ReportLine[]): ReportSummary {
  const s: ReportSummary = {
    added: 0,
    wouldAdd: 0,
    unmatched: 0,
    ambiguous: 0,
    failed: 0,
    total: report.length,
  };
  for (const line of report) {
    if (line.status === 'added') s.added += 1;
    else if (line.status === 'would-add') s.wouldAdd += 1;
    else if (line.status === 'unmatched') s.unmatched += 1;
    else if (line.status === 'ambiguous') s.ambiguous += 1;
    else if (line.status === 'failed') s.failed += 1;
  }
  return s;
}
