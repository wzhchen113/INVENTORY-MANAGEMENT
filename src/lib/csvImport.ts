// Ingredient CSV import pipeline. Parse → infer column mapping → compute
// diff vs existing inventory_items → commit via existing addItem/updateItem
// store actions (which already audit + persist via db.ts).
//
// Archive is intentionally a stub right now — soft-delete needs an
// is_archived column on inventory_items, which is a separate migration.
// Rows tagged 'archive' surface in the diff and audit log only; no DB
// mutation runs. Surfaced as a known follow-up.

import Papa from 'papaparse';
import { InventoryItem, ItemVendorLink } from '../types';

export type MatchKind = 'auto' | 'fuzzy' | 'manual' | 'skip';

export interface ColumnMapping {
  csv: string;          // header from the CSV
  field: string;        // canonical ingredient field, or '(skip)'
  match: MatchKind;
  sample?: string;
}

// Canonical ingredient fields we map CSV columns to. Order matters —
// duplicates lose to the first listed.
const CANONICAL = [
  'name', 'sku', 'category', 'unit', 'pack_size',
  'par', 'reorder_point', 'max', 'last_cost',
  'vendor_name', 'vendor_sku',
] as const;

// Aliases used for fuzzy matching. Lowercased + collapsed whitespace.
const ALIASES: Record<string, string[]> = {
  name:          ['item', 'item name', 'product', 'description', 'desc'],
  sku:           ['sku #', 'sku#', 'item id', 'product id', 'code'],
  category:      ['cat', 'group', 'class'],
  unit:          ['uom', 'u/m', 'unit of measure'],
  pack_size:     ['pack', 'case qty', 'cs qty', 'case', 'units/case'],
  par:           ['par stock', 'par level', 'min'],
  reorder_point: ['rop', 'reorder', 'reorder pt'],
  max:           ['maximum', 'max qty', 'cap'],
  last_cost:     ['last $', 'cost', 'price', '$', 'unit cost'],
  vendor_name:   ['vendor', 'supplier', 'distributor'],
  vendor_sku:    ['vendor code', 'vendor #', 'supplier code', 'item #'],
};

const norm = (s: string) => s.toLowerCase().trim().replace(/[\s_-]+/g, ' ');

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = a[i - 1] === b[j - 1]
        ? m[i - 1][j - 1]
        : 1 + Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]);
    }
  }
  return m[a.length][b.length];
};

// For each CSV header, pick the best canonical field match.
export function inferColumnMapping(headers: string[], rows: Papa.ParseResult<any>['data']): ColumnMapping[] {
  return headers.map((h, idx) => {
    const nh = norm(h);
    const sample = rows[0]?.[h]?.toString().slice(0, 30);

    // Exact match (auto)
    for (const field of CANONICAL) {
      if (nh === norm(field) || (ALIASES[field] || []).some((a) => norm(a) === nh)) {
        return { csv: h, field, match: 'auto' as const, sample };
      }
    }

    // Levenshtein <= 2 (fuzzy)
    let bestField = '';
    let bestDist = Infinity;
    for (const field of CANONICAL) {
      const candidates = [field, ...(ALIASES[field] || [])].map(norm);
      for (const c of candidates) {
        const d = levenshtein(nh, c);
        if (d < bestDist) { bestDist = d; bestField = field; }
      }
    }
    if (bestDist <= 2 && bestField) {
      return { csv: h, field: bestField, match: 'fuzzy' as const, sample };
    }

    // Otherwise unmapped → manual review needed (but pre-set as skip if header
    // matches common "junk column" patterns)
    if (/^(notes_old|legacy|deprecated|x|temp)/i.test(h)) {
      return { csv: h, field: '(skip)', match: 'skip' as const, sample };
    }
    return { csv: h, field: '(skip)', match: 'manual' as const, sample };
  });
}

// Parse a CSV File via papaparse with header detection.
export async function parseCsv(file: File): Promise<Papa.ParseResult<any>> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (res) => resolve(res),
      error: (err: any) => reject(err),
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Diff calculation
// ─────────────────────────────────────────────────────────────

export interface DiffOp {
  type: 'create' | 'update' | 'archive' | 'skip';
  itemId?: string;        // existing item id when update/archive
  csvRow?: any;           // raw CSV row when create/update
  existing?: InventoryItem; // when update/archive
  payload?: Partial<InventoryItem>; // mapped + parsed fields when create/update
  reason?: string;        // for skip: why
  // Spec 115 (W-1) — the per-vendor order code the row carries. `order_code` is
  // NOT an `InventoryItem` field, so it rides the op as a sibling scalar (never
  // on `payload`). ABSENT when the `vendor_sku` cell is blank/whitespace (AC-4
  // blank = no-op — a blank cell neither writes nor clears a code). `vendorNameRaw`
  // is the raw `vendor_name` cell used to resolve the code's target vendor +
  // report an unmatched skip (AC-2/AC-6). Both live on the op, not the payload.
  orderCode?: string;
  vendorNameRaw?: string;
}

// Spec 115 (W-1, AC-2) — a minimal brand vendor for the code-resolution rule.
// `computeDiff` matches `vendor_name` case-insensitively against `name` within
// the store's brand (the caller passes the `vendors` slice narrowed to this).
export interface BrandVendorLite {
  id: string;
  name: string;
}

// The outcome of resolving which vendor a row's order code applies to (AC-2).
// A CSV cell NEVER auto-creates a vendor — an unmatched name or a no-primary
// item yields a reasoned skip, never a guessed write.
export type CodeVendorResolution =
  | { vendorId: string }
  | { skip: 'unmatched_vendor'; name: string }
  | { skip: 'no_vendor' };

/**
 * Spec 115 (W-1, AC-2) — resolve the vendor a row's order code applies to.
 * PURE. The rule (pinned by AC-2), fail-safe per OQ-2:
 *   1. `vendorNameRaw` present → case-insensitive match (via `norm`) against a
 *      brand vendor's `name`. Match → that vendor. NO match → skip
 *      `unmatched_vendor` (NEVER fall back to primary — writing the code to a
 *      different vendor than the operator named would be silently wrong).
 *   2. `vendorNameRaw` blank → the item's PRIMARY vendor (`itemPrimaryVendorId`,
 *      = `inventory_items.vendor_id`). Present → that vendor. Absent →
 *      skip `no_vendor`.
 */
export function resolveVendorForCode(args: {
  vendorNameRaw?: string;
  itemPrimaryVendorId?: string;
  brandVendors: BrandVendorLite[];
}): CodeVendorResolution {
  const raw = (args.vendorNameRaw ?? '').trim();
  if (raw) {
    const needle = norm(raw);
    const match = args.brandVendors.find((v) => norm(v.name) === needle);
    if (match) return { vendorId: match.id };
    return { skip: 'unmatched_vendor', name: raw };
  }
  const primary = (args.itemPrimaryVendorId ?? '').trim();
  if (primary) return { vendorId: primary };
  return { skip: 'no_vendor' };
}

/**
 * Spec 115 (W-1, AC-3 + the §0 RECONCILE-SAFE merge — MANDATORY). Build the
 * `vendors[]` payload for an item that gets an order code, from the item's
 * EXISTING link set, overwriting `orderCode` ONLY on the resolved link and
 * appending a new non-primary link when the vendor isn't linked yet.
 *
 * WHY THIS EXISTS (the data-loss trap): `db.ts updateInventoryItem` treats the
 * `vendors[]` payload as a FULL RECONCILE — it DELETES every link whose vendorId
 * is not in the submitted array and ZEROES cost/case_price for any link field the
 * caller omits. A code-only array `[{ vendorId, orderCode }]` on an item that
 * already links A, B, C would delete B and C and zero A's costs. So we MUST
 * resend the FULL existing link set with real costs, changing only the target
 * `orderCode`. Every untouched link rides through unchanged → the reconcile is a
 * no-op for them and a targeted code write for the resolved one.
 */
export function buildOrderCodeVendorsPayload(
  existingLinks: ItemVendorLink[],
  resolvedVendorId: string,
  code: string,
): { payload: Array<{ vendorId: string; costPerUnit: number; casePrice: number; orderCode: string }>; createdLink: boolean } {
  const base = existingLinks.map((l) => ({
    vendorId: l.vendorId,
    costPerUnit: l.costPerUnit, // PRESERVE — never zero an existing cost
    casePrice: l.casePrice,     // PRESERVE
    orderCode: l.vendorId === resolvedVendorId ? code : l.orderCode, // overwrite ONLY the target
  }));
  const alreadyLinked = base.some((l) => l.vendorId === resolvedVendorId);
  if (alreadyLinked) return { payload: base, createdLink: false };
  // No link to the resolved vendor yet — append a NEW non-primary link
  // (is_primary=false is derived by db.ts since this vendorId != the item's
  // scalar primary on an update). Costs default to 0 (AC-3: a CODE seed, not a
  // cost edit).
  return {
    payload: [...base, { vendorId: resolvedVendorId, costPerUnit: 0, casePrice: 0, orderCode: code }],
    createdLink: true,
  };
}

export interface DiffSummary {
  ops: DiffOp[];
  counts: { create: number; update: number; archive: number; skip: number };
}

const num = (s: any): number | undefined => {
  if (s == null || s === '') return undefined;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

// Collapse a CSV row to its mapped canonical fields (`{ canonicalField: value }`),
// skipping unmapped columns. Shared by rowToPayload + rowToOrderCodeFields so the
// `vendor_sku` / `vendor_name` reads use the SAME mapping as the item fields.
function mapRowFields(row: any, mapping: ColumnMapping[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of mapping) {
    if (c.field === '(skip)') continue;
    const v = row[c.csv];
    if (v != null) m[c.field] = String(v);
  }
  return m;
}

// Build payload from a CSV row given the column mapping.
function rowToPayload(row: any, mapping: ColumnMapping[]): Partial<InventoryItem> {
  const m = mapRowFields(row, mapping);
  const payload: Partial<InventoryItem> = {};
  if (m.name) payload.name = m.name;
  if (m.category) payload.category = m.category;
  if (m.unit) payload.unit = m.unit;
  const cost = num(m.last_cost);
  if (cost != null) payload.costPerUnit = cost;
  const par = num(m.par);
  if (par != null) payload.parLevel = par;
  const packSize = num(m.pack_size);
  if (packSize != null) payload.caseQty = packSize;
  if (m.vendor_name) payload.vendorName = m.vendor_name;
  return payload;
}

// Spec 115 (W-1) — extract the per-vendor order-code fields off a row. `orderCode`
// is the TRIMMED non-empty `vendor_sku` cell (ABSENT when blank/whitespace — AC-4
// blank = no-op); `vendorNameRaw` is the raw `vendor_name` cell for resolution +
// skip reporting (AC-2/AC-6). Kept separate from `rowToPayload` because
// `order_code` is not an `InventoryItem` field (it rides the op, not the payload).
function rowToOrderCodeFields(row: any, mapping: ColumnMapping[]): { orderCode?: string; vendorNameRaw?: string } {
  const m = mapRowFields(row, mapping);
  const code = (m.vendor_sku ?? '').trim();
  const vendorNameRaw = m.vendor_name;
  return {
    orderCode: code ? code : undefined,   // blank/whitespace cell → absent (no-op)
    vendorNameRaw,
  };
}

// Find an existing inventory item matched on name (case-insensitive). SKU
// match would come first if we had a real sku column — see Phase 12 plan
// "Stub at component layer" decision; for now name is the de-facto key.
function findExisting(payload: Partial<InventoryItem>, existing: InventoryItem[], storeId: string): InventoryItem | undefined {
  if (!payload.name) return undefined;
  const needle = payload.name.toLowerCase();
  return existing.find((e) => e.storeId === storeId && e.name.toLowerCase() === needle);
}

export function computeDiff(
  rows: any[],
  mapping: ColumnMapping[],
  existing: InventoryItem[],
  storeId: string,
  // Spec 115 (W-1) — the store's brand vendors, for resolving a row's `vendor_name`
  // → vendorId (AC-2). Defaults to `[]` so callers that don't import codes (or any
  // pre-115 caller) behave exactly as before (a present `vendor_name` with no match
  // just skips the code; item fields are unaffected).
  brandVendors: BrandVendorLite[] = [],
): DiffSummary {
  const ops: DiffOp[] = [];
  const seenNames = new Set<string>();

  for (const row of rows) {
    const payload = rowToPayload(row, mapping);
    const { orderCode, vendorNameRaw } = rowToOrderCodeFields(row, mapping);
    if (!payload.name) {
      ops.push({ type: 'skip', csvRow: row, reason: 'missing name' });
      continue;
    }
    seenNames.add(payload.name.toLowerCase());
    const match = findExisting(payload, existing, storeId);
    if (!match) {
      // CREATE — the code (if any) rides the op; commitImport resolves + merges.
      ops.push({ type: 'create', csvRow: row, payload, orderCode, vendorNameRaw });
    } else {
      // Compare changed fields
      const changes: Partial<InventoryItem> = {};
      let changed = false;
      const compare = <K extends keyof InventoryItem>(k: K) => {
        if (payload[k] !== undefined && payload[k] !== match[k]) {
          (changes as any)[k] = payload[k];
          changed = true;
        }
      };
      compare('name'); compare('category'); compare('unit'); compare('costPerUnit');
      compare('parLevel'); compare('caseQty'); compare('vendorName');

      // Spec 115 (W-1, §3 promotion) — a non-empty code is a change even when no
      // item field changed, so a `skip('no changes')` row carrying a NEW code
      // must NOT be dropped. Resolve the vendor and compare against the existing
      // link's code: only a code that actually DIFFERS (or a resolvable code on a
      // vendor with no link yet) makes the row an update. An unresolvable code
      // (unmatched vendor / no primary) never resurrects the row — it stays a
      // skip here and is REPORTED at commit as a code-row skip.
      let codeIsAChange = false;
      if (orderCode) {
        const res = resolveVendorForCode({ vendorNameRaw, itemPrimaryVendorId: match.vendorId, brandVendors });
        if ('vendorId' in res) {
          const existingLink = (match.vendors ?? []).find((l) => l.vendorId === res.vendorId);
          const existingCode = (existingLink?.orderCode ?? '').trim();
          if (existingCode !== orderCode) codeIsAChange = true;
        }
      }

      if (changed || codeIsAChange) {
        ops.push({ type: 'update', itemId: match.id, csvRow: row, payload: changes, existing: match, orderCode, vendorNameRaw });
      } else {
        // True no-op (no item field changed AND the code equals the existing
        // link's code, or there is no resolvable code). The op still carries the
        // code fields so commitImport can REPORT an unresolvable code row (AC-6)
        // even though it writes nothing.
        ops.push({ type: 'skip', csvRow: row, existing: match, reason: 'no changes', orderCode, vendorNameRaw });
      }
    }
  }

  // Archive: existing items at this store NOT present in the CSV.
  for (const ex of existing) {
    if (ex.storeId !== storeId) continue;
    if (!seenNames.has(ex.name.toLowerCase())) {
      ops.push({ type: 'archive', itemId: ex.id, existing: ex, reason: 'not in CSV' });
    }
  }

  const counts = { create: 0, update: 0, archive: 0, skip: 0 };
  for (const op of ops) counts[op.type]++;
  return { ops, counts };
}

// Spec 115 (W-1) — the `vendors?` payload the store's addItem/updateItem accept
// (the same shape db.ts's create/update-item reconcile consumes). Typed here so
// the CommitContext method signatures can carry the order-code merge.
type ItemVendorsPayload = Array<{ vendorId: string; costPerUnit?: number; casePrice?: number; orderCode?: string }>;

export interface CommitContext {
  addItem: (item: any) => void;
  // Spec 115 — widened to accept the `vendors?` merge payload (omit-key-to-skip:
  // a call WITHOUT the key leaves the item's link set untouched — the AC-4 blank
  // no-op relies on this). Matches the store's updateItem signature.
  updateItem: (id: string, updates: Omit<Partial<InventoryItem>, 'vendors'> & { vendors?: ItemVendorsPayload }) => void;
  storeId: string;
  // Spec 115 (W-1) — the store's brand vendors (for vendor_name → vendorId
  // resolution, AC-2) and the hydrated inventory rows (for reading an item's
  // EXISTING link set so the reconcile-safe merge preserves other links + costs,
  // §0/§3). Default `[]` in callers that don't import codes leaves behavior
  // unchanged.
  brandVendors: BrandVendorLite[];
  inventory: InventoryItem[];
  /** When true, archive ops are skipped (today's behavior). */
  skipArchive?: boolean;
}

export interface CommitResult {
  created: number;
  updated: number;
  archived: number;       // 0 today; reserved for when soft-archive lands
  archiveSkipped: number; // count of archive ops that were not committed
  // Spec 115 (W-1, AC-5/AC-6) — order-code seed outcome, distinct from the item
  // create/update/skip counts above.
  codesWritten: number;   // ops whose non-empty code landed on a link (create or update)
  linksCreated: number;   // subset that appended a NEW non-primary item_vendors link
  codeRowsSkipped: Array<
    | { item: string; reason: 'unmatched_vendor'; vendorName: string }
    | { item: string; reason: 'no_vendor' }
  >;                      // AC-6 reasoned skips (non-empty code, no resolvable vendor)
}

// Apply the diff via the existing store actions (which audit + persist).
// Archive ops are tracked but not executed today; surfaced in the result
// so the caller can toast "X archive ops deferred".
//
// Spec 115 (W-1) — a row's non-empty order code is merged onto the item's
// EXISTING vendor links (RECONCILE-SAFE, §0/§3) and rides the same
// addItem/updateItem `vendors?` payload; a blank cell sends NO `vendors` key
// (no-op). An unresolvable code (unmatched vendor / no primary) is reported in
// `codeRowsSkipped`, never written to a guessed vendor.
export function commitImport(diff: DiffSummary, ctx: CommitContext): CommitResult {
  let created = 0, updated = 0, archived = 0, archiveSkipped = 0;
  let codesWritten = 0, linksCreated = 0;
  const codeRowsSkipped: CommitResult['codeRowsSkipped'] = [];

  // Resolve a row's code target + record a reasoned skip. Returns null when the
  // row carries no code (blank cell → no-op) OR the code can't resolve to a
  // vendor (reported, not written). Otherwise the resolved vendorId.
  const resolveCodeTarget = (op: DiffOp, primaryVendorId: string | undefined, itemLabel: string): string | null => {
    if (!op.orderCode) return null; // blank/whitespace cell → no code write (AC-4).
    const res = resolveVendorForCode({
      vendorNameRaw: op.vendorNameRaw,
      itemPrimaryVendorId: primaryVendorId,
      brandVendors: ctx.brandVendors,
    });
    if ('vendorId' in res) return res.vendorId;
    if (res.skip === 'unmatched_vendor') codeRowsSkipped.push({ item: itemLabel, reason: 'unmatched_vendor', vendorName: res.name });
    else codeRowsSkipped.push({ item: itemLabel, reason: 'no_vendor' });
    return null;
  };

  for (const op of diff.ops) {
    if (op.type === 'create' && op.payload) {
      const label = op.payload.name || '—';
      // A create has no existing item yet → no primary link, empty link set. The
      // code can only resolve when the row names an existing brand vendor (AC-2
      // branch a); a blank vendor_name on a create has no primary to fall back to
      // → no_vendor skip.
      const resolvedVendorId = resolveCodeTarget(op, undefined, label);
      let vendors: ItemVendorsPayload | undefined;
      if (resolvedVendorId && op.orderCode) {
        const built = buildOrderCodeVendorsPayload([], resolvedVendorId, op.orderCode);
        vendors = built.payload;
        codesWritten++;
        if (built.createdLink) linksCreated++;
      }
      ctx.addItem({
        ...op.payload,
        storeId: ctx.storeId,
        currentStock: 0,
        averageDailyUsage: 0,
        safetyStock: 0,
        usagePerPortion: 0,
        eodRemaining: 0,
        lastUpdatedBy: '',
        lastUpdatedAt: new Date().toISOString(),
        vendorId: '',
        casePrice: 0,
        caseQty: op.payload.caseQty || 1,
        subUnitSize: 1,
        subUnitUnit: '',
        vendorName: op.payload.vendorName || '',
        // Omit the key entirely when there's no code (no-op), else the merged set.
        ...(vendors ? { vendors } : {}),
      });
      created++;
    } else if (op.type === 'update' && op.itemId && op.payload) {
      const item = ctx.inventory.find((i) => i.id === op.itemId);
      const label = op.existing?.name || op.payload.name || '—';
      const resolvedVendorId = resolveCodeTarget(op, item?.vendorId, label);
      let vendors: ItemVendorsPayload | undefined;
      if (resolvedVendorId && op.orderCode) {
        // RECONCILE-SAFE: resend the FULL existing link set with only the target
        // orderCode changed (§0/§3). A code-only array WOULD delete other links +
        // zero costs — never do that.
        const built = buildOrderCodeVendorsPayload(item?.vendors ?? [], resolvedVendorId, op.orderCode);
        vendors = built.payload;
        codesWritten++;
        if (built.createdLink) linksCreated++;
      }
      // Omit the `vendors` key when there's no code write so db.ts leaves the
      // link set untouched (AC-4 no-op). Item-field changes still ride through.
      ctx.updateItem(op.itemId, { ...op.payload, ...(vendors ? { vendors } : {}) });
      updated++;
    } else if (op.type === 'archive') {
      // Soft-archive needs an is_archived column — not yet in the schema
      // (see Phase 12 plan, "Caveats" under 12e). Track the count so the
      // caller can flag this as deferred.
      archiveSkipped++;
    } else if (op.type === 'skip') {
      // Spec 115 — a true-no-op row can still carry an UNRESOLVABLE code that
      // must be REPORTED (AC-6). Resolution of a resolvable code that equals the
      // existing link's code was already classified as no-op in computeDiff, so a
      // resolvable code here would be a genuine no-op (idempotent re-run) and is
      // NOT re-reported. Only unmatched/no-vendor codes surface.
      if (op.orderCode) {
        const item = op.existing ? ctx.inventory.find((i) => i.id === op.existing!.id) : undefined;
        resolveCodeTarget(op, item?.vendorId ?? op.existing?.vendorId, op.existing?.name || '—');
      }
    }
  }
  return { created, updated, archived, archiveSkipped, codesWritten, linksCreated, codeRowsSkipped };
}
