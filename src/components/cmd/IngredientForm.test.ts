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

import { validateCustomUnit, CUSTOM_UNIT_MAX_LEN } from './IngredientForm';
import { CANONICAL_UNITS, calcUnitCost } from '../../utils/unitConversion';

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

// ─── Spec 093 (Q3a) — calcUnitCost divides by case_qty alone ─────────────────
//
// Pins the cost-math alignment: per-unit cost = case_price / case_qty, matching
// how prod `default_cost` was computed. The third argument (`subUnitSize`) is
// retained in the 3-arg signature for call-site compatibility but must no
// longer affect the result — conflating case_qty × sub_unit_size is the
// documented 12×-class error spec 093 fixes.
describe('calcUnitCost (spec 093 Q3a — divide by case_qty alone)', () => {
  it('calcUnitCost(20.00, 20, anything) === 1.00 — third arg does not affect result', () => {
    // The AC literally pins a 3-arg call with the third argument irrelevant.
    expect(calcUnitCost(20.0, 20, 0)).toBe(1.0);
    expect(calcUnitCost(20.0, 20, 1)).toBe(1.0);
    expect(calcUnitCost(20.0, 20, 999)).toBe(1.0);
  });

  it('calcUnitCost(20, 20, 5) === 1.00 — sub_unit_size > 1 changes nothing', () => {
    expect(calcUnitCost(20, 20, 5)).toBe(1.0);
  });

  it('per-unit cost is case_price / case_qty regardless of sub_unit_size', () => {
    // 50 / 500 = 0.10 — the migrated Brown-Paper-Bag shape (case_qty=500).
    expect(calcUnitCost(50, 500, 1)).toBeCloseTo(0.1, 10);
    // sub_unit_size varying does not move the result.
    expect(calcUnitCost(50, 500, 10)).toBeCloseTo(0.1, 10);
  });

  it('returns 0 for a non-positive case_qty (guard preserved)', () => {
    expect(calcUnitCost(20, 0, 5)).toBe(0);
    expect(calcUnitCost(20, -1, 5)).toBe(0);
  });
});
