// src/utils/downloadCSV.native.spec181.test.ts — Spec 181 (C1 / AC-17).
//
// The native branch of `downloadCSV`: write the BOM-prefixed CSV to the cache
// dir and open the OS share sheet (mirrors staff shareReorder `nativeShare`).
// Unavailable sharing → rejects BEFORE any file is created. The web path is
// pinned by countExport.test.ts (BOM case, Platform.OS = 'web').

import { Platform } from 'react-native';

// ── expo-file-system (v19 object API) ──
const mockFileWrite = jest.fn();
const mockFileCreate = jest.fn();
const mockFileCtor = jest.fn();
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(dir: unknown, name: string) {
      mockFileCtor(dir, name);
      this.uri = `file:///cache/${name}`;
    }
    create = mockFileCreate;
    write = mockFileWrite;
  }
  return {
    File: MockFile,
    Paths: { cache: { uri: 'file:///cache/' } },
  };
});

// ── expo-sharing ──
const mockIsAvailableAsync = jest.fn();
const mockShareAsync = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: (...a: unknown[]) => mockIsAvailableAsync(...a),
  shareAsync: (...a: unknown[]) => mockShareAsync(...a),
}));

import { downloadCSV } from './index';

const ORIGINAL_OS = Platform.OS;
function setPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('ios');
  mockIsAvailableAsync.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  setPlatform(ORIGINAL_OS);
});

describe('downloadCSV — native share branch (spec 181)', () => {
  it('writes the BOM-prefixed CSV to the cache dir and opens the share sheet as text/csv', async () => {
    // This suite runs in the node-env unit project, which has no `document`.
    // Install a stub so a regression into the web anchor-click path would be
    // observed as a createElement call rather than a ReferenceError.
    const g = globalThis as { document?: unknown };
    const hadDocument = 'document' in g;
    const priorDocument = g.document;
    const createElement = jest.fn(() => ({ click: jest.fn() }));
    g.document = { createElement };
    const createObjectURL = jest.spyOn(URL, 'createObjectURL');
    try {
      await expect(
        downloadCSV('IMR_Inventory_Count_Frederick_2026-10-26_en.csv', 'a,b\n1,2'),
      ).resolves.toBeUndefined();

      expect(mockFileCtor).toHaveBeenCalledWith(
        { uri: 'file:///cache/' },
        'IMR_Inventory_Count_Frederick_2026-10-26_en.csv',
      );
      expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
      expect(mockFileWrite).toHaveBeenCalledTimes(1);
      const content = mockFileWrite.mock.calls[0][0] as string;
      expect(content.charCodeAt(0)).toBe(0xfeff);
      expect(content).toBe('\uFEFFa,b\n1,2');

      expect(mockShareAsync).toHaveBeenCalledWith(
        'file:///cache/IMR_Inventory_Count_Frederick_2026-10-26_en.csv',
        expect.objectContaining({
          mimeType: 'text/csv',
          UTI: 'public.comma-separated-values-text',
        }),
      );
      // The DOM path is never touched on native.
      expect(createElement).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
      if (hadDocument) g.document = priorDocument;
      else delete g.document;
    }
  });

  it('availability is checked BEFORE the file is written', async () => {
    const order: string[] = [];
    mockIsAvailableAsync.mockImplementation(async () => {
      order.push('available');
      return true;
    });
    mockFileCreate.mockImplementation(() => order.push('create'));
    await downloadCSV('x.csv', 'a');
    expect(order).toEqual(['available', 'create']);
  });

  it('sharing unavailable → rejects and creates no file', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    await expect(downloadCSV('x.csv', 'a,b')).rejects.toThrow('Sharing is not available on this device');
    expect(mockFileCtor).not.toHaveBeenCalled();
    expect(mockFileCreate).not.toHaveBeenCalled();
    expect(mockFileWrite).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('a shareAsync failure rejects (the caller owns the toast)', async () => {
    mockShareAsync.mockRejectedValue(new Error('share failed'));
    await expect(downloadCSV('x.csv', 'a')).rejects.toThrow('share failed');
  });

  it('a directory separator in the filename never becomes a path segment', async () => {
    await downloadCSV('a/b\\c.csv', 'a');
    expect(mockFileCtor).toHaveBeenCalledWith({ uri: 'file:///cache/' }, 'a_b_c.csv');
  });

  it('android takes the same native branch', async () => {
    setPlatform('android');
    await downloadCSV('x.csv', 'a');
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
  });
});
