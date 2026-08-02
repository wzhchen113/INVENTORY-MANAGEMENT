// src/utils/openExternalUrl.test.ts — spec 149 review round.
//
// Pins the shared external-link opener that both `useStore.openExternalOrderUrl`
// (webstaurant / instacart) and `PhoneApproveOrder.openInNewContext` (RE-OPEN
// LINK) now go through:
//
//   • security-auditor Medium 1 — the http(s) scheme ALLOWLIST. Both URL
//     sources (`vendors.order_page_url`, `order_approvals.external_ref`) are
//     operator-writable under RLS, so a planted `javascript:` value must be
//     REFUSED, never handed to window.open / Linking.openURL.
//   • code-reviewer Should-fix — a native `Linking.openURL` REJECTION is
//     reported (it previously became a silent unhandled rejection in the phone
//     screen), and the web branch keeps `noopener,noreferrer`.
//
// react-native is mocked wholesale (same idiom as
// src/screens/cmd/lib/sharePo.test.ts) so Platform.OS is switchable per test
// and RN's lazy TurboModule getters are never evaluated in the node-env project.

let mockOS: 'ios' | 'android' | 'web' = 'ios';
const mockOpenURL = jest.fn((..._a: unknown[]) => Promise.resolve(true));

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
  Linking: {
    openURL: (...a: unknown[]) => mockOpenURL(...a),
  },
}));

import { isSafeExternalUrl, openExternalUrl } from './openExternalUrl';

const onError = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockOS = 'ios';
  mockOpenURL.mockImplementation(() => Promise.resolve(true));
  (global as any).window = { open: jest.fn() };
});

afterEach(() => {
  delete (global as any).window;
});

describe('isSafeExternalUrl — the scheme allowlist', () => {
  it.each([
    'https://www.samsclub.com/orders',
    'http://vendor.example/rapid-reorder',
    'HTTPS://SHOUTY.EXAMPLE/x',
    '  https://padded.example/x  ',
    'https://instacart.example/store/checkout?a=1&b=2#frag',
  ])('accepts %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  it.each([
    // The finding's headline case.
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///etc/passwd',
    'tel:+15551234567',
    'intent://scan/#Intent;scheme=zxing;end',
    'myapp://transfer?to=attacker',
    // Not absolute / not a URL at all.
    '//protocol-relative.example/x',
    'example.com',
    '/relative/path',
    'https://',
    '',
    '   ',
  ])('rejects %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
    expect(isSafeExternalUrl({ toString: () => 'https://x.example' })).toBe(false);
  });
});

describe('openExternalUrl — refusals', () => {
  it('a javascript: URL is never opened on native and is reported', () => {
    const ok = openExternalUrl('javascript:alert(1)', 'Open order page', onError);
    expect(ok).toBe(false);
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('Open order page');
    expect(String((onError.mock.calls[0][1] as Error).message)).toMatch(/http\(s\)/);
  });

  it('a javascript: URL is never opened on web either', () => {
    mockOS = 'web';
    const ok = openExternalUrl('javascript:alert(1)', 'Open order page', onError);
    expect(ok).toBe(false);
    expect((global as any).window.open).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('an empty / null stored external_ref is refused, not opened', () => {
    expect(openExternalUrl('', 'Open order page', onError)).toBe(false);
    expect(openExternalUrl(null, 'Open order page', onError)).toBe(false);
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('openExternalUrl — the happy paths', () => {
  it('web opens a new tab with noopener,noreferrer', () => {
    mockOS = 'web';
    const ok = openExternalUrl('https://www.samsclub.com/orders', 'Open order page', onError);
    expect(ok).toBe(true);
    expect((global as any).window.open).toHaveBeenCalledWith(
      'https://www.samsclub.com/orders',
      '_blank',
      'noopener,noreferrer',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('web with no window (SSR/export) is a no-op, not a throw', () => {
    mockOS = 'web';
    delete (global as any).window;
    expect(() => openExternalUrl('https://x.example/a', 'Open order page', onError)).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('native hands the trimmed URL to Linking.openURL', () => {
    const ok = openExternalUrl('  https://x.example/a  ', 'Open order page', onError);
    expect(ok).toBe(true);
    expect(mockOpenURL).toHaveBeenCalledWith('https://x.example/a');
    expect(onError).not.toHaveBeenCalled();
  });

  it('a native openURL REJECTION is reported through onError (no unhandled rejection)', async () => {
    const boom = new Error('No app registered to handle this URL');
    mockOpenURL.mockImplementation(() => Promise.reject(boom));
    const ok = openExternalUrl('https://x.example/a', 'Open order page', onError);
    // Dispatched — the failure is asynchronous.
    expect(ok).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('Open order page', boom);
  });
});
