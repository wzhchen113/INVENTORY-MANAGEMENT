import { defineConfig } from 'vitest/config';

// Spec 132 (D-6) — the extension's OWN unit runner, OUTSIDE the Expo jest graph.
// Covers the PURE, adapter-agnostic logic (AC-12): payload → planned actions,
// the origin match, the dry-run gate, the report shape, URL scheme validation.
// The site-UI adapters (selectors / add-to-cart) are NOT unit-tested against
// live sites — manual owner verification (AC-11).
export default defineConfig({
  // Tests import the SHARED builder from ../src/utils (repo root). esbuild's
  // per-file tsconfig discovery would find the ROOT tsconfig.json there, which
  // `extends expo/tsconfig.base` — resolvable locally (expo in the root
  // node_modules) but NOT in Track 1c's isolated extension/ install
  // (TSConfckParseError in CI). Pin an inline tsconfig so no discovery happens.
  esbuild: {
    tsconfigRaw: '{"compilerOptions":{"target":"es2022","verbatimModuleSyntax":false}}',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
