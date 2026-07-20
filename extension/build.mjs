// Spec 132 (D-6) — the extension build. A lightweight esbuild bundler (NOT
// Metro). Emits an unpacked MV3 extension under `dist/` the owner side-loads via
// chrome://extensions → "Load unpacked".
//
// The Supabase project URL + PUBLIC anon key are injected at build time from the
// env (falling back to the repo-root .env.local so a local build "just works").
// The anon key is NOT a secret — RLS bounds access (131 D-2 / 132 D-2).
//
// Run: `npm run build` (from extension/). Output: extension/dist/.

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST = join(__dirname, 'dist');

// ─── config: env → compile-time constants ──────────────────────────────────

function loadRepoEnv() {
  const out = {};
  const envPath = join(REPO_ROOT, '.env.local');
  if (existsSync(envPath)) {
    for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      out[key] = value;
    }
  }
  return out;
}

const repoEnv = loadRepoEnv();
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  repoEnv.EXPO_PUBLIC_SUPABASE_URL ||
  '';
const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  repoEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    '[build] WARNING: SUPABASE_URL / ANON_KEY not found in env or repo .env.local — ' +
      'the built extension will not be able to authenticate. Set EXPO_PUBLIC_SUPABASE_URL ' +
      'and EXPO_PUBLIC_SUPABASE_ANON_KEY.',
  );
}

// The origin the extension needs host access to for the auth/data calls (D-1).
let supabaseOrigin = '';
try {
  supabaseOrigin = SUPABASE_URL ? new URL(SUPABASE_URL).origin : '';
} catch {
  supabaseOrigin = '';
}

// ─── bundle ─────────────────────────────────────────────────────────────────

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const define = {
  __SUPABASE_URL__: JSON.stringify(SUPABASE_URL),
  __SUPABASE_ANON_KEY__: JSON.stringify(SUPABASE_ANON_KEY),
};

await esbuild.build({
  entryPoints: {
    'background/service-worker': join(__dirname, 'src/background/service-worker.ts'),
    'popup/popup': join(__dirname, 'src/popup/popup.ts'),
  },
  outdir: DIST,
  bundle: true,
  format: 'esm',
  target: ['chrome110'],
  platform: 'browser',
  define,
  logLevel: 'info',
  minify: false,
  sourcemap: false,
});

// ─── static assets ──────────────────────────────────────────────────────────

// popup.html
mkdirSync(join(DIST, 'popup'), { recursive: true });
writeFileSync(
  join(DIST, 'popup/popup.html'),
  readFileSync(join(__dirname, 'public/popup.html'), 'utf8'),
);

// manifest.json — inject the Supabase origin into host_permissions (D-1) so the
// background service worker can reach the auth/data endpoints. Scoped to EXACTLY
// bjs.com + samsclub.com + this one origin — never <all_urls> (AC-1/AC-9).
const manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8'));
if (supabaseOrigin) {
  const entry = `${supabaseOrigin}/*`;
  if (!manifest.host_permissions.includes(entry)) manifest.host_permissions.push(entry);
}
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`[build] done → ${DIST}`);
console.log(`[build] supabase origin: ${supabaseOrigin || '(unset)'}`);
