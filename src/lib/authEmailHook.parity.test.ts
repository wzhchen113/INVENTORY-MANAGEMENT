// Spec 166 §11 / D9 — inline-not-shared parity for the auth-email-hook core.
//
// The core block in src/lib/authEmailHook.ts (jest-only canonical) ships
// byte-identical inside supabase/functions/auth-email-hook/index.ts (spec 027
// §4.2: shared `_shared/` modules are invisible drift surface because the CLI
// deploys one function at a time). This suite fails the build on any drift.
// Own extractor, tagged (spec 166), so the spec 165 parity suite is untouched.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const CANONICAL = 'src/lib/authEmailHook.ts';
const DENO = 'supabase/functions/auth-email-hook/index.ts';
const TAG = 'auth-email-hook-core';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Lines strictly between the BEGIN/END marker lines. Throws on 0 or >1 blocks. */
function extractBlock(src: string, file: string): string {
  const begin = `// BEGIN ${TAG} (spec 166)`;
  const end = `// END ${TAG} (spec 166)`;
  const lines = src.split('\n');
  const beginIdx = lines.map((l, i) => (l.trim() === begin ? i : -1)).filter((i) => i >= 0);
  const endIdx = lines.map((l, i) => (l.trim() === end ? i : -1)).filter((i) => i >= 0);
  if (beginIdx.length !== 1 || endIdx.length !== 1) {
    throw new Error(`${file}: expected exactly one "${TAG}" block, found ${beginIdx.length} BEGIN / ${endIdx.length} END`);
  }
  if (endIdx[0] <= beginIdx[0] + 1) throw new Error(`${file}: empty or inverted "${TAG}" block`);
  return lines.slice(beginIdx[0] + 1, endIdx[0]).join('\n');
}

describe('auth-email-hook core block parity (spec 166 D9)', () => {
  const canonical = extractBlock(read(CANONICAL), CANONICAL);

  it('(a) the Deno function carries the core block byte-identically', () => {
    expect(extractBlock(read(DENO), DENO)).toBe(canonical);
  });

  it('(b) the block is pure: no export, Deno., fetch(, console. or placeholder literal', () => {
    expect(canonical).not.toMatch(/\bexport\b/);
    expect(canonical).not.toContain('Deno.');
    expect(canonical).not.toContain('fetch(');
    expect(canonical).not.toContain('console.');
    expect(canonical).not.toContain('no-email.invalid');
  });

  it('(c) the Deno function inlines escapeHtml byte-identically to src/utils/escapeHtml.ts', () => {
    const mirror = read('src/utils/escapeHtml.ts');
    const start = mirror.indexOf('export function escapeHtml(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = mirror.indexOf('\n}', start);
    const fnText = mirror.slice(start, end + 2).replace(/^export /, '');
    expect(fnText.startsWith('function escapeHtml(value: unknown): string {')).toBe(true);
    expect(read(DENO)).toContain(fnText);
  });

  it('the canonical module exports the block symbols', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./authEmailHook');
    for (const name of ['parsePayload', 'routeLegs', 'planMails', 'parseHookSecrets', 'resolveTransport', 'buildTransportRequest']) {
      expect(typeof mod[name]).toBe('function');
    }
  });
});
