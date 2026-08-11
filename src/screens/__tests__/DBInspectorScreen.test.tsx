// src/screens/__tests__/DBInspectorScreen.test.tsx — Spec 157, AC-17.
//
// Covers the DB Inspector auth banner (spec 157 §8/§9). The suite targets
// the EXPORTED pure classifier + copy map rather than a render — deliberate,
// per §11 R-4: asserting on a rendered tree would drag the supabase client,
// the Zustand store and react-navigation into jsdom for a four-branch pure
// function.
//
// Arms:
//   1. { is_privileged: true, is_admin: true }                      → privileged-jwt
//   2. { is_privileged: true, is_admin: false, is_super_admin: true} → privileged-super-admin
//      (and: no "NOT admin per the JWT", no "ALL your CRUD")
//   3. { is_privileged: false }                                     → not-privileged, AC-13 framing
//   4. new fields ABSENT                                            → unknown, no false green (AC-15)
//   5. null / undefined                                             → unknown (total function)
//   6. whole-map assertion: "ALL your CRUD" appears in no entry     → AC-12
//
// Component-project (jsdom) because this file imports a `.tsx`. See
// jest.config.js > projects > component.

// ── Mocks (must precede the import of the screen) ───────────────────
//
// The screen module is only imported for its pure exports, but importing
// it still evaluates its import graph. Two modules have real construction
// side effects at import time and are stubbed at the boundary:
//   - `../../lib/supabase` builds a live supabase-js client from env vars.
//   - `../../store/useStore` pulls the whole ~64 KB db.ts surface.

jest.mock('../../lib/supabase', () => ({
  __esModule: true,
  supabase: { rpc: jest.fn() },
}));

jest.mock('../../store/useStore', () => ({
  __esModule: true,
  useStore: () => ({ recipes: [], prepRecipes: [] }),
}));

import {
  AUTH_BANNER_COPY,
  classifyAuthBanner,
  type AuthBannerState,
  type ProbeAuth,
} from '../DBInspectorScreen';

/**
 * Build a probe `auth` object. `app_metadata` / `user_id` are always present
 * (the probe has emitted them since it was written); the flags under test are
 * spread on top so an arm can genuinely OMIT `is_privileged` / `is_super_admin`.
 */
function auth(flags: Partial<Pick<ProbeAuth, 'is_admin' | 'is_privileged' | 'is_super_admin'>>): ProbeAuth {
  return {
    is_admin: false,
    app_metadata: { role: 'user' },
    user_id: '11111111-1111-1111-1111-111111111111',
    ...flags,
  };
}

const ALL_STATES: AuthBannerState[] = [
  'privileged-jwt',
  'privileged-super-admin',
  'not-privileged',
  'unknown',
];

describe('classifyAuthBanner', () => {
  // Arm 1
  it('privileged + JWT admin → privileged-jwt (affirmative)', () => {
    const state = classifyAuthBanner(auth({ is_privileged: true, is_admin: true }));
    expect(state).toBe('privileged-jwt');
    expect(AUTH_BANNER_COPY[state].tone).toBe('ok');
  });

  // Arm 2 — the super_admin case the incident was about.
  it('privileged but not JWT admin → privileged-super-admin, reassuring not alarming', () => {
    const state = classifyAuthBanner(
      auth({ is_privileged: true, is_admin: false, is_super_admin: true }),
    );
    expect(state).toBe('privileged-super-admin');

    const copy = AUTH_BANNER_COPY[state];
    expect(copy.tone).toBe('ok');

    const text = `${copy.title} ${copy.detail ?? ''}`;
    expect(text).not.toContain('NOT admin per the JWT');
    expect(text).not.toContain('ALL your CRUD');
    // AC-12: it must explain WHY the token-only check reports false rather
    // than presenting that as a problem.
    expect(text).toContain('profiles.role');
    expect(text).toContain('super_admin');
  });

  // Arm 3 — AC-13.
  it('is_privileged === false → not-privileged, framed as an impossible state', () => {
    const state = classifyAuthBanner(auth({ is_privileged: false, is_admin: false }));
    expect(state).toBe('not-privileged');

    const copy = AUTH_BANNER_COPY[state];
    expect(copy.tone).toBe('warn');

    const text = `${copy.title} ${copy.detail ?? ''}`;
    expect(text).toContain('should not have returned');
    expect(text).toContain('admin_db_inspector_probe');
    expect(text).not.toContain('ALL your CRUD');
  });

  // Arm 4 — AC-15, the deploy-skew arm. This is the one that earns its keep:
  // `auth.is_privileged ? … : …` would misclassify this as not-privileged,
  // and falling back to `is_admin` would render a false green.
  it('new fields absent → unknown, not a false green and not an alarm', () => {
    const state = classifyAuthBanner(auth({ is_admin: true }));
    expect(state).toBe('unknown');

    const copy = AUTH_BANNER_COPY[state];
    expect(copy.tone).toBe('unknown');
    expect(copy.tone).not.toBe('ok');
    expect(copy.tone).not.toBe('warn');
  });

  // Arm 5 — total function.
  it('null / undefined → unknown', () => {
    expect(classifyAuthBanner(null)).toBe('unknown');
    expect(classifyAuthBanner(undefined)).toBe('unknown');
  });

  it('a non-boolean is_privileged is treated as absent, not as false', () => {
    // Defensive: a malformed payload must not trip the alarm branch.
    const malformed = { ...auth({ is_admin: true }), is_privileged: undefined };
    expect(classifyAuthBanner(malformed)).toBe('unknown');
  });
});

// Arm 6 — whole-map string constraints (AC-12). The cheap guard against a
// future edit reintroducing alarmist copy in a NEW branch.
describe('AUTH_BANNER_COPY string constraints', () => {
  it('covers every AuthBannerState with a title and a tone', () => {
    for (const state of ALL_STATES) {
      const copy = AUTH_BANNER_COPY[state];
      expect(copy).toBeDefined();
      expect(copy.title.length).toBeGreaterThan(0);
      expect(['ok', 'warn', 'unknown']).toContain(copy.tone);
    }
  });

  it('never claims "ALL your CRUD" and never says "NOT admin per the JWT"', () => {
    for (const state of ALL_STATES) {
      const copy = AUTH_BANNER_COPY[state];
      const text = `${copy.title} ${copy.detail ?? ''}`;
      expect(text).not.toContain('ALL your CRUD');
      expect(text).not.toContain('NOT admin per the JWT');
    }
  });

  it('only the super_admin branch may mention auth_is_admin, and only as an explanation', () => {
    for (const state of ALL_STATES) {
      const copy = AUTH_BANNER_COPY[state];
      const text = `${copy.title} ${copy.detail ?? ''}`;
      if (state === 'privileged-super-admin') continue;
      expect(text).not.toContain('auth_is_admin');
    }
  });

  it('both privileged states are affirmative (tone ok)', () => {
    expect(AUTH_BANNER_COPY['privileged-jwt'].tone).toBe('ok');
    expect(AUTH_BANNER_COPY['privileged-super-admin'].tone).toBe('ok');
  });
});
