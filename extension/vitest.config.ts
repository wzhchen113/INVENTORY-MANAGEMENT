import { defineConfig } from 'vitest/config';

// Spec 132 (D-6) — the extension's OWN unit runner, OUTSIDE the Expo jest graph.
// Covers the PURE, adapter-agnostic logic (AC-12): payload → planned actions,
// the origin match, the dry-run gate, the report shape, URL scheme validation.
// The site-UI adapters (selectors / add-to-cart) are NOT unit-tested against
// live sites — manual owner verification (AC-11).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
