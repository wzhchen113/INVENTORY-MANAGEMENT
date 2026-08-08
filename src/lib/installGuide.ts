// src/lib/installGuide.ts — Spec 153. Add-to-Home-Screen (PWA install) model.
//
// Mirrors the split that already works in `notificationState.ts`:
//
//   • A PURE, catalog-agnostic model (`installSteps`) that jest exercises
//     without a browser. It returns catalog-RELATIVE key suffixes so the admin
//     and staff catalogs stay two independent trees (spec 063 contract) over
//     one model.
//
//   • IMPURE one-line probes (`detectInstallPlatform`, the re-exported
//     `detectStandalone`) that read live browser globals. Not unit-tested in
//     isolation the way the pure half is; their truth tables are pinned by
//     stubbing the globals.
//
//   • A module-level `beforeinstallprompt` capture store in the
//     `sessionWatch.ts` shape (plain functions + a test-only reset), so the
//     whole state machine is node-testable rather than hidden behind a
//     component render. `useInstallPrompt()` is a thin `useSyncExternalStore`
//     wrapper over it.
//
// Deliberate constraints (spec 153 backend design §2):
//   - imports NOTHING from a `.tsx` file and nothing from `react-native`
//     beyond `Platform`, which is what keeps its suite in the fast node
//     project;
//   - imports NO store (`useStore` / `useStaffStore`), so the staff subtree
//     may consume it without breaking spec 063 slice isolation;
//   - registers NO listener at module top level — installation is an explicit
//     call from App.tsx's web branch.

import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { detectIos } from './notificationState';

// ── Pure model (the jest target) ─────────────────────────────────────
export type InstallPlatform = 'ios' | 'android' | 'desktop';

/** One tutorial step. `key` is a catalog-RELATIVE suffix; each surface
 *  prefixes it with its own catalog root. */
export interface InstallStep {
  /** 1-based; stable across locales. */
  n: number;
  /** The OS's literal control mark. NOT translatable — glyphs live in the
   *  model, never in a catalog (spec 153 §2.6). */
  glyph: string;
  /** e.g. 'ios.step1' → `chrome.installGuide.steps.ios.step1`. */
  key: string;
}

/** Pure, total, exhaustive switch with a `never` guard (AC-3). */
export function installSteps(p: InstallPlatform): InstallStep[] {
  switch (p) {
    case 'ios':
      return [
        { n: 1, glyph: '◉', key: 'ios.step1' },
        { n: 2, glyph: '↑', key: 'ios.step2' },
        { n: 3, glyph: '⊞', key: 'ios.step3' },
        { n: 4, glyph: '✓', key: 'ios.step4' },
      ];
    case 'android':
      return [
        { n: 1, glyph: '⋮', key: 'android.step1' },
        { n: 2, glyph: '⊞', key: 'android.step2' },
        { n: 3, glyph: '✓', key: 'android.step3' },
      ];
    case 'desktop':
      return [
        { n: 1, glyph: '⊕', key: 'desktop.step1' },
        { n: 2, glyph: '✓', key: 'desktop.step2' },
      ];
    default: {
      // Exhaustiveness guard — a new InstallPlatform member surfaces here at
      // compile time (AC-3). `npm run typecheck:test` is the gate that runs it.
      const _exhaustive: never = p;
      return _exhaustive;
    }
  }
}

// ── Impure probes (NOT unit-tested in isolation) ─────────────────────

/**
 * Which platform's steps to show by default. Order is load-bearing: iPadOS 13+
 * masquerades as desktop Safari, and `detectIos()` already owns that
 * heuristic — do not fork it here.
 *
 * Off-web / no `navigator` → `'desktop'`, a harmless default: both render
 * gates hide the feature off-web anyway (AC-8).
 */
export function detectInstallPlatform(): InstallPlatform {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return 'desktop';
  if (detectIos()) return 'ios';
  if (/Android/i.test(navigator.userAgent || '')) return 'android';
  return 'desktop';
}

// Canonical definition lives in notificationState.ts (spec 153 §1) — defining
// it here would cycle, because this module imports `detectIos` from there.
// Re-exported so views + this module's own suite import it from the module the
// spec names.
export { detectStandalone } from './notificationState';

// ── beforeinstallprompt capture — module store, sessionWatch shape ────
//
// Chrome fires `beforeinstallprompt` once, on its own schedule, and the event
// must be `preventDefault()`ed and stashed to be usable later. It can fire
// before any component mounts, so the capture cannot live in component state.

/** The structural slice of `BeforeInstallPromptEvent` we consume. The DOM lib
 *  ships no type for it (it is a Chromium-only draft interface). */
interface BeforeInstallPromptEventLike {
  preventDefault?: () => void;
  prompt: () => Promise<unknown>;
  userChoice?: Promise<{ outcome?: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEventLike | null = null;
let subscribers: Array<() => void> = [];
/** Non-null iff the window listeners are currently installed. */
let removeListeners: (() => void) | null = null;

function notify(): void {
  // Copy first — a subscriber may unsubscribe from inside its own callback.
  for (const cb of [...subscribers]) {
    try {
      cb();
    } catch {
      /* a broken subscriber must not break the others */
    }
  }
}

/**
 * Install the window listeners. Idempotent — a second call while they are
 * already installed registers nothing new and returns the same teardown.
 * Called ONCE from App.tsx's web branch. No-op off-web.
 */
export function startInstallPromptCapture(): () => void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};
  if (removeListeners) return removeListeners;

  const onBeforeInstallPrompt = (e: Event) => {
    // Suppress Chrome's own mini-infobar so the tutorial's button is the only
    // install affordance (no auto-nagging — spec 153 non-goals).
    (e as unknown as BeforeInstallPromptEventLike).preventDefault?.();
    deferredPrompt = e as unknown as BeforeInstallPromptEventLike;
    notify();
  };
  const onAppInstalled = () => {
    deferredPrompt = null;
    notify();
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);

  const teardown = () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
    if (removeListeners === teardown) removeListeners = null;
  };
  removeListeners = teardown;
  return teardown;
}

/** Current snapshot — a boolean PRIMITIVE, so it is a safe `getSnapshot()`
 *  (a fresh object would loop React 19's snapshot-identity check). */
export function isInstallPromptAvailable(): boolean {
  return deferredPrompt !== null;
}

/** Subscribe to availability changes. Returns an unsubscribe. */
export function subscribeInstallPrompt(cb: () => void): () => void {
  subscribers.push(cb);
  return () => {
    const i = subscribers.indexOf(cb);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

/**
 * One-shot. The captured event can be `prompt()`ed exactly once — a second
 * call throws `InvalidStateError` — so the ref is cleared and subscribers are
 * notified BEFORE awaiting `userChoice`, which is also what makes the button
 * disappear on tap rather than on resolve. Never throws.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferredPrompt;
  if (!e) return 'unavailable';
  deferredPrompt = null;
  notify();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    // A rejected prompt is a non-install, not a crash.
    return 'dismissed';
  }
}

/** Test-only: drop the captured event, every subscriber, and any installed
 *  window listeners, so each suite starts from a clean module state. */
export function _resetInstallPrompt(): void {
  deferredPrompt = null;
  subscribers = [];
  if (removeListeners) removeListeners();
  removeListeners = null;
}

// ── Thin React wrapper ───────────────────────────────────────────────
/**
 * `{ available, promptInstall }` for the two views. `available` is the module
 * store's boolean snapshot; `promptInstall` is a fire-and-forget wrapper that
 * swallows rejection (the store's `promptInstall` already never throws).
 */
export function useInstallPrompt(): {
  available: boolean;
  promptInstall: () => void;
} {
  const available = useSyncExternalStore(
    subscribeInstallPrompt,
    isInstallPromptAvailable,
    // Server snapshot — same primitive getter; there is no captured event
    // during SSR/hydration, so this is `false` by construction.
    isInstallPromptAvailable,
  );
  const fire = useCallback(() => {
    void promptInstall();
  }, []);
  return { available, promptInstall: fire };
}
