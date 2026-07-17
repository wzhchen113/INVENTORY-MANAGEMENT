// src/lib/db.uploadIngredientImage.test.ts — Spec 127 (ingredient-photos) Track 1 (jest).
//
// Unit-tests the two Storage-backed db.ts helpers added by spec 127 — the
// named highest-risk behaviour (upload → set-column → delete-old, with
// orphan-cleanup when the column write fails):
//   - uploadIngredientImage(catalogId, brandId, blob): reads the previous
//     image_path, uploads a fresh `<brand>/<catalog>/<uuid>.jpg` object, points
//     catalog_ingredients.image_path at the new path, then best-effort deletes
//     the OLD object. If the column UPDATE fails AFTER a successful upload, the
//     just-uploaded object is removed (no orphan) and the error propagates.
//   - removeIngredientImage(catalogId): NULLs the column first, then best-effort
//     deletes the object.
//
// Mocking strategy mirrors db.updateStore.test.ts:
//   - jest.mock('./supabase') — supabase.from('catalog_ingredients') returns a
//     shared chainable builder; supabase.storage.from('ingredient-images')
//     returns a shared { upload, remove } object. Both the PostgREST and the
//     Storage arms are tracked jest.fns so ORDER can be asserted via a shared
//     `callLog`. `.abortSignal()` returns an object that is BOTH awaitable (the
//     UPDATE terminal) AND carries `.maybeSingle()` (the SELECT-read terminal).
//   - jest.mock('./inflight') — track(fn) invokes fn directly with a dummy
//     AbortSignal so the real 30s timers never arm in node.
//   - jest.mock('./auth') — db.ts imports callEdgeFunction from it; stub so the
//     import graph stays light. Not exercised here.

type Uuid = `${string}-${string}-${string}-${string}-${string}`;
const FIXED_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as Uuid;

// Ordered log of the storage/postgrest side-effects, shared across both arms so
// a test can assert the sequence (read → upload → update → remove-old, etc.).
let callLog: string[] = [];

// PostgREST arm (catalog_ingredients).
let selectSpy: jest.Mock;
let updateSpy: jest.Mock;
let eqSpy: jest.Mock;
let abortSpy: jest.Mock;
let maybeSingleSpy: jest.Mock;
let builder: any;
// The UPDATE terminal awaits `.abortSignal(signal)` directly; this holder lets
// a test arm a column-write failure.
let updateResult: { error: unknown };

// Storage arm (ingredient-images bucket).
let uploadSpy: jest.Mock;
let removeSpy: jest.Mock;
let mockStorageFrom: jest.Mock;

const mockFrom = jest.fn((table: string) => {
  if (table === 'catalog_ingredients') return builder;
  throw new Error(`unexpected table in db.uploadIngredientImage test: ${table}`);
});

jest.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => mockFrom(table),
    storage: { from: (bucket: string) => mockStorageFrom(bucket) },
  },
}));

jest.mock('./inflight', () => ({
  useInflight: {
    getState: () => ({
      track: (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }),
  },
}));

jest.mock('./auth', () => ({ callEdgeFunction: jest.fn() }));

import { uploadIngredientImage, removeIngredientImage } from './db';

beforeEach(() => {
  jest.clearAllMocks();
  callLog = [];

  // ── PostgREST builder ───────────────────────────────────────────
  maybeSingleSpy = jest.fn(async () => {
    callLog.push('read');
    return { data: { image_path: null }, error: null };
  });
  updateResult = { error: null };
  // `.abortSignal()` returns a dual-purpose terminal:
  //   - SELECT read path: `.maybeSingle()` resolves to { data }.
  //   - UPDATE path: the object itself is awaited → resolves to updateResult.
  abortSpy = jest.fn(() => ({
    maybeSingle: maybeSingleSpy,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(updateResult).then(resolve, reject),
  }));
  selectSpy = jest.fn().mockReturnThis();
  updateSpy = jest.fn((body: any) => {
    callLog.push('update');
    return builder;
  });
  eqSpy = jest.fn().mockReturnThis();
  builder = {
    select: selectSpy,
    update: updateSpy,
    eq: eqSpy,
    abortSignal: abortSpy,
  };

  // ── Storage builder ─────────────────────────────────────────────
  uploadSpy = jest.fn(async () => {
    callLog.push('upload');
    return { data: { path: 'x' }, error: null };
  });
  removeSpy = jest.fn(async (paths: string[]) => {
    callLog.push(`remove:${paths.join(',')}`);
    return { data: [], error: null };
  });
  mockStorageFrom = jest.fn(() => ({ upload: uploadSpy, remove: removeSpy }));

  jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(FIXED_UUID);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('uploadIngredientImage — spec 127', () => {
  it('happy path (no previous): uploads to <brand>/<catalog>/<uuid>.jpg, sets image_path, returns the new path', async () => {
    // No previous object.
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: null }, error: null };
    });

    const blob = { size: 10 } as unknown as Blob;
    const newPath = await uploadIngredientImage('cat-1', 'brand-1', blob);

    const expectedPath = `brand-1/cat-1/${FIXED_UUID}.jpg`;
    expect(newPath).toBe(expectedPath);

    // Storage upload targeted the right bucket + key, upsert:false.
    expect(mockStorageFrom).toHaveBeenCalledWith('ingredient-images');
    expect(uploadSpy).toHaveBeenCalledWith(
      expectedPath,
      blob,
      { contentType: 'image/jpeg', upsert: false },
    );

    // Column write points at the new path and filters by catalog id.
    expect(mockFrom).toHaveBeenCalledWith('catalog_ingredients');
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ image_path: expectedPath }),
    );
    expect(eqSpy).toHaveBeenCalledWith('id', 'cat-1');

    // No previous object → no old-object delete.
    expect(removeSpy).not.toHaveBeenCalled();

    // Order: read the previous path, THEN upload, THEN set the column.
    expect(callLog).toEqual(['read', 'upload', 'update']);
  });

  it('happy path (with previous): best-effort deletes the OLD object AFTER the column is set', async () => {
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: 'brand-1/cat-1/old-uuid.jpg' }, error: null };
    });

    const expectedPath = `brand-1/cat-1/${FIXED_UUID}.jpg`;
    const newPath = await uploadIngredientImage('cat-1', 'brand-1', { size: 5 } as unknown as Blob);
    expect(newPath).toBe(expectedPath);

    // Old object removed exactly once, with the previous key.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(['brand-1/cat-1/old-uuid.jpg']);

    // Order: read → upload → set-column → delete-old (delete strictly AFTER the
    // column points at the new object, so a failed delete is a harmless orphan).
    expect(callLog).toEqual([
      'read',
      'upload',
      'update',
      'remove:brand-1/cat-1/old-uuid.jpg',
    ]);
  });

  it('column-update failure → removes the just-uploaded ORPHAN and propagates the error', async () => {
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: 'brand-1/cat-1/old-uuid.jpg' }, error: null };
    });
    // The column UPDATE fails after the upload succeeded.
    updateResult = { error: { message: 'rls denied' } };

    const expectedPath = `brand-1/cat-1/${FIXED_UUID}.jpg`;

    await expect(
      uploadIngredientImage('cat-1', 'brand-1', { size: 5 } as unknown as Blob),
    ).rejects.toEqual({ message: 'rls denied' });

    // The orphan (the object we just uploaded) is removed — NOT the old object.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith([expectedPath]);

    // Order: read → upload → (failed) update → remove the NEW orphan. The old
    // object is left untouched because the row never moved off it.
    expect(callLog).toEqual([
      'read',
      'upload',
      'update',
      `remove:${expectedPath}`,
    ]);
  });

  it('throws (and does NOT touch the column) when the upload itself fails', async () => {
    uploadSpy.mockImplementation(async () => {
      callLog.push('upload');
      return { data: null, error: { message: 'upload boom' } };
    });

    await expect(
      uploadIngredientImage('cat-1', 'brand-1', { size: 5 } as unknown as Blob),
    ).rejects.toEqual({ message: 'upload boom' });

    // Upload failed before any column write or delete.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(callLog).toEqual(['read', 'upload']);
  });
});

describe('removeIngredientImage — spec 127', () => {
  it('NULLs image_path FIRST, then best-effort deletes the object', async () => {
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: 'brand-1/cat-1/live-uuid.jpg' }, error: null };
    });

    await removeIngredientImage('cat-1');

    expect(mockFrom).toHaveBeenCalledWith('catalog_ingredients');
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ image_path: null }),
    );
    expect(eqSpy).toHaveBeenCalledWith('id', 'cat-1');

    expect(mockStorageFrom).toHaveBeenCalledWith('ingredient-images');
    expect(removeSpy).toHaveBeenCalledWith(['brand-1/cat-1/live-uuid.jpg']);

    // Column-clear strictly BEFORE the object delete (UI is correct even if the
    // storage delete fails).
    expect(callLog).toEqual([
      'read',
      'update',
      'remove:brand-1/cat-1/live-uuid.jpg',
    ]);
  });

  it('clears the column and skips the delete when there was no object', async () => {
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: null }, error: null };
    });

    await removeIngredientImage('cat-1');

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ image_path: null }),
    );
    expect(removeSpy).not.toHaveBeenCalled();
    expect(callLog).toEqual(['read', 'update']);
  });

  it('propagates a column-clear failure and does NOT delete the object', async () => {
    maybeSingleSpy.mockImplementation(async () => {
      callLog.push('read');
      return { data: { image_path: 'brand-1/cat-1/live-uuid.jpg' }, error: null };
    });
    updateResult = { error: { message: 'clear failed' } };

    await expect(removeIngredientImage('cat-1')).rejects.toEqual({ message: 'clear failed' });

    // Column write failed → the object is left in place (harmless orphan).
    expect(removeSpy).not.toHaveBeenCalled();
    expect(callLog).toEqual(['read', 'update']);
  });
});
