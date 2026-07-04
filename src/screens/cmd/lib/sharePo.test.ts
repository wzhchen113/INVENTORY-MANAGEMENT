// src/screens/cmd/lib/sharePo.test.ts — Spec 108 (D-2/D-3).
//
// The IMPURE cross-platform "Share PO" orchestrator. Mocks Platform.OS + RN
// `Share` + expo-sharing + `navigator` → asserts each branch:
//   - native (Platform.OS !== 'web') → Sharing.isAvailableAsync() gate, then
//     RN Share.share({ message }); a dismiss (Share.dismissedAction) → shared:false
//   - mobile web (navigator.share present) → navigator.share({ text }); shared:true
//   - desktop web (navigator.share absent) → navigator.clipboard.writeText +
//     previewText === text (the D-3 preview always renders); onCopyToast fires
//   - clipboard blocked / absent → onCopyBlocked, NOT an error toast, preview still returned
//   - AbortError (user dismissed) → swallowed as no-op: shared:false, NO failure toast
//   - any other error → failure toast, never throws (resolves shared:false)

import Toast from 'react-native-toast-message';

// All hoisted-factory-referenced vars are `mock`-prefixed per Jest's
// out-of-scope allowlist.

// ── Platform + RN Share — mutable per test (default native) ──
let mockOS: 'ios' | 'android' | 'web' = 'ios';
const mockShare = jest.fn();
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
  Share: {
    share: (...a: unknown[]) => mockShare(...a),
    dismissedAction: 'dismissedAction',
    sharedAction: 'sharedAction',
  },
}));

// ── expo-sharing ──
const mockIsAvailableAsync = jest.fn();
jest.mock('expo-sharing', () => ({
  isAvailableAsync: (...a: unknown[]) => mockIsAvailableAsync(...a),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

import { sharePurchaseOrder } from './sharePo';

const TEXT = 'I.M.R — Purchase order\nStore: Towson\n\n2 items';

function opts(over: Partial<Parameters<typeof sharePurchaseOrder>[1]> = {}) {
  return {
    dialogTitle: 'Share purchase order',
    onCopyToast: jest.fn(),
    onCopyBlocked: jest.fn(),
    ...over,
  };
}

// Save/restore the ambient navigator so web-branch mutations don't leak.
const originalNavigator = (globalThis as any).navigator;

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'ios';
  mockIsAvailableAsync.mockResolvedValue(true);
  mockShare.mockResolvedValue({ action: 'sharedAction' });
});

afterEach(() => {
  (globalThis as any).navigator = originalNavigator;
});

describe('sharePurchaseOrder — native (RN Share)', () => {
  it('gates on Sharing.isAvailableAsync then shares the message body', async () => {
    const o = opts();
    const res = await sharePurchaseOrder(TEXT, o);
    expect(mockIsAvailableAsync).toHaveBeenCalledTimes(1);
    expect(mockShare).toHaveBeenCalledWith({ message: TEXT }, { dialogTitle: 'Share purchase order' });
    expect(res).toEqual({ shared: true, previewText: null });
  });

  it('a dismissed share (Share.dismissedAction) → shared:false, no prompt', async () => {
    mockShare.mockResolvedValue({ action: 'dismissedAction' });
    const res = await sharePurchaseOrder(TEXT, opts());
    expect(res).toEqual({ shared: false, previewText: null });
    // Dismiss is a no-op, not a failure.
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('Sharing unavailable → failure toast, no throw, no Share.share', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);
    const res = await sharePurchaseOrder(TEXT, opts());
    expect(mockShare).not.toHaveBeenCalled();
    expect(res).toEqual({ shared: false, previewText: null });
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('sharePurchaseOrder — mobile web (navigator.share)', () => {
  it('calls navigator.share({ text }) → shared:true, no preview', async () => {
    mockOS = 'web';
    const share = jest.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { share };
    const res = await sharePurchaseOrder(TEXT, opts());
    expect(share).toHaveBeenCalledWith({ text: TEXT });
    expect(res).toEqual({ shared: true, previewText: null });
    // Native primitive must NOT be touched on web.
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('navigator.share AbortError (dismiss) → swallowed: shared:false, NO error toast', async () => {
    mockOS = 'web';
    const abort = Object.assign(new Error('user aborted'), { name: 'AbortError' });
    (globalThis as any).navigator = { share: jest.fn().mockRejectedValue(abort) };
    const res = await sharePurchaseOrder(TEXT, opts());
    expect(res).toEqual({ shared: false, previewText: null });
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('navigator.share non-abort error → failure toast, never throws', async () => {
    mockOS = 'web';
    (globalThis as any).navigator = { share: jest.fn().mockRejectedValue(new Error('boom')) };
    const res = await sharePurchaseOrder(TEXT, opts());
    expect(res).toEqual({ shared: false, previewText: null });
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('sharePurchaseOrder — desktop web (clipboard + preview)', () => {
  it('writes to clipboard, fires onCopyToast, returns previewText === text', async () => {
    mockOS = 'web';
    const writeText = jest.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { clipboard: { writeText } }; // no `share`
    const o = opts();
    const res = await sharePurchaseOrder(TEXT, o);
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(o.onCopyToast).toHaveBeenCalledTimes(1);
    expect(o.onCopyBlocked).not.toHaveBeenCalled();
    // Preview ALWAYS returned on the desktop-web branch (shared:true triggers
    // the draft prompt; previewText renders the pane).
    expect(res).toEqual({ shared: true, previewText: TEXT });
  });

  it('clipboard blocked (writeText rejects) → onCopyBlocked, NOT an error toast, preview still returned', async () => {
    mockOS = 'web';
    const writeText = jest.fn().mockRejectedValue(new Error('NotAllowedError'));
    (globalThis as any).navigator = { clipboard: { writeText } };
    const o = opts();
    const res = await sharePurchaseOrder(TEXT, o);
    expect(o.onCopyBlocked).toHaveBeenCalledTimes(1);
    expect(o.onCopyToast).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
    // Copy failed but the hand-off is still "completed" (the preview is on
    // screen for manual copy) → shared:true, previewText present.
    expect(res).toEqual({ shared: true, previewText: TEXT });
  });

  it('clipboard absent → onCopyBlocked, no silent success-toast, preview returned', async () => {
    mockOS = 'web';
    (globalThis as any).navigator = {}; // no `share`, no `clipboard`
    const o = opts();
    const res = await sharePurchaseOrder(TEXT, o);
    expect(o.onCopyBlocked).toHaveBeenCalledTimes(1);
    expect(o.onCopyToast).not.toHaveBeenCalled();
    expect(res).toEqual({ shared: true, previewText: TEXT });
  });
});
