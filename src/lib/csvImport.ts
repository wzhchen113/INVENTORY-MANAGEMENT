// Ingredient CSV import pipeline. Parse → infer column mapping → compute
// diff vs existing inventory_items → commit via existing addItem/updateItem
// store actions (which already audit + persist via db.ts).
//
// Archive is intentionally a stub right now — soft-delete needs an
// is_archived column on inventory_items, which is a separate migration.
// Rows tagged 'archive' surface in the diff and audit log only; no DB
// mutation runs. Surfaced as a known follow-up.

import Papa from 'papaparse';
import { InventoryItem } from '../types';

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

// Build payload from a CSV row given the column mapping.
function rowToPayload(row: any, mapping: ColumnMapping[]): Partial<InventoryItem> {
  const m: Record<string, string> = {};
  for (const c of mapping) {
    if (c.field === '(skip)') continue;
    const v = row[c.csv];
    if (v != null) m[c.field] = String(v);
  }
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

// Find an existing inventory item matched on name (case-insensitive). SKU
// match would come first if we had a real sku column — see Phase 12 plan
// "Stub at component layer" decision; for now name is the de-facto key.
function findExisting(payload: Partial<InventoryItem>, existing: InventoryItem[], storeId: string): InventoryItem | undefined {
  if (!payload.name) return undefined;
  const needle = payload.name.toLowerCase();
  return existing.find((e) => e.storeId === storeId && e.name.toLowerCase() === needle);
}

export function computeDiff(rows: any[], mapping: ColumnMapping[], existing: InventoryItem[], storeId: string): DiffSummary {
  const ops: DiffOp[] = [];
  const seenNames = new Set<string>();

  for (const row of rows) {
    const payload = rowToPayload(row, mapping);
    if (!payload.name) {
      ops.push({ type: 'skip', csvRow: row, reason: 'missing name' });
      continue;
    }
    seenNames.add(payload.name.toLowerCase());
    const match = findExisting(payload, existing, storeId);
    if (!match) {
      ops.push({ type: 'create', csvRow: row, payload });
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
      if (changed) {
        ops.push({ type: 'update', itemId: match.id, csvRow: row, payload: changes, existing: match });
      } else {
        ops.push({ type: 'skip', csvRow: row, existing: match, reason: 'no changes' });
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

export interface CommitContext {
  addItem: (item: any) => void;
  updateItem: (id: string, updates: Partial<InventoryItem>) => void;
  storeId: string;
  /** When true, archive ops are skipped (today's behavior). */
  skipArchive?: boolean;
}

export interface CommitResult {
  created: number;
  updated: number;
  archived: number;       // 0 today; reserved for when soft-archive lands
  archiveSkipped: number; // count of archive ops that were not committed
}

// Apply the diff via the existing store actions (which audit + persist).
// Archive ops are tracked but not executed today; surfaced in the result
// so the caller can toast "X archive ops deferred".
export function commitImport(diff: DiffSummary, ctx: CommitContext): CommitResult {
  let created = 0, updated = 0, archived = 0, archiveSkipped = 0;
  for (const op of diff.ops) {
    if (op.type === 'create' && op.payload) {
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
      });
      created++;
    } else if (op.type === 'update' && op.itemId && op.payload) {
      ctx.updateItem(op.itemId, op.payload);
      updated++;
    } else if (op.type === 'archive') {
      // Soft-archive needs an is_archived column — not yet in the schema
      // (see Phase 12 plan, "Caveats" under 12e). Track the count so the
      // caller can flag this as deferred.
      archiveSkipped++;
    }
    // skip → no-op
  }
  return { created, updated, archived, archiveSkipped };
}
