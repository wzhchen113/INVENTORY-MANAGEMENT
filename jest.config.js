// jest.config.js — Spec 022 Track 1 (jest-expo).
//
// Two projects: a fast `node`-env unit project for pure-TS code under
// src/utils, src/lib, src/store, src/hooks; and a `jsdom`-env component
// project for React Native components under src/components and src/screens.
//
// transformIgnorePatterns: jest does NOT transform node_modules by default,
// so any RN / Expo dep that ships untranspiled ESM has to be added to the
// allow-list below. Symptom of a missing entry: "Unexpected token 'export'"
// or "Cannot use import statement outside a module" from inside an Expo
// or react-native-* package. See tests/README.md > Troubleshooting.

const RN_TRANSPILE_DEPS = [
  'react-native',
  '@react-native',
  '@react-native-async-storage',
  '@react-navigation',
  'expo',
  'expo-modules-core',
  'expo-font',
  'expo-asset',
  'expo-constants',
  'expo-file-system',
  'expo-sharing',
  'expo-sqlite',
  'expo-notifications',
  '@expo',
  '@expo-google-fonts',
  'react-native-svg',
  'react-native-toast-message',
  'react-native-gesture-handler',
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-screens',
  'react-native-safe-area-context',
  'react-native-web',
  'react-native-chart-kit',
  '@dnd-kit',
];

const transformIgnorePatterns = [
  `node_modules/(?!(?:${RN_TRANSPILE_DEPS.join('|')})/)`,
];

const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
};

const baseProject = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  moduleNameMapper,
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],
  // Spec 033 — `transform` points at a thin wrapper around babel-jest that
  // rewrites `import('literal')` → `Promise.resolve(require('literal'))`
  // so `jest.mock(...)` intercepts dynamic imports inside the module under
  // test (notably `useStore.deleteProfile`'s dynamic `import('../lib/auth')`).
  // The wrapper delegates the actual transform to babel-jest (which
  // jest-expo's babel-preset-expo configures) — so there is no double-
  // transform; this is the same babel-preset-expo path with one post-
  // processing pass. See `tests/babel-jest-dynamic-import.js` for the
  // rationale and the SAFETY NOTE.
  transform: {
    '^.+\\.[jt]sx?$': '<rootDir>/tests/babel-jest-dynamic-import.js',
  },
};

module.exports = {
  projects: [
    {
      ...baseProject,
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/src/utils/**/*.test.ts',
        '<rootDir>/src/lib/**/*.test.ts',
        '<rootDir>/src/store/**/*.test.ts',
        '<rootDir>/src/hooks/**/*.test.ts',
      ],
    },
    {
      ...baseProject,
      displayName: 'component',
      testEnvironment: 'jsdom',
      testMatch: [
        '<rootDir>/src/components/**/*.test.tsx',
        '<rootDir>/src/screens/**/*.test.tsx',
      ],
      // @testing-library/jest-native/extend-expect was removed in spec
      // 023 / B1 — neither shipped test file used jest-native-specific
      // matchers (verified at architecture time), and v12.4+ of
      // @testing-library/react-native provides the built-in matchers
      // we actually use.
    },
  ],
  // Stale worktree dirs under `.claude/worktrees/` may carry a duplicate
  // `package.json` with the same `name` field, which jest-haste-map
  // collides on. Per CLAUDE.md the directory is gitignored and never
  // modified by agents, so ignoring it here is the right place.
  modulePathIgnorePatterns: [
    '<rootDir>/.claude/worktrees/',
  ],
};
