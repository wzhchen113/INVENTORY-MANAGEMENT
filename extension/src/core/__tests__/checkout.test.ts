// Spec 162 (AC-2 / AC-3) — the gate that stands between a filled cart and the
// operator's card. These tests exist because every "no" here is money NOT
// wrongly spent, and because the gate is the only part of auto-place that can
// be exercised without a live bjs.com session.
//
// The bias under test is FAIL CLOSED: an unreadable cart, an unreadable total
// and a partially-filled cart all block, and none of them degrade into "assume
// it's fine".

import { describe, expect, it } from 'vitest';
import {
  addressMatches,
  cardMatches,
  evaluateCartGate,
  evaluateSelections,
  failureReason,
  normalizeAddress,
  parseMoney,
  STAGE_REASON,
} from '../checkout';
import type { CheckoutSelections, ExpectedSelections } from '../checkout';
import type { ReportLine } from '../../lib/types';

function line(overrides: Partial<ReportLine> = {}): ReportLine {
  return {
    itemId: overrides.itemId ?? 'i1',
    orderCode: overrides.orderCode ?? 'BJ-1',
    itemName: overrides.itemName ?? 'Flour',
    qty: overrides.qty ?? 2,
    unit: overrides.unit ?? 'case',
    status: overrides.status ?? 'added',
    detail: overrides.detail ?? '',
  };
}

describe('evaluateCartGate — passes only on an exact, affordable match', () => {
  it('allows a cart whose line count matches the PO and total is under the cap', () => {
    const report = [line({ itemId: 'a' }), line({ itemId: 'b' })];
    expect(evaluateCartGate(report, { lineCount: 2, total: 120.5 }, 500)).toBeNull();
  });

  it('allows a total exactly AT the cap (the cap is a ceiling, not an exclusive bound)', () => {
    expect(evaluateCartGate([line()], { lineCount: 1, total: 500 }, 500)).toBeNull();
  });
});

describe('evaluateCartGate — cart-verify refusals', () => {
  it('blocks when any PO line did not make it into the cart', () => {
    const report = [line({ itemId: 'a' }), line({ itemId: 'b', status: 'unmatched', itemName: 'Yeast' })];
    const gate = evaluateCartGate(report, { lineCount: 1, total: 10 }, 500);
    expect(gate?.stage).toBe('cart-verify');
    // The operator has to be able to see WHICH item, not just that one is missing.
    expect(gate?.detail).toContain('Yeast');
    expect(gate?.detail).toContain('unmatched');
  });

  it.each(['failed', 'ambiguous', 'would-add', 'unmatched'] as const)(
    'blocks on a "%s" line — only "added" counts as in the cart',
    (status) => {
      expect(evaluateCartGate([line({ status })], { lineCount: 1, total: 10 }, 500)?.stage).toBe('cart-verify');
    },
  );

  it('caps the named items and says how many more there were', () => {
    const report = Array.from({ length: 9 }, (_, i) =>
      line({ itemId: `i${i}`, itemName: `Item ${i}`, status: 'failed' }),
    );
    const gate = evaluateCartGate(report, { lineCount: 0, total: 0 }, 500);
    expect(gate?.detail).toContain('+4 more');
  });

  it('blocks an empty plan rather than "successfully" ordering nothing', () => {
    expect(evaluateCartGate([], { lineCount: 0, total: 0 }, 500)?.stage).toBe('cart-verify');
  });

  it('blocks when the cart page could not be read at all', () => {
    expect(evaluateCartGate([line()], { lineCount: null, total: 10 }, 500)?.stage).toBe('cart-verify');
  });

  it('blocks when the cart holds MORE lines than the PO (a stale cart)', () => {
    const gate = evaluateCartGate([line()], { lineCount: 3, total: 10 }, 500);
    expect(gate?.stage).toBe('cart-verify');
    expect(gate?.detail).toContain('3 product line(s)');
  });

  it('blocks an unreadable TOTAL — there is no "cap could not be checked, proceed" path', () => {
    const gate = evaluateCartGate([line()], { lineCount: 1, total: null }, 500);
    expect(gate?.stage).toBe('cart-verify');
    expect(gate?.detail).toContain('spend cap');
  });
});

describe('evaluateCartGate — cap-check refusal', () => {
  it('blocks a cart over the cap and quotes both numbers', () => {
    const gate = evaluateCartGate([line()], { lineCount: 1, total: 812.4 }, 500);
    expect(gate?.stage).toBe('cap-check');
    expect(gate?.detail).toContain('$812.40');
    expect(gate?.detail).toContain('$500.00');
  });

  it('blocks a cent over the cap', () => {
    expect(evaluateCartGate([line()], { lineCount: 1, total: 500.01 }, 500)?.stage).toBe('cap-check');
  });

  it('checks the cart BEFORE the cap, so a mismatched cart is never reported as an overspend', () => {
    // Both conditions are wrong at once; the operator needs the more actionable
    // one (the cart is wrong), not "it was expensive".
    const report = [line({ status: 'failed' })];
    expect(evaluateCartGate(report, { lineCount: 1, total: 9999 }, 500)?.stage).toBe('cart-verify');
  });
});

describe('parseMoney', () => {
  it.each([
    ['$1,234.56', 1234.56],
    ['Subtotal: $89.00', 89],
    ['  $7 ', 7],
    ['12.50', 12.5],
  ])('parses %s', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it.each([null, undefined, '', 'Subtotal', '—'])(
    'returns null for %s rather than a misleading zero',
    (raw) => {
      // Returning 0 here would sail under any cap — the exact failure mode this
      // guards against.
      expect(parseMoney(raw as string | null)).toBeNull();
    },
  );
});

// ─── the revision: where it ships and what pays ─────────────────────────────

const EXPECTED: ExpectedSelections = {
  address: '1234 York Rd, Towson MD 21204',
  cardLast4: '4321',
};

function selections(overrides: Partial<CheckoutSelections> = {}): CheckoutSelections {
  return {
    addressText: overrides.addressText !== undefined ? overrides.addressText : '1234 York Rd, Towson MD 21204',
    cardLast4: overrides.cardLast4 !== undefined ? overrides.cardLast4 : '4321',
    addressOptions: overrides.addressOptions ?? [],
    detail: overrides.detail ?? '',
  };
}

describe('normalizeAddress / addressMatches — formatting must not raise a false alarm', () => {
  it('ignores case, punctuation and line breaks', () => {
    expect(addressMatches('1234 YORK RD\nTOWSON, MD 21204', '1234 York Rd, Towson MD 21204')).toBe(true);
  });

  it('accepts a pinned FRAGMENT of the full rendered address', () => {
    expect(addressMatches('1234 York Rd, Towson MD 21204, United States', '1234 York Rd')).toBe(true);
  });

  it('accepts a page that renders LESS than the pinned value', () => {
    expect(addressMatches('1234 York Rd', '1234 York Rd, Towson MD 21204')).toBe(true);
  });

  it('rejects a different address', () => {
    expect(addressMatches('2018 N Charles St, Baltimore MD 21218', '1234 York Rd, Towson MD 21204')).toBe(false);
  });

  it('rejects a null page address and an empty pinned value — never vacuously true', () => {
    expect(addressMatches(null, '1234 York Rd')).toBe(false);
    expect(addressMatches('1234 York Rd', '')).toBe(false);
  });

  it('normalizes to a comparable form', () => {
    expect(normalizeAddress('  1234  York Rd., Towson, MD  ')).toBe('1234 york rd towson md');
  });
});

describe('cardMatches', () => {
  it.each(['4321', '•••• 4321', 'ending in 4321', 'xxxx-4321'])('accepts %s', (raw) => {
    expect(cardMatches(raw, '4321')).toBe(true);
  });

  it('rejects a different card', () => {
    expect(cardMatches('9999', '4321')).toBe(false);
  });

  it('rejects an unreadable card rather than waving it through', () => {
    expect(cardMatches(null, '4321')).toBe(false);
    expect(cardMatches('••••', '4321')).toBe(false);
  });
});

describe('evaluateSelections — the card is never auto-corrected', () => {
  it('passes when both the address and the card match', () => {
    expect(evaluateSelections(selections(), EXPECTED)).toEqual({ ok: true });
  });

  it('refuses a card that is not the one pinned, and names both', () => {
    const v = evaluateSelections(selections({ cardLast4: '9999' }), EXPECTED);
    expect(v).toMatchObject({ ok: false });
    expect('failure' in v && v.failure.stage).toBe('card-verify');
    expect('failure' in v && v.failure.detail).toContain('9999');
    expect('failure' in v && v.failure.detail).toContain('4321');
  });

  it('refuses an UNREADABLE card — the one state where placing anyway is indefensible', () => {
    const v = evaluateSelections(selections({ cardLast4: null }), EXPECTED);
    expect('failure' in v && v.failure.stage).toBe('card-verify');
  });

  it('never offers to switch anything on a card mismatch, even with a matching address option', () => {
    const v = evaluateSelections(
      selections({ cardLast4: '9999', addressText: 'somewhere else', addressOptions: [EXPECTED.address] }),
      EXPECTED,
    );
    // The card is checked FIRST and terminates — an address switch must not
    // become a path around a wrong card.
    expect('switchToOption' in v).toBe(false);
    expect('failure' in v && v.failure.stage).toBe('card-verify');
  });

  it('refuses when the operator pinned nothing', () => {
    const v = evaluateSelections(selections(), { address: '', cardLast4: '' });
    expect('failure' in v && v.failure.stage).toBe('card-verify');
  });
});

describe('evaluateSelections — the address may be corrected, but only to a saved option', () => {
  it('asks to switch when the right address is among the offered options', () => {
    const v = evaluateSelections(
      selections({
        addressText: '2018 N Charles St, Baltimore MD 21218',
        addressOptions: ['2018 N Charles St, Baltimore MD 21218', '1234 York Rd, Towson MD 21204'],
      }),
      EXPECTED,
    );
    expect(v).toEqual({ ok: false, switchToOption: '1234 York Rd, Towson MD 21204' });
  });

  it('refuses when the address is wrong and NO saved option matches', () => {
    const v = evaluateSelections(
      selections({ addressText: '2018 N Charles St, Baltimore MD 21218', addressOptions: [] }),
      EXPECTED,
    );
    expect('failure' in v && v.failure.stage).toBe('address-verify');
    // The operator has to see both addresses to know what BJ's did.
    expect('failure' in v && v.failure.detail).toContain('N Charles');
    expect('failure' in v && v.failure.detail).toContain('York Rd');
  });

  it('refuses an UNREADABLE address rather than trusting the default', () => {
    const v = evaluateSelections(selections({ addressText: null }), EXPECTED);
    expect('failure' in v && v.failure.stage).toBe('address-verify');
  });

  it('does not ask to switch when the address already matches, even if options exist', () => {
    const v = evaluateSelections(
      selections({ addressOptions: ['1234 York Rd, Towson MD 21204', 'somewhere else'] }),
      EXPECTED,
    );
    expect(v).toEqual({ ok: true });
  });
});

describe('failureReason', () => {
  it('leads with the stage sentence and appends the detail', () => {
    const msg = failureReason('cap-check', 'The cart total is $812.40.');
    expect(msg.startsWith(STAGE_REASON['cap-check'])).toBe(true);
    expect(msg).toContain('$812.40');
  });

  it('is still a complete sentence with no detail', () => {
    expect(failureReason('challenge', '')).toBe(STAGE_REASON.challenge);
  });

  it('has a reason for every stage — a stage with no copy would email a blank', () => {
    for (const stage of Object.keys(STAGE_REASON) as (keyof typeof STAGE_REASON)[]) {
      expect(STAGE_REASON[stage].length).toBeGreaterThan(10);
    }
  });
});
