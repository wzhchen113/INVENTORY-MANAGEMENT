// e2e/dark-mode.spec.ts — Spec 078 cross-cutting: dark-mode smoke (AC-DARK1).
//
// One smoke that proves the app renders in dark mode. Cheap insurance —
// specs 070/072 shipped dark mode.
//
// IMPLEMENTATION NOTE (why both a colorScheme emulation AND a seeded pref):
// the admin Cmd theme is driven by useStore.darkMode, hydrated at boot from
// the localStorage key `darkMode` (String(boolean)) + profiles.dark_mode —
// it does NOT read prefers-color-scheme / useColorScheme. So Playwright's
// `colorScheme: 'dark'` emulation alone would not flip the admin app. We
// therefore ALSO seed localStorage `darkMode='true'` via addInitScript
// before the app boots — that is the signal the boot-time hydrator reads.
// The colorScheme override is kept because AC-DARK1 names it explicitly and
// it is the correct emulation for any future surface that does honor the
// media query (e.g. the staff app or a CSS-driven element).
//
// Assertion: the cmd-shell-root wrapper paints backgroundColor: C.bg, which
// is near-black in DarkCmd (#08090C) vs near-white in LightCmd (#FAFAF8).
// We assert the COMPUTED background is a dark color (low RGB sum) rather
// than hardcoding an exact hex — robust against a future palette tweak.
//
// Selector contract (frozen §7): signin-* (login), cmd-shell-root (shell).

import { test, expect } from '@playwright/test';
import { DEMO } from './fixtures/constants';

// Emulate an OS dark preference (AC-DARK1) and start signed-out so the
// addInitScript-seeded pref is read on the very first app boot.
test.use({
  colorScheme: 'dark',
  storageState: { cookies: [], origins: [] },
});

test('AC-DARK1: the Cmd shell renders in dark mode', async ({ page, context }) => {
  // Seed the dark-mode pref BEFORE the app boots so the boot-time hydrator
  // restores it on first paint.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('darkMode', 'true');
    } catch {
      /* localStorage may be unavailable pre-navigation; ignore */
    }
  });

  await page.goto('/');
  await page.getByTestId('signin-email').fill(DEMO.adminEmail);
  await page.getByTestId('signin-password').fill(DEMO.password);
  await page.getByTestId('signin-submit').click();

  const shell = page.getByTestId('cmd-shell-root').first();
  await expect(shell).toBeVisible();

  // Read the computed background-color and assert it is a DARK color.
  const bg = await shell.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  expect(match, `expected an rgb(a) background, got "${bg}"`).not.toBeNull();
  const [r, g, b] = match!.slice(1).map(Number);
  // DarkCmd.bg (#08090C) sums to ~29; LightCmd.bg (#FAFAF8) sums to ~748.
  // A threshold of 150 cleanly separates the two without pinning an exact
  // hex.
  expect(r + g + b).toBeLessThan(150);
});
