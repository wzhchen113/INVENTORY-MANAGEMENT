/**
 * @jest-environment jsdom
 */
// src/screens/staff/lib/shareReorder.test.ts — Spec 089 (C) Option 2.
//
// This file lives under src/screens/staff/lib/ (the node-env unit project)
// but the web-download branch needs a DOM (document.createElement('a') +
// Blob + URL.createObjectURL). The per-file `@jest-environment jsdom`
// docblock above overrides the project's node testEnvironment for THIS file
// only — Jest honors the docblock regardless of the project's testMatch.
//
// The cross-platform export/share orchestrator. Mocks Platform.OS + the expo
// I/O modules → asserts:
//   - native path writes a temp file (File.create + write) + calls mockShareAsync
//   - web path builds a Blob + anchor download (CSV/text) or Print.mockPrintAsync (PDF)
//   - PDF uses expo-print on BOTH platforms (Option 2 — PDF everywhere)
//   - Sharing.mockIsAvailableAsync() === false → error toast, no crash/throw
//   - any error is caught → failure toast (never throws to the caller)

import Toast from 'react-native-toast-message';
import type { ReorderPayload } from '../../../types';

// All hoisted-factory-referenced vars are `mock`-prefixed per Jest's
// out-of-scope allowlist (a jest.mock factory may only close over globals +
// identifiers beginning with `mock`).

// ── Platform — mutable per test (default native) ──
let mockOS: 'ios' | 'android' | 'web' = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
}));

// ── expo-file-system (v19 object API) ──
const mockFileWrite = jest.fn();
const mockFileCreate = jest.fn();
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(_dir: unknown, name: string) {
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

// ── expo-print ──
const mockPrintAsync = jest.fn();
const mockPrintToFileAsync = jest.fn();
jest.mock('expo-print', () => ({
  printAsync: (...a: unknown[]) => mockPrintAsync(...a),
  printToFileAsync: (...a: unknown[]) => mockPrintToFileAsync(...a),
}));

import { shareReorderCsv, shareReorderPdf, shareReorderText } from './shareReorder';

const payload: ReorderPayload = {
  asOfDate: '2026-06-02',
  vendors: [
    {
      vendorId: 'v-1',
      vendorName: 'Acme',
      scheduleKnown: true,
      nextDeliveryDate: '2026-06-03',
      daysUntilNextDelivery: 1,
      onHandSource: 'eod',
      eodSubmittedAt: null,
      vendorTotalCost: 8,
      items: [
        {
          itemId: 'i-1',
          itemName: 'Oil',
          unit: 'gal',
          onHand: 0,
          pendingPoQty: 0,
          parLevel: 8,
          usageForecasted: 0,
          parReplacement: 8,
          suggestedQty: 8,
          costPerUnit: 1,
          estimatedCost: 8,
          caseQty: 1,
          suggestedCases: null,
          suggestedUnits: 8,
          flags: [],
        },
      ],
    },
  ],
  kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 8, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
  warnings: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'ios';
  mockIsAvailableAsync.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
  mockPrintAsync.mockResolvedValue(undefined);
  mockPrintToFileAsync.mockResolvedValue({ uri: 'file:///cache/reorder.pdf' });
});

describe('shareReorderCsv', () => {
  it('native → writes a .csv temp file and opens the share sheet', async () => {
    await shareReorderCsv(payload, 'Towson');
    expect(mockFileCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFileWrite).toHaveBeenCalledTimes(1);
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/IMR_Reorder_Towson_2026-06-02.csv',
      expect.objectContaining({ mimeType: 'text/csv' }),
    );
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'CSV exported' }),
    );
  });

  it('web → builds a Blob + anchor download (no share sheet)', async () => {
    mockOS = 'web';
    // jsdom provides document; stub URL.createObjectURL.
    const createObjectURL = jest.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = jest.fn();
    (window as any).URL.createObjectURL = createObjectURL;
    (window as any).URL.revokeObjectURL = revokeObjectURL;

    await shareReorderCsv(payload, 'Towson');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(mockFileWrite).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'CSV exported' }),
    );
  });

  it('native + Sharing unavailable → error toast, no throw, no mockShareAsync', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    await expect(shareReorderCsv(payload, 'Towson')).resolves.toBeUndefined();
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'CSV export failed' }),
    );
  });

  it('catches a write failure → failure toast, no throw', async () => {
    mockFileWrite.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(shareReorderCsv(payload, 'Towson')).resolves.toBeUndefined();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'CSV export failed', text2: 'disk full' }),
    );
  });
});

describe('shareReorderText', () => {
  it('native → writes a .txt temp file + shares as text/plain', async () => {
    await shareReorderText(payload, 'Towson');
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/IMR_Reorder_Towson_2026-06-02.txt',
      expect.objectContaining({ mimeType: 'text/plain' }),
    );
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'Text exported' }),
    );
  });
});

describe('shareReorderPdf (Option 2 — PDF everywhere via expo-print)', () => {
  it('native → mockPrintToFileAsync renders a PDF, then shares it', async () => {
    await shareReorderPdf(payload, 'Towson');
    expect(mockPrintToFileAsync).toHaveBeenCalledWith(expect.objectContaining({ html: expect.any(String) }));
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/reorder.pdf',
      expect.objectContaining({ mimeType: 'application/pdf' }),
    );
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'PDF exported' }),
    );
  });

  it('web → mockPrintAsync opens the browser print dialog (no file/share)', async () => {
    mockOS = 'web';
    await shareReorderPdf(payload, 'Towson');
    expect(mockPrintAsync).toHaveBeenCalledWith(expect.objectContaining({ html: expect.any(String) }));
    expect(mockPrintToFileAsync).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'PDF exported' }),
    );
  });

  it('native PDF + Sharing unavailable → error toast, no throw', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    await expect(shareReorderPdf(payload, 'Towson')).resolves.toBeUndefined();
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'PDF export failed' }),
    );
  });
});
