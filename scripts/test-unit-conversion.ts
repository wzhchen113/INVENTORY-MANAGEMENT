// scripts/test-unit-conversion.ts
// One-shot smoke test for the convertToItemUnit helper that backs the
// reconciliation expected-deduction calculation.
//
// Run: npx tsx scripts/test-unit-conversion.ts
//
// Goal: catch the exact bug we just fixed — recipes specifying ingredients
// in a unit different from the inventory tracking unit, with no conversion,
// produced expected-deduction figures off by orders of magnitude. Each case
// below picks a realistic shape and asserts the converted value.

import { convertToItemUnit } from '../src/utils/unitConversion';
import { InventoryItem } from '../src/types';

let passed = 0;
let failed = 0;

function approxEq(a: number, b: number, tolerance = 0.001): boolean {
  return Math.abs(a - b) <= tolerance;
}

function check(name: string, actual: number | null, expected: number | null) {
  const ok = expected === null
    ? actual === null
    : actual !== null && approxEq(actual, expected);
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name} → ${actual}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} → got ${actual}, expected ${expected}`);
    failed++;
  }
}

// Helper to build a minimal inventory item.
function item(unit: string, caseQty = 0, subUnitSize = 0, subUnitUnit = ''): InventoryItem {
  return {
    id: 'i1', name: 't', category: 'c', unit, costPerUnit: 0, currentStock: 0,
    parLevel: 0, averageDailyUsage: 0, safetyStock: 0, vendorId: '', vendorName: '',
    usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0,
    storeId: 's1', casePrice: 0, caseQty, subUnitSize, subUnitUnit,
  };
}

console.log('\n== convertToItemUnit ==');

// Case 1: identical units — no conversion.
check('same unit (cases→cases)', convertToItemUnit(5, 'cases', item('cases')), 5);
check('same unit case-insensitive (Lbs→lbs)', convertToItemUnit(3, 'Lbs', item('lbs')), 3);

// Case 2: standard weight/volume conversions.
check('oz→lbs', convertToItemUnit(16, 'oz', item('lbs')), 1);
check('lbs→oz', convertToItemUnit(1, 'lbs', item('oz')), 16);
check('g→kg', convertToItemUnit(1500, 'g', item('kg')), 1.5);
check('cups→fl_oz', convertToItemUnit(2, 'cups', item('fl_oz')), 16);

// Case 3: recipe in sub-unit, item tracked in cases.
// 1 case = 20 × 80 = 1600 oz. 0.5 oz/sale × 6890 sales = 3445 oz = 2.153 cases.
check(
  'oz recipe, cases tracking (the +3445 bug fix)',
  convertToItemUnit(0.5 * 6890, 'oz', item('cases', 20, 80, 'oz')),
  3445 / 1600,
);
// Recipe in "lbs" but sub-unit is "oz": 1 lb = 16 oz, so 1 lb / 1600 oz/case
check(
  'lbs recipe via oz sub-unit',
  convertToItemUnit(1, 'lbs', item('cases', 20, 80, 'oz')),
  16 / 1600,
);

// Case 4: abstract sub-unit ("rolls" of toilet paper).
// 1 case = 1 × 80 = 80 rolls. 1 roll/sale × 100 sales = 100 rolls = 1.25 cases.
check(
  'rolls recipe → cases (toilet paper shape)',
  convertToItemUnit(100, 'rolls', item('cases', 1, 80, 'rolls')),
  100 / 80,
);

// Case 5: recipe says "each", item says "bags" of 24, sub-unit "each".
check(
  'each recipe → bags of 24',
  convertToItemUnit(48, 'each', item('bags', 1, 24, 'each')),
  2,
);

// Case 6: unresolvable mismatch returns null.
check(
  'rolls recipe but item is just "lbs" (no sub-unit)',
  convertToItemUnit(5, 'rolls', item('lbs')),
  null,
);
check(
  'no item at all',
  convertToItemUnit(5, 'oz', undefined),
  null,
);

// Case 7: edge cases.
check('zero quantity', convertToItemUnit(0, 'oz', item('lbs')), 0);
check('item with empty unit', convertToItemUnit(5, 'oz', item('')), null);
check('recipe with empty unit', convertToItemUnit(5, '', item('lbs')), null);

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
