// src/lib/countDrafts.test.ts — Spec 106.
//
// Pure-function unit tests for the count-screen save-draft + resume helpers.
// Lives in the fast node-env project (no React / DOM — countDrafts.ts is
// dependency-free). This is the AC-18 jest surface; it covers BOTH the admin
// path and the staff carve-out because both import the SAME pure module.
//
// Covers:
//   - reconcileDrafts — all six branches of whole-draft last-write-wins
//     (both-null, server-only, local-only-push, local-newer-push,
//     server-newer-adopt, equal-tie server-wins) (AC-15/16);
//   - applyDraftStaleFilter — drops deleted-since ids from all three per-item
//     maps, header fields pass through (AC-11);
//   - serialize↔deserialize round-trip for both payload shapes (AC-3/AC-5:
//     verbatim strings, "0" stays "0", "" stays "");
//   - malformed-payload tolerance (unknown v, non-object, out-of-enum kind).

import {
  reconcileDrafts,
  applyDraftStaleFilter,
  serializeAdminInventoryDraft,
  deserializeAdminInventoryDraft,
  serializeWeeklyDraft,
  deserializeWeeklyDraft,
  COUNT_DRAFT_PAYLOAD_VERSION,
  type LocalDraftCandidate,
  type DraftCandidate,
} from './countDrafts';

// Two fixed ISO timestamps, older < newer lexicographically (== chronologically).
const T_OLD = '2026-07-02T10:00:00.000Z';
const T_NEW = '2026-07-02T11:30:00.000Z';

const localCand = (
  savedAt: string,
  unsynced: boolean,
  payload: Record<string, unknown> = { v: 1, tag: 'local' },
): LocalDraftCandidate => ({ payload, savedAt, unsynced });

const serverCand = (
  savedAt: string,
  payload: Record<string, unknown> = { v: 1, tag: 'server' },
): DraftCandidate => ({ payload, savedAt });

describe('reconcileDrafts — whole-draft last-write-wins (AC-15/16)', () => {
  test('both null → nothing to restore or sync', () => {
    expect(reconcileDrafts(null, null)).toEqual({
      winner: null,
      restoreFrom: 'none',
      action: 'none',
    });
  });

  test('server only → adopt server, no push', () => {
    const s = serverCand(T_OLD);
    expect(reconcileDrafts(null, s)).toEqual({
      winner: s,
      restoreFrom: 'server',
      action: 'none',
    });
  });

  test('local only → local wins and is pushed up', () => {
    const l = localCand(T_OLD, true);
    expect(reconcileDrafts(l, null)).toEqual({
      winner: l,
      restoreFrom: 'local',
      action: 'push',
    });
  });

  test('local newer than server → local wins, action push (sync up)', () => {
    const l = localCand(T_NEW, true);
    const s = serverCand(T_OLD);
    const r = reconcileDrafts(l, s);
    expect(r.restoreFrom).toBe('local');
    expect(r.action).toBe('push');
    expect(r.winner).toBe(l);
  });

  test('local older than server → server wins, action adopt-clear-local', () => {
    const l = localCand(T_OLD, true);
    const s = serverCand(T_NEW);
    const r = reconcileDrafts(l, s);
    expect(r.restoreFrom).toBe('server');
    expect(r.action).toBe('adopt-clear-local');
    expect(r.winner).toBe(s);
  });

  test('equal saved_at (byte-for-byte) → SERVER wins (tie), action clear-local-flag', () => {
    // The normal "same write, already synced" steady state: one saved_at minted
    // for both copies at Save time. Tie must NOT re-push.
    const l = localCand(T_NEW, true);
    const s = serverCand(T_NEW);
    const r = reconcileDrafts(l, s);
    expect(r.restoreFrom).toBe('server');
    expect(r.action).toBe('clear-local-flag');
    expect(r.winner).toBe(s);
  });

  test('equal saved_at with an already-synced local (unsynced:false) → still server-wins tie, clear-local-flag', () => {
    const l = localCand(T_NEW, false);
    const s = serverCand(T_NEW);
    const r = reconcileDrafts(l, s);
    expect(r.action).toBe('clear-local-flag');
    expect(r.restoreFrom).toBe('server');
  });
});

describe('applyDraftStaleFilter — deleted-since id tolerance (AC-11)', () => {
  const liveIds = new Set<string>(['a', 'b']);

  test('drops ids not in the live set across all three per-item maps', () => {
    const payload = {
      v: 1,
      kind: 'spot',
      countedAtLocal: '2026-07-02T09:00',
      notes: 'header note',
      caseCounts: { a: '1', b: '2', ghost: '9' },
      unitCounts: { a: '0', gone: '7' },
      itemNotes: { b: 'ok', deleted: 'stale' },
    };
    const out = applyDraftStaleFilter(payload, liveIds);
    expect(out.caseCounts).toEqual({ a: '1', b: '2' });
    expect(out.unitCounts).toEqual({ a: '0' });
    expect(out.itemNotes).toEqual({ b: 'ok' });
  });

  test('header fields (kind / countedAtLocal / notes / v) pass through untouched', () => {
    const payload = {
      v: 1,
      kind: 'close',
      countedAtLocal: '2026-07-02T09:00',
      notes: 'keep me',
      caseCounts: { ghost: '9' },
      unitCounts: {},
      itemNotes: {},
    };
    const out = applyDraftStaleFilter(payload, liveIds);
    expect(out.v).toBe(1);
    expect(out.kind).toBe('close');
    expect(out.countedAtLocal).toBe('2026-07-02T09:00');
    expect(out.notes).toBe('keep me');
    expect(out.caseCounts).toEqual({}); // ghost dropped
  });

  test('does not mutate the input payload', () => {
    const payload = { caseCounts: { a: '1', ghost: '9' }, unitCounts: {}, itemNotes: {} };
    const snapshot = JSON.parse(JSON.stringify(payload));
    applyDraftStaleFilter(payload, liveIds);
    expect(payload).toEqual(snapshot);
  });

  test('non-object payload yields {}', () => {
    expect(applyDraftStaleFilter(null as unknown as Record<string, unknown>, liveIds)).toEqual({});
    expect(applyDraftStaleFilter([] as unknown as Record<string, unknown>, liveIds)).toEqual({});
  });

  test('empty live set drops every per-item entry', () => {
    const payload = { caseCounts: { a: '1' }, unitCounts: { b: '2' }, itemNotes: { c: 'x' } };
    const out = applyDraftStaleFilter(payload, new Set<string>());
    expect(out.caseCounts).toEqual({});
    expect(out.unitCounts).toEqual({});
    expect(out.itemNotes).toEqual({});
  });
});

describe('admin-inventory serialize ↔ deserialize round-trip (AC-3 / AC-5)', () => {
  test('round-trips verbatim strings ("0" stays "0", "" stays "")', () => {
    const form = {
      kind: 'mid_shift',
      countedAtLocal: '2026-07-02T14:30',
      notes: 'partial count',
      caseCounts: { a: '0', b: '', c: '12' },
      unitCounts: { a: '3', b: '0' },
      itemNotes: { a: 'checked twice', b: '' },
    };
    const payload = serializeAdminInventoryDraft(form);
    expect(payload.v).toBe(COUNT_DRAFT_PAYLOAD_VERSION);
    const back = deserializeAdminInventoryDraft(payload);
    expect(back.kind).toBe('mid_shift');
    expect(back.countedAtLocal).toBe('2026-07-02T14:30');
    expect(back.notes).toBe('partial count');
    expect(back.caseCounts).toEqual({ a: '0', b: '', c: '12' });
    expect(back.unitCounts).toEqual({ a: '3', b: '0' });
    expect(back.itemNotes).toEqual({ a: 'checked twice', b: '' });
  });

  test('out-of-enum kind falls back to "spot"', () => {
    const payload = serializeAdminInventoryDraft({
      kind: 'not_a_kind',
      countedAtLocal: '',
      notes: '',
      caseCounts: {},
      unitCounts: {},
      itemNotes: {},
    });
    expect(deserializeAdminInventoryDraft(payload).kind).toBe('spot');
  });

  test('all four valid kinds round-trip', () => {
    for (const kind of ['spot', 'open', 'mid_shift', 'close'] as const) {
      const payload = serializeAdminInventoryDraft({
        kind,
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: {},
        itemNotes: {},
      });
      expect(deserializeAdminInventoryDraft(payload).kind).toBe(kind);
    }
  });
});

describe('staff-weekly serialize ↔ deserialize round-trip (AC-3 / AC-5)', () => {
  test('round-trips case/unit maps verbatim', () => {
    const form = { caseCounts: { a: '0', b: '5' }, unitCounts: { a: '', b: '2' } };
    const payload = serializeWeeklyDraft(form);
    expect(payload.v).toBe(COUNT_DRAFT_PAYLOAD_VERSION);
    const back = deserializeWeeklyDraft(payload);
    expect(back.caseCounts).toEqual({ a: '0', b: '5' });
    expect(back.unitCounts).toEqual({ a: '', b: '2' });
  });
});

describe('malformed-payload tolerance (hydrateQueue posture)', () => {
  test('admin deserialize of a non-object yields an empty-but-valid form', () => {
    const back = deserializeAdminInventoryDraft(null as unknown as Record<string, unknown>);
    expect(back).toEqual({
      kind: 'spot',
      countedAtLocal: '',
      notes: '',
      caseCounts: {},
      unitCounts: {},
      itemNotes: {},
    });
  });

  test('admin deserialize reads fields forward-tolerantly (no v-gating): drops non-string map junk, keeps valid string entries, absent fields → empty', () => {
    // No `v` key at all — deserialize does NOT version-gate, it reads each field
    // forward-tolerantly: a numeric map value is dropped, absent fields → empty.
    const payload = {
      kind: 'open',
      caseCounts: { a: '1', bad: 5 as unknown as string },
      // countedAtLocal / notes / unitCounts / itemNotes absent
    };
    const back = deserializeAdminInventoryDraft(payload);
    expect(back.kind).toBe('open');
    expect(back.countedAtLocal).toBe('');
    expect(back.notes).toBe('');
    expect(back.caseCounts).toEqual({ a: '1' }); // numeric `bad` dropped
    expect(back.unitCounts).toEqual({});
    expect(back.itemNotes).toEqual({});
  });

  test('weekly deserialize of a non-object yields empty maps', () => {
    expect(deserializeWeeklyDraft(undefined as unknown as Record<string, unknown>)).toEqual({
      caseCounts: {},
      unitCounts: {},
    });
    expect(deserializeWeeklyDraft([] as unknown as Record<string, unknown>)).toEqual({
      caseCounts: {},
      unitCounts: {},
    });
  });

  test('weekly deserialize drops non-string map values', () => {
    const back = deserializeWeeklyDraft({
      caseCounts: { a: '2', b: 3 as unknown as string, c: null as unknown as string },
      unitCounts: { a: '1' },
    });
    expect(back.caseCounts).toEqual({ a: '2' });
    expect(back.unitCounts).toEqual({ a: '1' });
  });
});
