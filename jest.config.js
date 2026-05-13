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
  // jest-expo configures babel-jest via babel-preset-expo. Do not override
  // `transform` here; doing so double-transforms TS and breaks the build.
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
      setupFilesAfterEnv: [
        '<rootDir>/tests/jest.setup.ts',
        '@testing-library/jest-native/extend-expect',
      ],
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
