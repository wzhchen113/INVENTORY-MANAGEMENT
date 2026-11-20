// Spec 198 (review: test-engineer Should-fix 2) — source probe for the D-4
// clamp.
//
// supabase/tests/invitations_hardening.test.sql arm C3 cannot re-run the
// migration, so it runs its own COPY of the migration's clamp UPDATE. Without
// this probe the two copies could drift (e.g. the migration's 7 days edited to
// 8) while C3 stays green. This reads both files, drops SQL line comments,
// collapses whitespace, and asserts each contains the exact same clamp
// statement exactly once (and that the migration's copy lives in its
// section 4, the clamp step).
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20261110120000_invitations_hardening.sql'),
  'utf8',
);
const PGTAP = fs.readFileSync(path.join(ROOT, 'supabase', 'tests', 'invitations_hardening.test.sql'), 'utf8');

// The clamp, whitespace-normalised. Both files must carry exactly this.
const CLAMP =
  "update public.invitations set expires_at = now() + interval '48 hours' " +
  "where used = false and (expires_at is null or expires_at > now() + interval '7 days');";

/** Drop `-- ...` line comments, then collapse every whitespace run to one space. */
function normalize(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('invitations clamp: migration and pgTAP C3 run the same statement (spec 198)', () => {
  it('the migration carries the clamp exactly once', () => {
    expect(occurrences(normalize(MIGRATION), CLAMP)).toBe(1);
  });

  it("the migration's clamp is in section 4 (before the section 5 policies)", () => {
    const start = MIGRATION.indexOf('-- 4. Clamp legacy pending rows (D-4)');
    const end = MIGRATION.indexOf('-- 5. Policies.');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(normalize(MIGRATION.slice(start, end))).toContain(CLAMP);
  });

  it('invitations_hardening.test.sql (arm C3) runs the same clamp exactly once', () => {
    expect(occurrences(normalize(PGTAP), CLAMP)).toBe(1);
  });
});
