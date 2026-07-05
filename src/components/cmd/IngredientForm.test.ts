// src/components/cmd/IngredientForm.test.ts — Spec 046 narrow jest.
//
// Exercises the pure `validateCustomUnit` helper exported from
// IngredientForm.tsx. Scope is intentionally narrow: per the architect
// (spec 046 §Backend / architecture design Q6) the form's render-tree
// behavior (sentinel flip → TextInput swap) is not covered here — that's
// render-tree-coupled and lives outside the jest scope per spec 022 §9.
//
// Cases pinned (architect spec 046 Q6 + round-2 code-review C2):
//   - empty / whitespace-only            → { ok: false, error: 'required' }
//   - 31 chars                           → { ok: false, error: 'too_long' }
//   - 30 chars                           → { ok: true }                 (boundary)
//   - 'LBS' / 'lbs' / ' lbs '            → snap to canonical 'lbs'
//   - every CANONICAL_UNITS entry        → snap to lowercase, driven from the live constant (SF4)
//   - 'case' / 'Tray' / '12oz can'       → pass through, original case preserved
//   - 'EACH' with `each` in known-keys   → snap to 'each' (round-2 C2)
//   - 'BAG' with `bag` in known-keys     → snap to 'bag'  (round-2 C2)
//   - non-empty known-keys leaves canonicals snapping as before
//
// File lives under src/components/cmd/ rather than src/utils/ because it
// imports from a `.tsx` file (transitively pulls in react-native). The
// jest.config.js component project is extended to match `.test.ts` files
// for this reason.
//
// Boundary mocking — `../../lib/supabase`:
//
// IngredientForm.tsx imports `useCmdColors` from `../../theme/colors`,
// which imports `useStore`, which imports `../../lib/db.ts`, which
// imports `../../lib/supabase.ts`. The supabase client crashes at
// module load when `EXPO_PUBLIC_SUPABASE_*` env vars are unset (jest
// runs without an `.env`). Stub the supabase module at the test
// boundary — same pattern as StatusPill.test.tsx, but reaching one
// layer deeper because we only need the importable surface and never
// actually render the form. The store-side hooks are never called.
//
// Note on placement: `jest.mock` is hoisted by Babel above all `import`
// statements at compile time, so the call below executes BEFORE the
// `import { validateCustomUnit, ... }` line is evaluated. This ordering
// is intentional and the standard jest idiom — moving the import above
// the mock would not change observable behavior because of the hoist.

jest.mock('../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import {
  validateCustomUnit,
  CUSTOM_UNIT_MAX_LEN,
  vendorAlreadyLinked,
  addVendorLink,
  removeVendorLink,
  updateVendorLinkField,
  vendorRowsToLinkPayload,
  derivedUnitCost,
  NEW_VENDOR_SENTINEL,
  blankValues,
  type VendorLinkRow,
} from './IngredientForm';
import { CANONICAL_UNITS, calcUnitCost } from '../../utils/unitConversion';
import { piecesPerCase } from '../../utils/perEachCost';

describe('validateCustomUnit', () => {
  describe('rejects empty / whitespace-only input', () => {
    it('returns { ok: false, error: "required" } for an empty string', () => {
      expect(validateCustomUnit('')).toEqual({ ok: false, error: 'required' });
    });

    it('returns { ok: false, error: "required" } for whitespace only', () => {
      expect(validateCustomUnit('   ')).toEqual({ ok: false, error: 'required' });
      expect(validateCustomUnit('\t\n')).toEqual({ ok: false, error: 'required' });
    });
  });

  describe('rejects strings longer than CUSTOM_UNIT_MAX_LEN', () => {
    it('exposes the 30-char cap as a named constant', () => {
      // Pins the cap so a future change has to consciously update this
      // file too. Per spec 046 architect §Q3 the cap is client-side only
      // — DB column is `text` with no CHECK.
      expect(CUSTOM_UNIT_MAX_LEN).toBe(30);
    });

    it('accepts exactly 30 characters (boundary)', () => {
      const s = 'a'.repeat(30);
      expect(validateCustomUnit(s)).toEqual({
        ok: true,
        normalized: s,
        snappedToCanonical: false,
      });
    });

    it('returns { ok: false, error: "too_long" } for 31 characters', () => {
      const s = 'a'.repeat(31);
      expect(validateCustomUnit(s)).toEqual({ ok: false, error: 'too_long' });
    });

    it('measures length AFTER trim — leading/trailing whitespace does not push past the cap', () => {
      const s = `  ${'a'.repeat(30)}  `;
      expect(validateCustomUnit(s)).toEqual({
        ok: true,
        normalized: 'a'.repeat(30),
        snappedToCanonical: false,
      });
    });
  });

  describe('snaps case-insensitively to canonical units', () => {
    it('snaps "LBS" to canonical "lbs" (AC6)', () => {
      expect(validateCustomUnit('LBS')).toEqual({
        ok: true,
        normalized: 'lbs',
        snappedToCanonical: true,
      });
    });

    it('snaps "lbs" to canonical "lbs" (already lowercase)', () => {
      expect(validateCustomUnit('lbs')).toEqual({
        ok: true,
        normalized: 'lbs',
        snappedToCanonical: true,
      });
    });

    it('snaps " lbs " (padded) to canonical "lbs"', () => {
      expect(validateCustomUnit(' lbs ')).toEqual({
        ok: true,
        normalized: 'lbs',
        snappedToCanonical: true,
      });
    });

    it('snaps "Fl_Oz" to canonical "fl_oz" (mixed-case underscore unit)', () => {
      expect(validateCustomUnit('Fl_Oz')).toEqual({
        ok: true,
        normalized: 'fl_oz',
        snappedToCanonical: true,
      });
    });

    it('snaps each canonical unit to its lowercase form regardless of input case', () => {
      // Round-2 (SF4) — drive the loop from the live CANONICAL_UNITS
      // constant rather than a hardcoded list, so a future addition to
      // the canonical registry (e.g. `ml`) automatically exercises the
      // snap path without a corresponding test edit.
      expect(CANONICAL_UNITS.length).toBeGreaterThan(0);
      for (const u of CANONICAL_UNITS) {
        expect(validateCustomUnit(u.toUpperCase())).toEqual({
          ok: true,
          normalized: u,
          snappedToCanonical: true,
        });
      }
    });
  });

  describe('snaps to caller-supplied known-lowercase keys (round-2 C2)', () => {
    it('snaps "EACH" to "each" when `each` is in knownLowercaseKeys', () => {
      // `each` is NOT in CANONICAL_UNITS but IS in the default-unit
      // dropdown's option list (acc.add('each') in defaultUnitOptions).
      // Without the known-keys arg, "EACH" would be passed through
      // case-preserved and miss SelectField's byte-for-byte lookup.
      expect(validateCustomUnit('EACH', ['each'])).toEqual({
        ok: true,
        normalized: 'each',
        snappedToCanonical: true,
      });
    });

    it('snaps "Each" (title case) to "each"', () => {
      expect(validateCustomUnit('Each', ['each'])).toEqual({
        ok: true,
        normalized: 'each',
        snappedToCanonical: true,
      });
    });

    it('snaps "BAG" to "bag" when bag is a conversion-derived key', () => {
      // Simulates the pack-unit code path where the known-keys array
      // includes every ingredient_conversions.purchaseUnit globally.
      expect(validateCustomUnit('BAG', ['bag', 'case', 'tray'])).toEqual({
        ok: true,
        normalized: 'bag',
        snappedToCanonical: true,
      });
    });

    it('canonical snap takes precedence over known-keys snap (deterministic)', () => {
      // If a known-key happens to also be canonical (e.g. `lbs`), the
      // canonical path wins — same observable result (lowercase + snapped)
      // either way, but the test pins the order so a future refactor
      // doesn't accidentally flip it.
      expect(validateCustomUnit('LBS', ['lbs'])).toEqual({
        ok: true,
        normalized: 'lbs',
        snappedToCanonical: true,
      });
    });

    it('non-canonical, non-known input still passes through case-preserved', () => {
      // A known-keys array that does NOT include the user's input
      // leaves the original-casing pass-through path untouched.
      expect(validateCustomUnit('Tray', ['each', 'case'])).toEqual({
        ok: true,
        normalized: 'Tray',
        snappedToCanonical: false,
      });
    });

    it('empty known-keys arg preserves pre-round-2 behavior', () => {
      // Default arg (no known-keys) reproduces the legacy 5-step
      // resolution from the spec 046 architect doc.
      expect(validateCustomUnit('EACH')).toEqual({
        ok: true,
        normalized: 'EACH',
        snappedToCanonical: false,
      });
    });
  });

  describe('passes non-canonical strings through with original casing preserved', () => {
    it('accepts "case" as-is (no canonical match)', () => {
      expect(validateCustomUnit('case')).toEqual({
        ok: true,
        normalized: 'case',
        snappedToCanonical: false,
      });
    });

    it('accepts "Tray" with capital T preserved (architect Q3 §5)', () => {
      // The architect explicitly chose case preservation for non-canonical
      // values — vendor labels like "Case" or "Tray" are easier to read
      // capitalized; lowercase coercion is a code smell when the column
      // is free text.
      expect(validateCustomUnit('Tray')).toEqual({
        ok: true,
        normalized: 'Tray',
        snappedToCanonical: false,
      });
    });

    it('accepts "12oz can" verbatim (spaces + digits + letters)', () => {
      // No regex character-class filter, per architect Q3 — the column
      // is free text and we don't pre-emptively reject characters.
      expect(validateCustomUnit('12oz can')).toEqual({
        ok: true,
        normalized: '12oz can',
        snappedToCanonical: false,
      });
    });

    it('trims surrounding whitespace but keeps internal whitespace and casing', () => {
      expect(validateCustomUnit('  Case of 24  ')).toEqual({
        ok: true,
        normalized: 'Case of 24',
        snappedToCanonical: false,
      });
    });
  });
});

// ─── Spec 104 — calcUnitCost is the true per-EACH (smallest-unit) cost ────────
//
// Spec 104 REVERSES spec 093: `cost_per_unit` is now `case_price / (case_qty ×
// sub_unit_size)` = `case_price / piecesPerCase`. `sub_unit_size` is NOW part of
// the divisor (the exact opposite of the spec-093 pin these tests replace, which
// called `× sub_unit_size` "the 12×-class error"). The divisor is SINGLE-SOURCED
// through `piecesPerCase` (§8 R4) so the per-each display path and this cost path
// can never drift.
describe('calcUnitCost (spec 104 — per-each = case_price / (case_qty × sub_unit_size))', () => {
  it('divides case price by units/case × sub-unit size', () => {
    // 50 / (1 × 500) = 0.10 — the AC-pinned case_qty=1, sub=500 shape.
    expect(calcUnitCost(50, 1, 500)).toBeCloseTo(0.1, 10);
    // 20 / (20 × 1) = 1.00 — bulk item, sub_unit_size=1.
    expect(calcUnitCost(20, 20, 1)).toBe(1.0);
    // sub_unit_size > 1 NOW moves the result (the reversal): 20 / (20 × 5) = 0.20.
    expect(calcUnitCost(20, 20, 5)).toBeCloseTo(0.2, 10);
  });

  it('handles the 2000-count cup shape (deep sub-cent)', () => {
    // 33 / (1 × 2000) = 0.0165 — the 2oz Cup w/ Lid migrated per-each value.
    expect(calcUnitCost(33, 1, 2000)).toBeCloseTo(0.0165, 10);
  });

  it('returns 0 for a non-positive case_qty (guard preserved)', () => {
    // AC line 81 pins calcUnitCost(20,0,5) === 0. The caseQty<=0 guard fires
    // BEFORE the piecesPerCase divisor (which would otherwise floor caseQty to 1
    // and return 20/5). Live data never has case_qty<=0 — it defaults to 1.
    expect(calcUnitCost(20, 0, 5)).toBe(0);
    expect(calcUnitCost(20, -1, 5)).toBe(0);
  });

  it('returns 0 for a non-positive case price (no derivable cost)', () => {
    expect(calcUnitCost(0, 20, 5)).toBe(0);
    expect(calcUnitCost(-1, 20, 5)).toBe(0);
  });

  it('is single-sourced with piecesPerCase over the positive-case_qty domain (§8 R4)', () => {
    // AC line 83 identity: calcUnitCost(p,q,s) === p/piecesPerCase(q,s) for all
    // positive case_qty. (The caseQty<=0 guard is the one documented exception —
    // exercised above — so this property is asserted over the live domain.)
    const samples: Array<[number, number, number]> = [
      [50, 1, 500], [20, 20, 1], [20, 20, 5], [33, 1, 2000], [32, 1, 6000],
      [40, 250, 1], [12.5, 4, 10], [0.9, 3, 1], [100, 12, 24],
    ];
    for (const [p, q, s] of samples) {
      const expected = p > 0 && piecesPerCase(q, s) > 0 ? p / piecesPerCase(q, s) : 0;
      expect(calcUnitCost(p, q, s)).toBe(expected);
    }
  });
});

// ─── Spec 104 — derivedUnitCost (per-each cost/unit, 3-arg) ───────────────────
//
// The editor's per-unit cost is DERIVED, never hand-entered, and is now the
// per-EACH cost = case price ÷ (units/case × sub-unit size), single-sourced
// through calcUnitCost. This string wrapper is what the form binds to the
// read-only inputs and what the load path (fromItem) and the
// case-price/units-case/sub-unit handlers all call. It gains a THIRD arg
// (subUnitSize) in spec 104; the pre-104 2-arg case_price/case_qty asserts these
// replace are gone (they contradict this spec).
describe('derivedUnitCost (spec 104 — 3-arg per-each string wrapper)', () => {
  it('divides case price by units/case × sub-unit size', () => {
    // 50 / (1 × 500) = 0.1 — the AC-pinned shape (§8 R7).
    expect(derivedUnitCost('50', '1', '500')).toBe('0.1');
    // 40 / (250 × 1) = 0.16.
    expect(derivedUnitCost('40', '250', '1')).toBe('0.16');
    // 20 / (20 × 5) = 0.2 — sub-unit size now moves the result.
    expect(derivedUnitCost('20', '20', '5')).toBe('0.2');
  });

  it('units/case AND sub-unit size of 1 → cost equals the case price', () => {
    expect(derivedUnitCost('40', '1', '1')).toBe('40');
  });

  it('keeps deep sub-cent precision (6 dp) without binary-float noise', () => {
    // 32 / (1 × 6000) = 0.005333… — the Napkin (Togo) shape; survives to 6 dp.
    expect(derivedUnitCost('32', '1', '6000')).toBe('0.005333');
    // 33 / (1 × 2000) = 0.0165 — the 2oz Cup w/ Lid per-each value.
    expect(derivedUnitCost('33', '1', '2000')).toBe('0.0165');
    // 0.1-class divisions stay clean (no 0.30000000000000004).
    expect(derivedUnitCost('0.9', '3', '1')).toBe('0.3');
  });

  it('returns "" (→ the "0" placeholder) when there is no positive cost yet', () => {
    expect(derivedUnitCost('40', '0', '500')).toBe('');   // zero units/case → caseQty<=0 guard
    expect(derivedUnitCost('40', '', '500')).toBe('');     // blank units/case (parses to 0 → guard)
    expect(derivedUnitCost('', '250', '1')).toBe('');      // blank case price
    expect(derivedUnitCost('0', '250', '1')).toBe('');     // zero case price
    expect(derivedUnitCost('abc', '250', '1')).toBe('');   // unparseable case price
  });

  it('floors a zero/blank sub-unit size to 1 (piecesPerCase default), NOT a guard', () => {
    // subUnitSize 0/blank → piecesPerCase floors to 1, so the per-each cost is
    // just case_price / units_case (the tracking unit IS the smallest unit).
    expect(derivedUnitCost('40', '250', '0')).toBe('0.16');
    expect(derivedUnitCost('40', '250', '')).toBe('0.16');
  });
});

// ─── Spec 102 (AC-C) — multi-vendor editor helpers ───────────────────────────
//
// Pins the add / remove / dup-guard / cost-edit logic + the form→db payload
// mapping (the array threaded to db.createInventoryItem / db.updateInventoryItem
// which reconciles item_vendors). AC-C: "saving an item with V1+V2 persists two
// link rows with their costs; removing a vendor removes its link row; editing a
// vendor's cost updates only that link; the form prevents attaching the same
// vendor twice."
describe('multi-vendor editor helpers (spec 102 AC-C)', () => {
  const v1 = 'aaaaaaaa-0000-0000-0000-000000000001';
  const v2 = 'bbbbbbbb-0000-0000-0000-000000000002';
  const v3 = 'cccccccc-0000-0000-0000-000000000003';

  describe('vendorAlreadyLinked — dup-guard predicate', () => {
    it('is true when the vendor is already in the rows', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      expect(vendorAlreadyLinked(rows, v1)).toBe(true);
    });
    it('is false for a vendor not in the rows', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      expect(vendorAlreadyLinked(rows, v2)).toBe(false);
    });
    it('is false for an empty vendor id (never a duplicate)', () => {
      expect(vendorAlreadyLinked([{ vendorId: v1, costPerUnit: '', casePrice: '', orderCode: '' }], '')).toBe(false);
    });
  });

  describe('addVendorLink — attach with dup-guard', () => {
    it('appends a new row seeded from the provided cost/case price', () => {
      const next = addVendorLink([], v1, { costPerUnit: '8', casePrice: '80' });
      expect(next).toEqual([{ vendorId: v1, costPerUnit: '8', casePrice: '80', orderCode: '' }]);
    });
    it('defaults seeds to empty strings when no seed is given', () => {
      expect(addVendorLink([], v1)).toEqual([{ vendorId: v1, costPerUnit: '', casePrice: '', orderCode: '' }]);
    });
    it('is a NO-OP (returns the same reference) when the vendor is already linked', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      const next = addVendorLink(rows, v1, { costPerUnit: '9', casePrice: '90' });
      // identity — lets the caller branch on "already linked" to toast.
      expect(next).toBe(rows);
    });
    it('is a NO-OP for an empty vendor id', () => {
      const rows: VendorLinkRow[] = [];
      expect(addVendorLink(rows, '')).toBe(rows);
    });
    it('keeps existing rows when appending a second distinct vendor (V1+V2 → two rows)', () => {
      const afterV1 = addVendorLink([], v1, { costPerUnit: '5', casePrice: '50' });
      const afterV2 = addVendorLink(afterV1, v2, { costPerUnit: '8', casePrice: '80' });
      expect(afterV2).toEqual([
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' },
      ]);
    });
  });

  describe('removeVendorLink — detach', () => {
    it('removes only the matching row (AC-C "removing a vendor removes its link")', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' },
      ];
      expect(removeVendorLink(rows, v1)).toEqual([{ vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' }]);
    });
    it('leaves the rows unchanged when the vendor is not present', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      expect(removeVendorLink(rows, v3)).toEqual(rows);
    });
    it('removing the last row yields an empty array (removes ALL links)', () => {
      expect(removeVendorLink([{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }], v1)).toEqual([]);
    });
  });

  describe('updateVendorLinkField — edit ONE link', () => {
    it('patches only the targeted row + field (AC-C "updates only that link")', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' },
      ];
      const next = updateVendorLinkField(rows, v2, 'costPerUnit', '9');
      expect(next).toEqual([
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }, // untouched
        { vendorId: v2, costPerUnit: '9', casePrice: '80', orderCode: '' }, // only cost changed
      ]);
    });
    it('patches casePrice independently', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      expect(updateVendorLinkField(rows, v1, 'casePrice', '55')).toEqual([
        { vendorId: v1, costPerUnit: '5', casePrice: '55', orderCode: '' },
      ]);
    });
  });

  describe('vendorRowsToLinkPayload — form rows → db link-set payload', () => {
    it('maps V1+V2 to two payload rows with numeric costs (AC-C persists two links)', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' },
      ];
      expect(vendorRowsToLinkPayload(rows)).toEqual([
        { vendorId: v1, costPerUnit: 5, casePrice: 50 },
        { vendorId: v2, costPerUnit: 8, casePrice: 80 },
      ]);
    });
    it('coerces blank / unparseable costs to 0 (form convention)', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '', casePrice: 'abc', orderCode: '' }];
      expect(vendorRowsToLinkPayload(rows)).toEqual([{ vendorId: v1, costPerUnit: 0, casePrice: 0 }]);
    });
    it('drops rows with an empty or sentinel vendor id', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: '', costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: NEW_VENDOR_SENTINEL, costPerUnit: '5', casePrice: '50', orderCode: '' },
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' },
      ];
      expect(vendorRowsToLinkPayload(rows)).toEqual([{ vendorId: v1, costPerUnit: 5, casePrice: 50 }]);
    });
    it('an empty rows array maps to an empty payload (removes ALL links)', () => {
      expect(vendorRowsToLinkPayload([])).toEqual([]);
    });
  });

  describe('end-to-end add → edit → remove flow (the editor sequence)', () => {
    it('attach V1, attach V2, edit V2 cost, remove V1 → single V2 link at its cost', () => {
      let rows = addVendorLink([], v1, { costPerUnit: '5', casePrice: '50' });
      rows = addVendorLink(rows, v2, { costPerUnit: '8', casePrice: '80' });
      // dup-guard: re-attaching V1 is a no-op (same reference)
      expect(addVendorLink(rows, v1)).toBe(rows);
      rows = updateVendorLinkField(rows, v2, 'costPerUnit', '7');
      rows = removeVendorLink(rows, v1);
      expect(vendorRowsToLinkPayload(rows)).toEqual([{ vendorId: v2, costPerUnit: 7, casePrice: 80 }]);
    });
  });

  // ─── Spec 102 code-review Critical — inline "+ new vendor" in EDIT mode ──────
  //
  // Pins the fix for IngredientFormDrawer.handleVendorDrawerClose: when a user
  // EDITING an existing item inline-creates a brand-new vendor, that vendor must
  // be added to `values.vendors` (the ROW LIST), not just the scalar primary
  // pointer. Pre-fix the handler set only the scalar, so the payload builder
  // (`vendorRowsToLinkPayload`, the array `toUpdates` threads to
  // `db.updateInventoryItem`) stayed `[]` → a vendors-only update DELETED every
  // existing item_vendors link, leaving the item with a dangling vendor_id and
  // zero junction rows.
  //
  // The handler's post-fix transform is exactly `addVendorLink(prev.vendors,
  // newId, {costPerUnit, casePrice})` + set the scalar. We exercise that same
  // pure transform here (the helper layer the review asked us to pin) and assert
  // the new vendor is in the resulting payload — so a vendors-only update can
  // never wipe links again.
  describe('inline-new-vendor (EDIT mode) seeds the row list, never an empty payload', () => {
    it('adds the inline-created vendor to vendors so the update payload is NOT empty (no wipe)', () => {
      // Item opened in EDIT mode already linked to V1 (its original vendor).
      const existing: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      // User inline-creates V2; handler seeds the new link from the form's
      // current cost/case price (mirrors the real handler call).
      const afterInline = addVendorLink(existing, v2, { costPerUnit: '9', casePrice: '90' });
      const payload = vendorRowsToLinkPayload(afterInline);
      // CRITICAL: both the original AND the new vendor survive → no link wipe.
      expect(payload).toEqual([
        { vendorId: v1, costPerUnit: 5, casePrice: 50 },
        { vendorId: v2, costPerUnit: 9, casePrice: 90 },
      ]);
      expect(payload.some((p) => p.vendorId === v2)).toBe(true);
      expect(payload).toHaveLength(2);
    });

    it('seeds the brand-new link to the FIRST vendor when the item had none (single-vendor edit)', () => {
      // EDIT mode on an item with no links yet (vendorless item) → the inline
      // vendor becomes the sole link, never an empty payload.
      const afterInline = addVendorLink([], v3, { costPerUnit: '4', casePrice: '40' });
      expect(vendorRowsToLinkPayload(afterInline)).toEqual([
        { vendorId: v3, costPerUnit: 4, casePrice: 40 },
      ]);
    });

    it('is idempotent — a re-close that re-finds an already-added vendor does not duplicate', () => {
      // The handler can fire its add path more than once (e.g. a second drawer
      // close). `addVendorLink`'s dup-guard returns the SAME reference, so the
      // row list (and thus the payload) is unchanged — no duplicate link row.
      const once = addVendorLink([{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }], v2, {
        costPerUnit: '9',
        casePrice: '90',
      });
      const twice = addVendorLink(once, v2, { costPerUnit: '9', casePrice: '90' });
      expect(twice).toBe(once); // identity — dup-guard short-circuit
      expect(vendorRowsToLinkPayload(twice)).toHaveLength(2);
      expect(
        vendorRowsToLinkPayload(twice).filter((p) => p.vendorId === v2),
      ).toHaveLength(1);
    });
  });
});

// ─── Spec 114 (AC-4/AC-3) — per-vendor order code through the pure helpers ────
//
// Pins the order-code extensions to the multi-vendor helpers: editing ONE card's
// code isolates to that vendorId (never leaks to another row or to any
// item-level field), the payload trims + maps empty→undefined (the db.ts
// empty→SQL NULL contract), and a present code threads through
// vendorRowsToLinkPayload into the `vendors?` payload the create/update helpers
// consume (round-trip shape). The obsolete item-level `vendorSku` stub is NOT
// exercised — there is no stub on this pure surface; the assertion is that only
// the `vendors[]` row carries the code.
describe('per-vendor order code helpers (spec 114 AC-4/AC-3)', () => {
  const v1 = 'aaaaaaaa-0000-0000-0000-000000000001';
  const v2 = 'bbbbbbbb-0000-0000-0000-000000000002';

  describe('updateVendorLinkField — orderCode edits ONE card', () => {
    it('patches only the targeted vendorId\'s orderCode; other rows untouched (per-card isolation)', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: 'US-111' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: '' },
      ];
      const next = updateVendorLinkField(rows, v2, 'orderCode', 'SYS-999');
      expect(next).toEqual([
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: 'US-111' }, // untouched
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: 'SYS-999' }, // only code changed
      ]);
    });

    it('editing orderCode leaves cost + case price of the SAME row untouched', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      expect(updateVendorLinkField(rows, v1, 'orderCode', 'ABC123')).toEqual([
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: 'ABC123' },
      ]);
    });
  });

  describe('vendorRowsToLinkPayload — code trims, empty→undefined (empty→NULL contract)', () => {
    it('maps a present code through to orderCode on the payload row', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: 'ABC123' }];
      expect(vendorRowsToLinkPayload(rows)).toEqual([
        { vendorId: v1, costPerUnit: 5, casePrice: 50, orderCode: 'ABC123' },
      ]);
    });

    it('trims surrounding whitespace on the code ("  X9 " → "X9")', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '  X9 ' }];
      expect(vendorRowsToLinkPayload(rows)[0].orderCode).toBe('X9');
    });

    it('maps an empty code to orderCode: undefined (db coalesces to SQL NULL, not "" or "undefined")', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '' }];
      const payload = vendorRowsToLinkPayload(rows);
      expect(payload[0].orderCode).toBeUndefined();
      // The literal string "undefined" must NEVER reach the payload.
      expect(payload[0].orderCode).not.toBe('undefined');
    });

    it('maps an all-whitespace code to undefined (trim → empty → undefined)', () => {
      const rows: VendorLinkRow[] = [{ vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: '   ' }];
      expect(vendorRowsToLinkPayload(rows)[0].orderCode).toBeUndefined();
    });

    it('carries per-vendor codes independently across two links (AC-1 US-code ≠ Sysco-code)', () => {
      const rows: VendorLinkRow[] = [
        { vendorId: v1, costPerUnit: '5', casePrice: '50', orderCode: 'US-111' },
        { vendorId: v2, costPerUnit: '8', casePrice: '80', orderCode: 'SYS-222' },
      ];
      expect(vendorRowsToLinkPayload(rows)).toEqual([
        { vendorId: v1, costPerUnit: 5, casePrice: 50, orderCode: 'US-111' },
        { vendorId: v2, costPerUnit: 8, casePrice: 80, orderCode: 'SYS-222' },
      ]);
    });
  });

  describe('end-to-end: type a code on one card → it rides the payload (round-trip shape)', () => {
    it('attach V1+V2, set only V2\'s code → V2 payload carries it, V1\'s stays undefined', () => {
      let rows = addVendorLink([], v1, { costPerUnit: '5', casePrice: '50' });
      rows = addVendorLink(rows, v2, { costPerUnit: '8', casePrice: '80' });
      // Operator types a Sysco code into ONLY the V2 card.
      rows = updateVendorLinkField(rows, v2, 'orderCode', 'SYS-777');
      const payload = vendorRowsToLinkPayload(rows);
      const p1 = payload.find((p) => p.vendorId === v1)!;
      const p2 = payload.find((p) => p.vendorId === v2)!;
      expect(p2.orderCode).toBe('SYS-777');
      expect(p1.orderCode).toBeUndefined(); // untyped card → NULL, not V2's code
    });
  });
});

// ─── Spec 115 (W-4, AC-18) — the dead item-level `vendorSku` stub is GONE ─────
//
// The obsolete read-only "vendor sku · schema pending" field was removed from the
// ingredient form; the per-vendor order code (spec 114, `vendors[].orderCode`) is
// now the ONLY place codes live. This pins that `blankValues()` — the source of
// truth for the form's shape — no longer carries a `vendorSku` key, so no dangling
// reference can silently linger. (A type-level assertion also guards the field's
// absence on `IngredientFormValues`.)
describe('spec 115 W-4 — vendorSku stub removed from the form values', () => {
  it('blankValues() has NO vendorSku key', () => {
    const v = blankValues();
    expect('vendorSku' in v).toBe(false);
    expect((v as unknown as Record<string, unknown>).vendorSku).toBeUndefined();
  });

  it('the per-vendor order code lives ONLY on the vendors[] rows (unchanged)', () => {
    // Sanity: the surviving code path is the vendors[] row's orderCode.
    const v = blankValues();
    expect(Array.isArray(v.vendors)).toBe(true);
  });
});
