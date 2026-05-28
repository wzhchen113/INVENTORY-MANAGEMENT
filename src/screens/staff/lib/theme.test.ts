// src/screens/staff/lib/theme.test.ts — pure color-resolution logic.
//
// Spec 070 §1 acceptance criterion: the light/dark selection logic gets
// a unit test asserting it returns the dark palette for 'dark' and the
// light palette otherwise. We test the PURE resolver (`resolveStaffColors`)
// — not the `useStaffColors()` hook — because the hook needs the RN
// renderer; the resolver is the logic the criterion actually cares about.
//
// Lives under `src/screens/staff/lib/` so it runs in the unit (node)
// project per jest.config.js (the `lib/**/*.test.ts` glob), not the
// jsdom component project.

import {
  resolveStaffColors,
  makeElevation,
  lightColors,
  darkColors,
} from '../theme';

describe('resolveStaffColors', () => {
  it("returns the dark palette for 'dark'", () => {
    expect(resolveStaffColors('dark')).toBe(darkColors);
  });

  it("returns the light palette for 'light'", () => {
    expect(resolveStaffColors('light')).toBe(lightColors);
  });

  it('falls back to the light palette for null (jest / first web paint)', () => {
    expect(resolveStaffColors(null)).toBe(lightColors);
  });

  it('falls back to the light palette for undefined', () => {
    expect(resolveStaffColors(undefined)).toBe(lightColors);
  });

  it('both palettes expose the identical key set (no token dropped)', () => {
    // Re-skin, not rename churn — dark must carry every light key so
    // Banner.TONE_STYLES, QueueIndicator.successBg, Button.primaryPressedLight,
    // etc. all resolve in both themes.
    expect(Object.keys(darkColors).sort()).toEqual(
      Object.keys(lightColors).sort(),
    );
  });
});

// ── makeElevation ────────────────────────────────────────────────────────────
// Spec 070 AC: platform-branched elevation token set — web emits boxShadow,
// native emits shadow*/elevation. The function is pure and platform-branched;
// we test the branch the test runner is actually in (native, since jest-expo
// defaults to a non-web Platform.OS).
//
// The tests intentionally do NOT assert exact numeric values (brittle, and
// spec reserves tuning authority to the developer). They assert shape:
//   - three levels present (card/raised/modal)
//   - dark and light return distinct objects (separate tuning, not the same ref)
//   - null/undefined fall back to the light set (same null-safety as resolveStaffColors)
//
// Platform.OS in jest-expo is 'ios' (non-web), so we exercise the native branch.
// A web-branch shape test would require mocking Platform — deferred; native is
// the primary kitchen device target and the branch logic is identical in
// structure to `resolveStaffColors` (dark flag, three levels).

describe('makeElevation', () => {
  const LEVELS = ['card', 'raised', 'modal'] as const;

  it('returns all three elevation levels for the light scheme', () => {
    const e = makeElevation('light');
    for (const level of LEVELS) {
      expect(e).toHaveProperty(level);
    }
  });

  it('returns all three elevation levels for the dark scheme', () => {
    const e = makeElevation('dark');
    for (const level of LEVELS) {
      expect(e).toHaveProperty(level);
    }
  });

  it('dark and light return different objects (separate per-theme tuning)', () => {
    expect(makeElevation('dark')).not.toBe(makeElevation('light'));
    expect(makeElevation('dark').card).not.toEqual(makeElevation('light').card);
  });

  it('null falls back to the light elevation set', () => {
    expect(makeElevation(null)).toEqual(makeElevation('light'));
  });

  it('undefined falls back to the light elevation set', () => {
    expect(makeElevation(undefined)).toEqual(makeElevation('light'));
  });

  it('native card level has the expected shadow shape keys', () => {
    // Confirm the native branch produces proper RN shadow props — guards
    // against accidentally returning a web boxShadow string on native.
    const card = makeElevation('light').card;
    // Native branch: must have shadowColor/Offset/Opacity/Radius + elevation.
    // Web branch: would have boxShadow (a string). Under jest-expo (non-web)
    // we always get native. If this fails after a Platform.OS mock changes,
    // the test environment changed — update accordingly.
    const keys = Object.keys(card);
    expect(keys).toContain('shadowColor');
    expect(keys).toContain('shadowOffset');
    expect(keys).toContain('shadowOpacity');
    expect(keys).toContain('shadowRadius');
    expect(keys).toContain('elevation');
  });
});
