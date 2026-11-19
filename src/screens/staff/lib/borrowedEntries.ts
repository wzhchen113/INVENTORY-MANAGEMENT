// src/screens/staff/lib/borrowedEntries.ts — Spec 200 (design §3).
//
// Pure, dependency-free rules for the staff EOD "count a shared item once"
// overlay. No React, no store, no `supabase`. The screen (EODCount.tsx) only
// decides "own vs borrowed" from `deriveBorrowedEntries`'s map; every source
// and ordering decision lives here so it is a cheap jest surface (AC-1).
//
// Cross-spec contract (spec 200 §1 = spec 201 §2, migration
// 20261118120000_reorder_primary_wins_borrowed_count.sql CTE `eod_borrow_source`):
//   - candidates: eod_submissions at (store, date) with status 'submitted',
//     ANY vendor (incl. a legacy null vendor) — this screen also drops the
//     selected vendor (its own entry always wins in its own tab);
//   - order: submitted_at DESC NULLS LAST, then submission id DESC, at full
//     MICROSECOND precision (`Date.parse` alone truncates to ms — don't
//     "simplify" the composite key below);
//   - per item, the first candidate holding a borrowable entry wins. Staff
//     borrowable = `actual_remaining IS NOT NULL` OR `no_need = true`; a legacy
//     blank entry is skipped and the next candidate is tried.
// Staff-only overlay (R1/R2): this device's queued submissions for the
// signed-in user sit on top — a queued submission replaces its vendor's server
// one entirely (it overwrites it on drain), and ranks by `queued_at`.

import type { BorrowedEntry, EodEntry, QueuedSubmission, ServerEodSource } from './types';

/** Contract rule 4 (staff): a numeric count or a NO NEED mark. */
export function isBorrowable(entry: EodEntry): boolean {
  return entry.no_need === true || entry.actual_remaining != null;
}

/**
 * One entry's display/seed values — `seedFromExisting`'s per-entry rule,
 * extracted verbatim so the own seed and the borrowed display can't drift
 * (R4):
 *   - Cases ← `actual_remaining_cases` (blank when null);
 *   - Units ← `actual_remaining_each`, else — only when Cases is ALSO null —
 *     the legacy total `actual_remaining` (spec 086 OQ-4). A cases-only row
 *     (spec 171) leaves Units blank, never re-derived from the total;
 *   - NO NEED (spec 172) → the mark, with both boxes blank (its numerics are
 *     null, so they stay blank — never "0").
 */
export function entrySeed(entry: EodEntry): { caseRaw: string; unitRaw: string; noNeed: boolean } {
  const caseRaw =
    entry.actual_remaining_cases != null ? String(entry.actual_remaining_cases) : '';
  const units =
    entry.actual_remaining_each != null
      ? entry.actual_remaining_each
      : entry.actual_remaining_cases == null
        ? entry.actual_remaining
        : null;
  return {
    caseRaw,
    unitRaw: units != null ? String(units) : '',
    noNeed: entry.no_need === true,
  };
}

/**
 * R8 exception (all-borrowed vendor) — a VERBATIM copy of a borrowed entry for
 * this vendor's payload: the same four fields, never rebuilt through the
 * live-mode `eodRowEntryValues` (R7). `no_need` is carried only when true
 * (§6.3 shape); a numeric copy has no `no_need` key (design §9).
 */
export function borrowedEntryCopy(itemId: string, entry: EodEntry): EodEntry {
  if (entry.no_need === true) {
    return {
      item_id: itemId,
      actual_remaining: null,
      actual_remaining_cases: null,
      actual_remaining_each: null,
      no_need: true,
    };
  }
  return {
    item_id: itemId,
    actual_remaining: entry.actual_remaining,
    actual_remaining_cases: entry.actual_remaining_cases,
    actual_remaining_each: entry.actual_remaining_each,
  };
}

// ─── AC-20: stock check before sending all-borrowed copies ───────────────

/**
 * True iff two on-hand quantities are the same number. Accepts PostgREST's
 * number-or-string numerics ("5.000" equals 5). Compared at 6 decimal places
 * so float noise can't create a false mismatch (`current_stock` and
 * `actual_remaining` are numeric(10,3)). A null / blank / unparseable side is
 * never equal (fail closed).
 */
export function sameQuantity(
  a: number | string | null | undefined,
  b: number | string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  if (typeof a === 'string' && a.trim() === '') return false;
  if (typeof b === 'string' && b.trim() === '') return false;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.round(x * 1e6) === Math.round(y * 1e6);
}

/**
 * AC-20 — the copied items whose borrowed count no longer equals the item's
 * live `current_stock`, so stock changed after that count (or the source is a
 * queued count the server hasn't written yet). Those copies must NOT be sent:
 * the writer would reset on-hand to the stale count. Returned in `copies`
 * order. NO NEED copies are skipped (they never write on-hand). An item missing
 * from `stock`, or with a null stock, counts as a mismatch (fail closed).
 */
export function stockMismatchIds(
  copies: readonly EodEntry[],
  stock: ReadonlyMap<string, number | string | null>,
): string[] {
  const out: string[] = [];
  for (const c of copies) {
    if (c.no_need === true) continue;
    if (!sameQuantity(stock.get(c.item_id), c.actual_remaining)) out.push(c.item_id);
  }
  return out;
}

// ─── timestamp parsing (microsecond-faithful) ────────────────────────────

// The fractional-seconds group of an ISO timestamp ("…T20:00:00.123456+00:00").
// PostgREST emits up to 6 digits and trims trailing zeros.
const FRACTION_RE = /([T ]\d{2}:\d{2}:\d{2})\.(\d+)/;

/**
 * `ms` = epoch milliseconds (null / unparseable → -Infinity, i.e. NULLS LAST);
 * `subMs` = the microsecond digits below the millisecond (0..999). The
 * fraction is normalized to exactly 3 digits before `Date.parse`, because
 * engines disagree on longer fractions.
 */
export function parseTimestamp(iso: string | null | undefined): { ms: number; subMs: number } {
  if (iso == null) return { ms: -Infinity, subMs: 0 };
  const m = FRACTION_RE.exec(iso);
  let subMs = 0;
  let normalized = iso;
  if (m) {
    const six = (m[2] + '000000').slice(0, 6);
    subMs = Number(six.slice(3, 6));
    normalized = iso.replace(FRACTION_RE, `$1.${six.slice(0, 3)}`);
  }
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return { ms: -Infinity, subMs: 0 };
  return { ms, subMs };
}

// ─── ranking ───────────────────────────────────────────────────────────

type Candidate = {
  source: 'server' | 'queued';
  ms: number;
  /** Server only (queued → 0): sub-millisecond microsecond digits. */
  subMs: number;
  /** Server: submission id; queued: client_uuid. Lowercase. */
  tie: string;
  vendorId: string | null;
  vendorName: string | null;
  entries: EodEntry[];
};

/**
 * One transitive composite key, DESCENDING (design §3 step 4):
 *   epoch ms → (equal ms) queued before server → server: sub-ms microseconds,
 *   then submission id; queued: client_uuid.
 * Server vs server therefore reduces exactly to SQL's
 * `submitted_at DESC NULLS LAST, id DESC`. Returns < 0 when `a` ranks first.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.ms !== b.ms) return a.ms > b.ms ? -1 : 1;
  if (a.source !== b.source) return a.source === 'queued' ? -1 : 1;
  if (a.subMs !== b.subMs) return b.subMs - a.subMs;
  if (a.tie !== b.tie) return a.tie > b.tie ? -1 : 1;
  return 0;
}

export type DeriveBorrowedArgs = {
  serverSources: ReadonlyArray<ServerEodSource>;
  queue: ReadonlyArray<QueuedSubmission>;
  storeId: string;
  countIso: string;
  /** The selected vendor — its own server/queued submissions are excluded. */
  vendorId: string;
  /** The signed-in user; undefined → no queued sources (R1). */
  userId: string | undefined;
  /** From the chip list — names a QUEUED source's vendor (R4). */
  vendorNameById: Readonly<Record<string, string>>;
};

/**
 * AC-1 — for every item another vendor counted at (store, count date), the
 * entry this vendor's tab borrows. Keyed by item id. Pure.
 */
export function deriveBorrowedEntries(args: DeriveBorrowedArgs): Map<string, BorrowedEntry> {
  const { serverSources, queue, storeId, countIso, vendorId, userId, vendorNameById } = args;

  // 2. Queued candidates: this store + count date, another vendor, queued by
  //    the signed-in user. Per vendor keep only the one that drains last.
  const queuedByVendor = new Map<string, Candidate>();
  if (userId !== undefined) {
    for (const q of queue) {
      if (q.store_id !== storeId) continue;
      if (q.date !== countIso) continue;
      if (q.vendor_id === vendorId) continue;
      if (q.intent_user_id !== userId) continue;
      const cand: Candidate = {
        source: 'queued',
        ms: parseTimestamp(q.queued_at).ms,
        subMs: 0,
        tie: q.client_uuid.toLowerCase(),
        vendorId: q.vendor_id,
        vendorName: vendorNameById[q.vendor_id] ?? null,
        entries: q.entries,
      };
      const prev = queuedByVendor.get(q.vendor_id);
      if (!prev || compareCandidates(cand, prev) < 0) queuedByVendor.set(q.vendor_id, cand);
    }
  }

  // 1 + 3. Server candidates (the read's filters repeated as defence in
  //    depth); a null vendor is kept (contract rule 1). A vendor with a queued
  //    candidate loses its server one entirely (R2 — replaced on drain).
  const candidates: Candidate[] = [...queuedByVendor.values()];
  for (const s of serverSources) {
    if (s.storeId !== storeId) continue;
    if (s.date !== countIso) continue;
    if (s.status !== 'submitted') continue;
    if (s.vendorId === vendorId) continue;
    if (s.vendorId != null && queuedByVendor.has(s.vendorId)) continue;
    const ts = parseTimestamp(s.submittedAt);
    candidates.push({
      source: 'server',
      ms: ts.ms,
      subMs: ts.subMs,
      tie: s.submissionId.toLowerCase(),
      vendorId: s.vendorId,
      vendorName: s.vendorName,
      entries: s.entries,
    });
  }

  // 4 + 5. Rank, then walk: per item the first borrowable entry wins.
  candidates.sort(compareCandidates);
  const out = new Map<string, BorrowedEntry>();
  for (const cand of candidates) {
    for (const entry of cand.entries) {
      if (out.has(entry.item_id) || !isBorrowable(entry)) continue;
      out.set(entry.item_id, {
        vendorId: cand.vendorId,
        vendorName: cand.vendorName,
        entry,
        source: cand.source,
      });
    }
  }
  return out;
}
