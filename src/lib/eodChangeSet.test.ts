// src/lib/eodChangeSet.test.ts — Spec 189 design §5 (D-4 on the client).
//
// One arm per row of the §5 tables: the per-case table, the two-editor table
// and the "When the set is empty" table. The two-editor arms simulate the
// server's targeted write (shipped rows replace, named removals delete,
// anything unnamed stays) with a tiny in-test model, since the point of those
// rows is what each editor's change set does and does NOT name.

import {
  buildEodChangeSet,
  eodRowSnapshot,
  planEodSubmit,
  sameEodRow,
  type EodChangeSetArgs,
  type EodRowSnapshot,
} from './eodChangeSet';
import type { EodCountMode } from './eodCountMode';

// ── fixtures ─────────────────────────────────────────────────────────
// p1/p2 are "Produce", d1/d2 are "Dairy" — the pill is a UI filter only and
// never reaches the helper, which is the point of D-4.
const ITEMS = [
  { id: 'p1', caseQty: 24 },
  { id: 'p2', caseQty: 24 },
  { id: 'd1', caseQty: 1 },
  { id: 'd2', caseQty: 1 },
  { id: 'off', caseQty: 1 }, // linked to another vendor (escape-hatch row)
];
const MODES: Record<string, EodCountMode> = {
  p1: 'cases_and_units',
  p2: 'cases_and_units',
  d1: 'units_only',
  d2: 'units_only',
  off: 'units_only',
};

const row = (over: Partial<EodRowSnapshot> = {}): EodRowSnapshot => ({
  caseRaw: '',
  unitRaw: '',
  note: '',
  noNeed: false,
  ...over,
});

type Maps = Pick<EodChangeSetArgs, 'caseCounts' | 'unitCounts' | 'notes' | 'noNeed'>;

/** The maps EDIT would seed from a baseline (what the manager is shown). */
function seedMaps(baseline: Record<string, EodRowSnapshot>): Maps {
  const m: Maps = { caseCounts: {}, unitCounts: {}, notes: {}, noNeed: {} };
  for (const [id, r] of Object.entries(baseline)) {
    m.caseCounts[id] = r.caseRaw;
    m.unitCounts[id] = r.unitRaw;
    m.notes[id] = r.note;
    if (r.noNeed) m.noNeed[id] = true;
  }
  return m;
}

function emptyMaps(): Maps {
  return { caseCounts: {}, unitCounts: {}, notes: {}, noNeed: {} };
}

function args(maps: Maps, baseline?: Record<string, EodRowSnapshot>, over: Partial<EodChangeSetArgs> = {}): EodChangeSetArgs {
  return {
    storeItems: ITEMS,
    baseline,
    ...maps,
    modeOf: (id) => MODES[id] ?? 'cases_and_units',
    ...over,
  };
}

// A saved vendor count across two categories plus an off-vendor row.
const SAVED: Record<string, EodRowSnapshot> = {
  p1: row({ caseRaw: '2', unitRaw: '5' }),
  p2: row({ caseRaw: '1', unitRaw: '' }),
  d1: row({ unitRaw: '6' }),
  d2: row({ unitRaw: '8', note: 'top shelf' }),
};

// ── per-case table ───────────────────────────────────────────────────
describe('buildEodChangeSet — §5 per-case table', () => {
  it('EDIT under a pill, nothing changed → nothing named (the plan is a no-RPC noop)', () => {
    const cs = buildEodChangeSet(args(seedMaps(SAVED), SAVED));
    expect(cs).toEqual({ changedItemIds: [], removedItemIds: [] });
    expect(planEodSubmit({ ...args(seedMaps(SAVED), SAVED), statusChanges: false })).toEqual({ kind: 'noop' });
  });

  it('EDIT under a pill, change one row → only that row; other categories stay', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d1 = '7';
    expect(buildEodChangeSet(args(maps, SAVED))).toEqual({ changedItemIds: ['d1'], removedItemIds: [] });
  });

  it('count one category, EDIT, count the next → only the new rows; both present', () => {
    const firstCategory = { p1: SAVED.p1, p2: SAVED.p2 };
    const maps = seedMaps(firstCategory);
    maps.unitCounts.d1 = '6';
    maps.unitCounts.d2 = '8';
    expect(buildEodChangeSet(args(maps, firstCategory))).toEqual({ changedItemIds: ['d1', 'd2'], removedItemIds: [] });
  });

  it('first SUBMIT under a pill, values typed under other pills → everything typed for the vendor (the D-4 visible change)', () => {
    const maps = emptyMaps();
    maps.caseCounts.p1 = '2'; // typed under "Produce"
    maps.unitCounts.d2 = '3'; // typed under "Dairy"
    expect(buildEodChangeSet(args(maps, undefined))).toEqual({ changedItemIds: ['d2', 'p1'], removedItemIds: [] });
  });

  it('draft, reload, count the rest, submit → only what was typed after the reload; drafted rows are not named', () => {
    // After a reload drafts have no EDIT and no refill: no baseline, empty maps.
    const maps = emptyMaps();
    maps.unitCounts.d1 = '4';
    maps.unitCounts.d2 = '5';
    const cs = buildEodChangeSet(args(maps, undefined));
    expect(cs).toEqual({ changedItemIds: ['d1', 'd2'], removedItemIds: [] });
    // Typing over a drafted row replaces it.
    maps.caseCounts.p1 = '3';
    expect(buildEodChangeSet(args(maps, undefined)).changedItemIds).toEqual(['d1', 'd2', 'p1']);
  });

  it('draft, then blank a row in the same session → a removal of that row', () => {
    // The successful draft save advanced the baseline to the shipped rows.
    const drafted = { p1: SAVED.p1, d1: SAVED.d1 };
    const maps = seedMaps(drafted);
    maps.caseCounts.p1 = '';
    maps.unitCounts.p1 = '';
    expect(buildEodChangeSet(args(maps, drafted))).toEqual({ changedItemIds: [], removedItemIds: ['p1'] });
  });

  it('EDIT after reload with an off-vendor item in the submission → nothing for it; the row stays', () => {
    const saved = { ...SAVED, off: row({ unitRaw: '3' }) };
    // EDIT seeded its value (the row isn't on screen, so it can't be blanked).
    const cs = buildEodChangeSet(args(seedMaps(saved), saved));
    expect(cs).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('a shared item counted only under another vendor\'s tab → not part of this submission', () => {
    // No key in THIS vendor's maps and no baseline row.
    const maps = seedMaps(SAVED);
    expect(buildEodChangeSet(args(maps, SAVED))).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('EDIT, blank a row → only that row is removed', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d2 = '';
    expect(buildEodChangeSet(args(maps, SAVED))).toEqual({ changedItemIds: [], removedItemIds: ['d2'] });
  });

  it('blank a row with no saved entry → nothing to do', () => {
    const maps = emptyMaps();
    maps.caseCounts.p1 = '';
    maps.unitCounts.p1 = '  ';
    expect(buildEodChangeSet(args(maps, undefined))).toEqual({ changedItemIds: [], removedItemIds: [] });
    // Same with an untouched saved row alongside it.
    const withSaved = seedMaps({ d1: SAVED.d1 });
    withSaved.caseCounts.p1 = '';
    expect(buildEodChangeSet(args(withSaved, { d1: SAVED.d1 }))).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('legacy null-total row, untouched (seeded "0") → nothing; it stays null and on-hand is not written', () => {
    const saved = { d1: row({ unitRaw: '0' }) };
    expect(buildEodChangeSet(args(seedMaps(saved), saved))).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('saved value in a box the mode has since disabled → stays; typing into the enabled box ships it', () => {
    // d1 is units_only now; its saved value sits in the cases box.
    const saved = { d1: row({ caseRaw: '2', unitRaw: '' }) };
    expect(buildEodChangeSet(args(seedMaps(saved), saved))).toEqual({ changedItemIds: [], removedItemIds: [] });
    const maps = seedMaps(saved);
    maps.unitCounts.d1 = '9';
    expect(buildEodChangeSet(args(maps, saved))).toEqual({ changedItemIds: ['d1'], removedItemIds: [] });
  });

  it('saved value only in a disabled box, note edited → NOT removed (the manager never saw a count to clear)', () => {
    const saved = { d1: row({ caseRaw: '2', unitRaw: '' }) };
    const maps = seedMaps(saved);
    maps.notes.d1 = 'check tomorrow';
    expect(buildEodChangeSet(args(maps, saved))).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('NO NEED untouched → nothing; toggled off with blank boxes → removal', () => {
    const saved = { p2: row({ noNeed: true }) };
    expect(buildEodChangeSet(args(seedMaps(saved), saved))).toEqual({ changedItemIds: [], removedItemIds: [] });
    const maps = seedMaps(saved);
    delete maps.noNeed.p2;
    expect(buildEodChangeSet(args(maps, saved))).toEqual({ changedItemIds: [], removedItemIds: ['p2'] });
  });

  it('NO NEED set on a saved numeric row, or a note-only change on a counted row → changed', () => {
    const maps = seedMaps(SAVED);
    maps.caseCounts.p1 = '';
    maps.unitCounts.p1 = '';
    maps.noNeed.p1 = true;
    maps.notes.p2 = 'dented';
    expect(buildEodChangeSet(args(maps, SAVED))).toEqual({ changedItemIds: ['p1', 'p2'], removedItemIds: [] });
  });

  it('an enabled box holding unparseable text is not blank → changed, not removed', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d1 = 'abc';
    expect(buildEodChangeSet(args(maps, SAVED))).toEqual({ changedItemIds: ['d1'], removedItemIds: [] });
  });

  it('an item not in storeItems (another store\'s id) is skipped, typed or in the baseline', () => {
    const baseline = { ...SAVED, foreign: row({ unitRaw: '1' }) };
    const maps = seedMaps(baseline);
    maps.unitCounts.foreign = '';
    maps.unitCounts.foreign2 = '5';
    expect(buildEodChangeSet(args(maps, baseline))).toEqual({ changedItemIds: [], removedItemIds: [] });
  });

  it('failed write, then retry → the same diff (pure: unchanged inputs give the same result)', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d1 = '7';
    maps.unitCounts.d2 = '';
    const first = buildEodChangeSet(args(maps, SAVED));
    const retry = buildEodChangeSet(args(maps, SAVED));
    expect(retry).toEqual(first);
    expect(first).toEqual({ changedItemIds: ['d1'], removedItemIds: ['d2'] });
  });
});

// ── two-editor table ─────────────────────────────────────────────────
// A model of the server's targeted write (§4): removals delete only named
// rows, shipped rows replace, anything unnamed stays.
type ServerRows = Record<string, string>; // itemId -> stored units value
function applyWrite(server: ServerRows, cs: { changedItemIds: string[]; removedItemIds: string[] }, maps: Maps): ServerRows {
  const next = { ...server };
  for (const id of cs.removedItemIds) delete next[id];
  for (const id of cs.changedItemIds) next[id] = maps.unitCounts[id];
  return next;
}
const unitsBaseline = (server: ServerRows): Record<string, EodRowSnapshot> =>
  Object.fromEntries(Object.entries(server).map(([id, u]) => [id, row({ unitRaw: u })]));

describe('buildEodChangeSet — §5 two-editor table', () => {
  const server0: ServerRows = { d1: '6', d2: '8' };

  it('A changes X, B changes Y → both survive, in either order', () => {
    const base = unitsBaseline(server0);
    const mapsA = seedMaps(base);
    mapsA.unitCounts.d1 = '1';
    const mapsB = seedMaps(base);
    mapsB.unitCounts.d2 = '2';
    const csA = buildEodChangeSet(args(mapsA, base));
    const csB = buildEodChangeSet(args(mapsB, base));
    expect(csA).toEqual({ changedItemIds: ['d1'], removedItemIds: [] });
    expect(csB).toEqual({ changedItemIds: ['d2'], removedItemIds: [] });
    expect(applyWrite(applyWrite(server0, csA, mapsA), csB, mapsB)).toEqual({ d1: '1', d2: '2' });
    expect(applyWrite(applyWrite(server0, csB, mapsB), csA, mapsA)).toEqual({ d1: '1', d2: '2' });
  });

  it('B adds or re-counts a row after A opened EDIT, A doesn\'t touch it → A\'s save doesn\'t mention it', () => {
    const baseA = unitsBaseline(server0);
    const mapsA = seedMaps(baseA);
    mapsA.unitCounts.d2 = '9';
    // B meanwhile re-counted d1 and added p1.
    const serverAfterB: ServerRows = { d1: '4', d2: '8', p1: '3' };
    const csA = buildEodChangeSet(args(mapsA, baseA));
    expect(csA).toEqual({ changedItemIds: ['d2'], removedItemIds: [] });
    expect(applyWrite(serverAfterB, csA, mapsA)).toEqual({ d1: '4', d2: '9', p1: '3' });
  });

  it('both change X → last write wins (no compare-and-swap)', () => {
    const base = unitsBaseline(server0);
    const mapsA = seedMaps(base);
    mapsA.unitCounts.d1 = '1';
    const mapsB = seedMaps(base);
    mapsB.unitCounts.d1 = '2';
    const csA = buildEodChangeSet(args(mapsA, base));
    const csB = buildEodChangeSet(args(mapsB, base));
    expect(applyWrite(applyWrite(server0, csA, mapsA), csB, mapsB).d1).toBe('2');
    expect(applyWrite(applyWrite(server0, csB, mapsB), csA, mapsA).d1).toBe('1');
  });

  it('A blanks X, B changed X after A loaded → A\'s removal wins (A saw a value and cleared it)', () => {
    const baseA = unitsBaseline(server0);
    const mapsA = seedMaps(baseA);
    mapsA.unitCounts.d1 = '';
    const serverAfterB: ServerRows = { d1: '12', d2: '8' };
    const csA = buildEodChangeSet(args(mapsA, baseA));
    expect(csA).toEqual({ changedItemIds: [], removedItemIds: ['d1'] });
    expect(applyWrite(serverAfterB, csA, mapsA)).toEqual({ d2: '8' });
  });
});

// ── "When the set is empty" table ────────────────────────────────────
describe('planEodSubmit — §5 "When the set is empty" table', () => {
  it('empty change set, no baseline → empty ("enter at least one")', () => {
    // Draft everything, reload, press SUBMIT: no maps, no baseline.
    expect(planEodSubmit({ ...args(emptyMaps(), undefined), statusChanges: true })).toEqual({ kind: 'empty' });
    expect(planEodSubmit({ ...args(emptyMaps(), {}), statusChanges: false })).toEqual({ kind: 'empty' });
  });

  it('empty change set, baseline, status unchanged → noop (no RPC)', () => {
    expect(planEodSubmit({ ...args(seedMaps(SAVED), SAVED), statusChanges: false })).toEqual({ kind: 'noop' });
  });

  it('empty change set, baseline, status changes → ships the baseline rows to carry it', () => {
    expect(planEodSubmit({ ...args(seedMaps(SAVED), SAVED), statusChanges: true })).toEqual({
      kind: 'ship',
      itemIds: ['d1', 'd2', 'p1', 'p2'],
      removedItemIds: [],
    });
  });

  it('status change carry skips baseline rows with no value under the live mode; none left → empty', () => {
    const saved = { d1: row({ caseRaw: '2' }), d2: SAVED.d2 };
    expect(planEodSubmit({ ...args(seedMaps(saved), saved), statusChanges: true })).toEqual({
      kind: 'ship',
      itemIds: ['d2'],
      removedItemIds: [],
    });
    const onlyDisabled = { d1: row({ caseRaw: '2' }) };
    expect(planEodSubmit({ ...args(seedMaps(onlyDisabled), onlyDisabled), statusChanges: true })).toEqual({ kind: 'empty' });
  });

  it('would remove every baseline row and ship nothing → empty', () => {
    const maps = seedMaps(SAVED);
    for (const id of Object.keys(SAVED)) {
      maps.caseCounts[id] = '';
      maps.unitCounts[id] = '';
    }
    expect(planEodSubmit({ ...args(maps, SAVED), statusChanges: false })).toEqual({ kind: 'empty' });
  });

  it('a blank-only correction that leaves rows is shipped (AC-25)', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d2 = '';
    expect(planEodSubmit({ ...args(maps, SAVED), statusChanges: false })).toEqual({
      kind: 'ship',
      itemIds: [],
      removedItemIds: ['d2'],
    });
  });

  it('a non-empty change set ships as is, status change or not', () => {
    const maps = seedMaps(SAVED);
    maps.unitCounts.d1 = '7';
    maps.unitCounts.d2 = '';
    for (const statusChanges of [true, false]) {
      expect(planEodSubmit({ ...args(maps, SAVED), statusChanges })).toEqual({
        kind: 'ship',
        itemIds: ['d1'],
        removedItemIds: ['d2'],
      });
    }
  });
});

describe('eodRowSnapshot / sameEodRow', () => {
  it('reads absent keys as blank / not NO NEED, and compares all four fields', () => {
    const snap = eodRowSnapshot(emptyMaps(), 'x');
    expect(snap).toEqual(row());
    expect(sameEodRow(snap, row())).toBe(true);
    expect(sameEodRow(row({ note: 'a' }), row())).toBe(false);
    expect(sameEodRow(row({ noNeed: true }), row())).toBe(false);
  });
});
