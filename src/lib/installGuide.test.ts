// src/lib/installGuide.test.ts — Spec 153 (node project).
//
// Three things live here, all reachable without a DOM render:
//   • the PURE `installSteps()` model (AC-3), including the compile-time
//     `never` guard (pinned with @ts-expect-error — `npm run typecheck:test`
//     is the gate that actually runs it);
//   • the impure probes' truth tables — `detectInstallPlatform()` (AC-4's
//     default tab) and the re-exported `detectStandalone()` (AC-REG1's
//     extraction), driven by stubbed ambient globals;
//   • AC-9's `beforeinstallprompt` state machine, which is exposed as plain
//     module functions precisely so it can be tested here rather than behind a
//     component render.
//
// Global-stubbing shape follows src/screens/cmd/lib/sharePo.test.ts: mock
// `react-native` down to `Platform`, mutate `globalThis`, restore in afterEach
// so nothing leaks between suites.

let mockOS: 'ios' | 'android' | 'web' = 'web';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockOS;
    },
  },
}));

import {
  _resetInstallPrompt,
  detectInstallPlatform,
  detectStandalone,
  installSteps,
  isInstallPromptAvailable,
  promptInstall,
  startInstallPromptCapture,
  subscribeInstallPrompt,
  type InstallPlatform,
} from './installGuide';

// ── Ambient globals ─────────────────────────────────────────────────
const originalNavigator = (globalThis as any).navigator;
const originalWindow = (globalThis as any).window;

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadOs13:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function setNavigator(over: Record<string, unknown> = {}) {
  (globalThis as any).navigator = { userAgent: UA.desktop, platform: 'Win32', maxTouchPoints: 0, ...over };
}

/** Minimal window stub with a real listener registry, so the capture store's
 *  add/removeEventListener bookkeeping is genuinely exercised. */
function setWindow(over: Record<string, unknown> = {}) {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  (globalThis as any).window = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: (type: string, cb: (e: unknown) => void) => {
      const arr = listeners[type] ?? [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
    /** Test helper — fire an event at the registered listeners. */
    __dispatch: (type: string, e: unknown) => {
      for (const cb of [...(listeners[type] ?? [])]) cb(e);
    },
    __count: (type: string) => (listeners[type] ?? []).length,
    ...over,
  };
  return (globalThis as any).window;
}

beforeEach(() => {
  mockOS = 'web';
  setNavigator();
  setWindow();
});

afterEach(() => {
  _resetInstallPrompt();
  (globalThis as any).navigator = originalNavigator;
  (globalThis as any).window = originalWindow;
});

// ── AC-3: the pure model ────────────────────────────────────────────
describe('installSteps() — pure, total (AC-3)', () => {
  const CASES: Array<[InstallPlatform, number]> = [
    ['ios', 4],
    ['android', 3],
    ['desktop', 2],
  ];

  it.each(CASES)('%s → %i steps', (platform, count) => {
    expect(installSteps(platform)).toHaveLength(count);
  });

  it.each(CASES)('%s steps carry a 1..k sequence, unique prefixed keys, non-empty glyphs', (platform) => {
    const steps = installSteps(platform);
    expect(steps.map((s) => s.n)).toEqual(steps.map((_, i) => i + 1));
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
    for (const s of steps) {
      expect(s.key.startsWith(`${platform}.`)).toBe(true);
      expect(s.glyph.length).toBeGreaterThan(0);
    }
  });

  it('is pure — repeated calls return equal, independently-mutable arrays', () => {
    const a = installSteps('ios');
    const b = installSteps('ios');
    expect(a).toEqual(b);
    a.pop();
    expect(installSteps('ios')).toHaveLength(4);
  });

  it('rejects a non-member at compile time via the never guard', () => {
    // @ts-expect-error — 'windows' is not an InstallPlatform. This assertion is
    // enforced by `npm run typecheck:test`, not by the runtime expect below.
    expect(() => installSteps('windows')).not.toThrow();
  });

  it('glyphs live in the model, never in a catalog', () => {
    // A glyph that leaked into the catalog would be translated. Pinning the
    // literal marks here makes that leak a test failure rather than a silent
    // localization bug.
    expect(installSteps('ios')[1].glyph).toBe('↑');
    expect(installSteps('android')[0].glyph).toBe('⋮');
    expect(installSteps('desktop')[0].glyph).toBe('⊕');
  });
});

// ── AC-4: default tab resolution ────────────────────────────────────
describe('detectInstallPlatform() truth table', () => {
  it('iPhone UA → ios', () => {
    setNavigator({ userAgent: UA.iphone });
    expect(detectInstallPlatform()).toBe('ios');
  });

  it('iPadOS 13+ masquerade (MacIntel + touch) → ios', () => {
    setNavigator({ userAgent: UA.ipadOs13, platform: 'MacIntel', maxTouchPoints: 5 });
    expect(detectInstallPlatform()).toBe('ios');
  });

  it('Android UA → android', () => {
    setNavigator({ userAgent: UA.android });
    expect(detectInstallPlatform()).toBe('android');
  });

  it('desktop Chrome UA → desktop', () => {
    setNavigator({ userAgent: UA.desktop });
    expect(detectInstallPlatform()).toBe('desktop');
  });

  it("off-web (Platform.OS !== 'web') → desktop, even on an iPhone UA", () => {
    mockOS = 'ios';
    setNavigator({ userAgent: UA.iphone });
    expect(detectInstallPlatform()).toBe('desktop');
  });

  it('no navigator → desktop, no throw', () => {
    delete (globalThis as any).navigator;
    expect(detectInstallPlatform()).toBe('desktop');
  });
});

// ── AC-REG1: the extracted standalone probe, via the re-export ──────
describe('detectStandalone() truth table (imported through installGuide)', () => {
  it('navigator.standalone === true → true', () => {
    setNavigator({ standalone: true });
    expect(detectStandalone()).toBe(true);
  });

  it("matchMedia('(display-mode: standalone)').matches → true", () => {
    setWindow({ matchMedia: () => ({ matches: true }) });
    expect(detectStandalone()).toBe(true);
  });

  it('neither signal → false', () => {
    setWindow({ matchMedia: () => ({ matches: false }) });
    expect(detectStandalone()).toBe(false);
  });

  it('matchMedia absent → false, no throw', () => {
    setWindow();
    expect(detectStandalone()).toBe(false);
  });

  it('no window → false', () => {
    delete (globalThis as any).window;
    expect(detectStandalone()).toBe(false);
  });

  it('off-web → false even when the display-mode query would match', () => {
    mockOS = 'android';
    setWindow({ matchMedia: () => ({ matches: true }) });
    expect(detectStandalone()).toBe(false);
  });
});

// ── AC-9: the beforeinstallprompt state machine ─────────────────────
describe('beforeinstallprompt capture store (AC-9)', () => {
  function makePromptEvent() {
    return {
      preventDefault: jest.fn(),
      prompt: jest.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    };
  }

  it('no captured event → unavailable, and promptInstall() resolves without throwing', async () => {
    startInstallPromptCapture();
    expect(isInstallPromptAvailable()).toBe(false);
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('a dispatched event is preventDefault()ed, becomes available, and notifies subscribers', () => {
    startInstallPromptCapture();
    const seen = jest.fn();
    subscribeInstallPrompt(seen);

    const e = makePromptEvent();
    (globalThis as any).window.__dispatch('beforeinstallprompt', e);

    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(isInstallPromptAvailable()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('promptInstall() calls the deferred prompt() exactly once and is genuinely one-shot', async () => {
    startInstallPromptCapture();
    const e = makePromptEvent();
    (globalThis as any).window.__dispatch('beforeinstallprompt', e);

    await expect(promptInstall()).resolves.toBe('accepted');
    expect(e.prompt).toHaveBeenCalledTimes(1);
    // Cleared before awaiting userChoice — the button disappears on tap.
    expect(isInstallPromptAvailable()).toBe(false);

    // A second prompt() on the same event would throw InvalidStateError.
    await expect(promptInstall()).resolves.toBe('unavailable');
    expect(e.prompt).toHaveBeenCalledTimes(1);
  });

  it('a dismissed choice resolves dismissed', async () => {
    startInstallPromptCapture();
    const e = { ...makePromptEvent(), userChoice: Promise.resolve({ outcome: 'dismissed' as const }) };
    (globalThis as any).window.__dispatch('beforeinstallprompt', e);
    await expect(promptInstall()).resolves.toBe('dismissed');
  });

  it('a throwing prompt() never escapes as a rejection', async () => {
    startInstallPromptCapture();
    const e = makePromptEvent();
    e.prompt.mockRejectedValue(new Error('InvalidStateError'));
    (globalThis as any).window.__dispatch('beforeinstallprompt', e);
    await expect(promptInstall()).resolves.toBe('dismissed');
  });

  it('appinstalled clears availability and notifies', () => {
    startInstallPromptCapture();
    (globalThis as any).window.__dispatch('beforeinstallprompt', makePromptEvent());
    const seen = jest.fn();
    subscribeInstallPrompt(seen);

    (globalThis as any).window.__dispatch('appinstalled', {});

    expect(isInstallPromptAvailable()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: two starts register ONE set of listeners, and the teardown removes them', () => {
    const stopA = startInstallPromptCapture();
    const stopB = startInstallPromptCapture();
    const w = (globalThis as any).window;

    expect(w.__count('beforeinstallprompt')).toBe(1);
    expect(w.__count('appinstalled')).toBe(1);
    expect(stopB).toBe(stopA);

    stopA();
    expect(w.__count('beforeinstallprompt')).toBe(0);
    expect(w.__count('appinstalled')).toBe(0);

    // After teardown the module accepts a fresh installation.
    startInstallPromptCapture();
    expect(w.__count('beforeinstallprompt')).toBe(1);
  });

  it('unsubscribing stops notifications', () => {
    startInstallPromptCapture();
    const seen = jest.fn();
    const off = subscribeInstallPrompt(seen);
    off();
    (globalThis as any).window.__dispatch('beforeinstallprompt', makePromptEvent());
    expect(seen).not.toHaveBeenCalled();
  });

  it('off-web startInstallPromptCapture() is a no-op that returns a safe teardown', () => {
    mockOS = 'ios';
    const stop = startInstallPromptCapture();
    expect((globalThis as any).window.__count('beforeinstallprompt')).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
