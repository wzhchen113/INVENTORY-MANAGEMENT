// App version string shown in the sidebar / mobile drawer / dev preview.
//
// Two sources of truth:
//   - semver from package.json — bumped intentionally when something
//     release-worthy ships (the "marketing version"). Resolved at build
//     time via the JSON import; Metro inlines the value into the bundle.
//   - short git SHA from EXPO_PUBLIC_GIT_SHA — set by Vercel's build via
//     `EXPO_PUBLIC_GIT_SHA="$VERCEL_GIT_COMMIT_SHA"` in vercel.json's
//     buildCommand. Local dev (`npm run dev`) leaves the env unset, so
//     the SHA falls back to `'dev'` for visual disambiguation.
//
// Rendered shape: `v2.4.0 · ca17fbb` on prod, `v2.4.0 · dev` locally.
//
// Why both: per the PM survey of modern SaaS dashboards (GitHub, GitLab,
// Sentry, Linear), semver+SHA is the dominant production pattern because
// the SHA is the load-bearing piece for "is the user on a stale tab?"
// triage, while semver is the human-readable anchor for changelogs.

import pkg from '../../package.json';

const rawSha = process.env.EXPO_PUBLIC_GIT_SHA || '';
const shortSha = rawSha ? rawSha.slice(0, 7) : 'dev';

export const APP_VERSION = `v${pkg.version} · ${shortSha}`;
