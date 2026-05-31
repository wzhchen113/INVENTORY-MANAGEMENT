// playwright.config.ts — Spec 078, Track 4 (browser E2E, web-only).
//
// Lives at repo root (Playwright's default discovery point); `testDir`
// points at the top-level `e2e/` tree. The architect's design §2 pins
// every value below — see specs/078-e2e-playwright-framework.md.
//
// Prerequisites (AC-H3): `npm run dev:db` must already be running. This
// config boots ONLY the Expo web dev server (via `webServer`); it does
// NOT boot the Supabase stack. CI boots the stack itself in
// .github/workflows/e2e.yml.
//
// Env-sourcing (OQ-1): the web server's Supabase URL + anon key, and the
// global-setup fixture's service-role key, are read from env with the
// well-known LOCAL stack values as the fallback. These are the local
// demo keys baked into every `supabase start` — they are NOT prod
// secrets. Keeping them env-sourced means pointing the suite at a remote
// test branch later is a CI-secret swap, not a code change.

import { defineConfig, devices } from '@playwright/test';

// Well-known local Supabase stack values (stable across `supabase start`).
// Overridable via env so the suite can target a different stack without a
// code edit (OQ-1 migration path).
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export default defineConfig({
  testDir: './e2e',
  // Serial: a single local Supabase stack is shared, and the invite/EOD
  // specs mutate it. Serial removes an entire class of cross-spec flake
  // for v1. Parallelism can return later behind per-worker uniquification.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 1 worker in CI — one shared local stack. Local defaults to Playwright's
  // worker heuristic but `fullyParallel: false` still serializes files.
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000, // per-test
  globalTimeout: 15 * 60_000, // whole-run guard (mirrors test.yml job timeouts)
  expect: { timeout: 10_000 },
  // OQ-4 runtime fixture: a service-role insert of order_schedule rows for
  // all 7 weekdays on Towson with two vendors, so the EOD specs always have
  // vendor chips + items regardless of which weekday CI runs on. Runs once
  // per run, before any project, with no browser — the natural home for a
  // service-role DB insert.
  globalSetup: './e2e/global-setup.ts',
  // Removes the order_schedule fixture global-setup committed, so a local
  // `npm run e2e` leaves Towson's schedule as the seed had it (empty) and
  // doesn't collide with the spec-075 pgTAP arm C that also uses Towson.
  // CI doesn't strictly need it (fresh db reset per run) but it's harmless.
  globalTeardown: './e2e/global-teardown.ts',
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']] // html artifact + GH annotations
    : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    trace: 'on-first-retry',
    // RN `testID` → DOM `data-testid` on web (verified via react-native-web
    // createDOMProps). `getByTestId('<id>')` therefore addresses the §7
    // selectors directly. (Lives under `use` per the Playwright API — the
    // design §2 pseudocode listed it at the top level; the pinned VALUE
    // 'data-testid' is unchanged.)
    testIdAttribute: 'data-testid',
    // colorScheme defaults to 'light'; the dark smoke overrides per-test.
  },
  webServer: {
    command: 'npx expo start --web --port 8081',
    url: 'http://localhost:8081',
    // Local reuses a running 8081 (dev convenience); CI always boots fresh.
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // cold Metro bundle budget (OQ-2 accepted cost)
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // The web server (Expo/Metro) reads these EXPO_PUBLIC_* vars the same
      // way `src/lib/supabase.ts` does. Pass through the process env if set
      // (e.g. a remote branch in CI), else fall back to the local stack.
      EXPO_PUBLIC_SUPABASE_URL:
        process.env.EXPO_PUBLIC_SUPABASE_URL ?? LOCAL_SUPABASE_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY:
        process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? LOCAL_ANON_KEY,
    },
  },
  projects: [
    // Logs in each demo role via the real UI and writes per-role
    // storageState. NEVER submits EOD, so the saved storageState carries
    // auth only — never the offline queue key (OQ-3c poison-queue guard).
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
