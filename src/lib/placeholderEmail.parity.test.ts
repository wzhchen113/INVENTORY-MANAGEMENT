// Spec 165 §3.2 / §3.4 / §10 — inline-not-shared parity.
//
// The placeholder-email predicate is copied into five Deno edge functions
// (spec 166 added auth-email-hook), and the reserved-username set is copied
// into manage-store-user. Copies are inline, not shared, per spec 027 §4.2:
// `_shared/` modules are invisible drift surface because the CLI deploys one
// function at a time. This suite fails the build if any copy drifts from the
// TS canonical. Precedent for fs-reading source in jest:
// src/lib/guide.i18n.test.ts.
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Lines strictly between the BEGIN/END marker lines (markers matched on
 *  their trimmed content, so a copy may sit at any indentation as long as
 *  the block body itself is byte-identical). Throws on 0 or >1 blocks. */
function extractBlock(src: string, tag: string, file: string): string {
  const begin = `// BEGIN ${tag} (spec 165)`;
  const end = `// END ${tag} (spec 165)`;
  const lines = src.split('\n');
  const beginIdx = lines.map((l, i) => (l.trim() === begin ? i : -1)).filter((i) => i >= 0);
  const endIdx = lines.map((l, i) => (l.trim() === end ? i : -1)).filter((i) => i >= 0);
  if (beginIdx.length !== 1 || endIdx.length !== 1) {
    throw new Error(`${file}: expected exactly one "${tag}" block, found ${beginIdx.length} BEGIN / ${endIdx.length} END`);
  }
  if (endIdx[0] <= beginIdx[0] + 1) throw new Error(`${file}: empty or inverted "${tag}" block`);
  return lines.slice(beginIdx[0] + 1, endIdx[0]).join('\n');
}

describe('placeholder-email block parity (spec 165 §3.2)', () => {
  const CANONICAL = 'src/lib/placeholderEmail.ts';
  const COPIES = [
    'supabase/functions/manage-store-user/index.ts',
    'supabase/functions/eod-reminder-cron/index.ts',
    'supabase/functions/weekly-reminder-cron/index.ts',
    'supabase/functions/send-welcome-email/index.ts',
    'supabase/functions/auth-email-hook/index.ts',
  ];
  const canonical = extractBlock(read(CANONICAL), 'placeholder-email', CANONICAL);

  it('canonical block defines the regex + predicate and carries no export', () => {
    expect(canonical).toContain('const PLACEHOLDER_EMAIL_RE = /^u-[0-9a-f]{32}@no-email\\.invalid$/;');
    expect(canonical).toContain('function isPlaceholderEmail(email: unknown): boolean');
    expect(canonical).not.toMatch(/\bexport\b/);
  });

  it.each(COPIES)('%s is byte-identical to the canonical block', (file) => {
    expect(extractBlock(read(file), 'placeholder-email', file)).toBe(canonical);
  });

  it('the canonical module still exports the block symbols', () => {
    // Guard against someone moving the export inside / deleting it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./placeholderEmail');
    expect(typeof mod.isPlaceholderEmail).toBe('function');
    expect(mod.PLACEHOLDER_EMAIL_RE).toBeInstanceOf(RegExp);
  });
});

describe('reserved-usernames block parity (spec 165 §3.4)', () => {
  const CANONICAL = 'src/lib/usernameValidation.ts';
  const COPY = 'supabase/functions/manage-store-user/index.ts';

  it('manage-store-user mirrors RESERVED_USERNAMES byte-for-byte', () => {
    const canonical = extractBlock(read(CANONICAL), 'reserved-usernames', CANONICAL);
    expect(extractBlock(read(COPY), 'reserved-usernames', COPY)).toBe(canonical);
  });

  it('the marked block is exactly the runtime RESERVED_USERNAMES set', () => {
    // Proves the markers wrap the whole literal (no entries outside them).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RESERVED_USERNAMES } = require('./usernameValidation');
    const block = extractBlock(read(CANONICAL), 'reserved-usernames', CANONICAL);
    const fromBlock = Array.from(block.matchAll(/'([^']*)'/g), (m) => m[1]).sort();
    expect(fromBlock).toEqual(Array.from(RESERVED_USERNAMES as Set<string>).sort());
  });
});

describe('no hand-rolled placeholder checks outside the sanctioned copies', () => {
  // Spec 165 §3.2: no other code may test for the placeholder domain.
  // Test files are excluded: fixtures legitimately contain placeholder
  // addresses. The lint is about SHIPPED code hand-rolling the check.
  const ALLOWED = new Set(['src/lib/placeholderEmail.ts']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !full.includes(`${path.sep}__tests__${path.sep}`)) out.push(full);
    }
    return out;
  }

  it('shipped src/** never mentions no-email.invalid except the predicate module', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => read(rel).includes('no-email.invalid'));
    expect(offenders).toEqual([]);
  });
});
