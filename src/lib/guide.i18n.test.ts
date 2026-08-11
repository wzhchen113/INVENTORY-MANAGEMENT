// src/lib/guide.i18n.test.ts — Spec 158, AC-15 + AC-16 (node project).
//
// The two existing catalog-parity suites (`src/i18n/i18n.test.ts` and the
// staff twin) fail the build on any key present in `en` but missing in
// `es`/`zh-CN`. What they CANNOT see is a key the model asks for that exists in
// NO locale — a *consistently* absent (or consistently misspelled) key sails
// past 3-way parity and renders the raw dot-path at runtime, because `t()`
// returns the key path on a miss.
//
// So this suite asserts the other direction: every key the MODEL produces
// resolves in all three catalogs of the matching surface —
//   • `guideTopicKeys()` for each topic (AC-16), and
//   • `GUIDE_CHROME_KEYS` (§8 R-9), which topic keys do not cover.
//
// Plus AC-15's leak check: no admin topic string may exist in a staff catalog.

import adminEn from '../i18n/en.json';
import adminEs from '../i18n/es.json';
import adminZh from '../i18n/zh-CN.json';
import staffEn from '../screens/staff/i18n/en.json';
import staffEs from '../screens/staff/i18n/es.json';
import staffZh from '../screens/staff/i18n/zh-CN.json';
import { GUIDE_CHROME_KEYS, guideTopicKeys, guideTopics } from './guide';

type Catalog = Record<string, unknown>;

/** Resolve a dot-path against a catalog. Returns undefined when absent, and
 *  the raw leaf otherwise (so a non-string leaf is also caught). */
function read(cat: Catalog, dotted: string): unknown {
  let cur: unknown = cat;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const ADMIN_CATALOGS: Array<[string, Catalog]> = [
  ['en', adminEn as Catalog],
  ['es', adminEs as Catalog],
  ['zh-CN', adminZh as Catalog],
];
const STAFF_CATALOGS: Array<[string, Catalog]> = [
  ['en', staffEn as Catalog],
  ['es', staffEs as Catalog],
  ['zh-CN', staffZh as Catalog],
];

/** The catalog root both surfaces prefix the model's relative keys with. */
const ROOT = 'guide.';

describe('AC-16 — every admin guide key resolves in all three admin catalogs', () => {
  const keys = guideTopics('admin').flatMap(guideTopicKeys);

  it('produces the expected key volume (17 topics × (2 + actions))', () => {
    expect(keys.length).toBeGreaterThan(60);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const [locale, cat] of ADMIN_CATALOGS) {
    it(`admin ${locale} has every topic key as a non-empty string`, () => {
      const missing = keys.filter((k) => typeof read(cat, ROOT + k) !== 'string');
      expect(missing).toEqual([]);
      const empty = keys.filter((k) => String(read(cat, ROOT + k)).trim() === '');
      expect(empty).toEqual([]);
    });
  }
});

describe('AC-16 — every staff guide key resolves in all three staff catalogs', () => {
  const keys = guideTopics('staff').flatMap(guideTopicKeys);

  for (const [locale, cat] of STAFF_CATALOGS) {
    it(`staff ${locale} has every topic key as a non-empty string`, () => {
      const missing = keys.filter((k) => typeof read(cat, ROOT + k) !== 'string');
      expect(missing).toEqual([]);
      const empty = keys.filter((k) => String(read(cat, ROOT + k)).trim() === '');
      expect(empty).toEqual([]);
    });
  }
});

describe('R-9 — chrome keys are covered too (topic keys do not reach them)', () => {
  for (const [surface, catalogs] of [
    ['admin', ADMIN_CATALOGS],
    ['staff', STAFF_CATALOGS],
  ] as const) {
    for (const [locale, cat] of catalogs) {
      it(`${surface} ${locale} has every GUIDE_CHROME_KEYS entry`, () => {
        const missing = GUIDE_CHROME_KEYS.filter(
          (k) => typeof read(cat, ROOT + k) !== 'string',
        );
        expect(missing).toEqual([]);
      });
    }
  }

  it('the admin sidebar strings for the new HELP group exist in all locales', () => {
    for (const [locale, cat] of ADMIN_CATALOGS) {
      expect({ locale, v: typeof read(cat, 'sidebar.groups.help') }).toEqual({ locale, v: 'string' });
      expect({ locale, v: typeof read(cat, 'sidebar.items.guide') }).toEqual({ locale, v: 'string' });
    }
  });
});

describe('AC-15 — the staff surface can reach ONLY staff topics', () => {
  /** The model's `topics.<name>` root, minus the `topics.` prefix. */
  const suffix = (key: string) => key.replace(/^topics\./, '');

  it('the staff catalogs contain EXACTLY the 5 staff topic subtrees', () => {
    // This is the load-bearing half of AC-15: an admin topic cannot render on
    // the staff surface because its strings do not exist there. A catalog that
    // grew an 18th `topics.*` entry would fail here.
    const expected = guideTopics('staff').map((t) => suffix(t.key)).sort();
    for (const [locale, cat] of STAFF_CATALOGS) {
      const present = Object.keys(read(cat, 'guide.topics') as Record<string, unknown>).sort();
      expect({ locale, present }).toEqual({ locale, present: expected });
    }
  });

  it('no admin topic KEY resolves in a staff catalog beyond the shared EOD id', () => {
    const adminKeys = guideTopics('admin').flatMap(guideTopicKeys);
    // `EODCount` is the one id both surfaces document (with DIFFERENT copy —
    // see the next assertion), so `topics.eodCount.*` is the known, expected
    // intersection of the two key namespaces.
    const staffOwned = new Set(guideTopics('staff').flatMap(guideTopicKeys));
    for (const [locale, cat] of STAFF_CATALOGS) {
      const leaked = adminKeys.filter(
        (k) => !staffOwned.has(k) && read(cat, ROOT + k) !== undefined,
      );
      expect({ locale, leaked }).toEqual({ locale, leaked: [] });
    }
  });

  it('no admin PURPOSE paragraph appears verbatim inside the staff guide catalog', () => {
    // Purposes are long, distinctive sentences — a verbatim match would mean
    // admin copy was pasted into the staff tree. (The comparison is scoped to
    // the staff `guide` subtree: incidental single-word overlap elsewhere in
    // the catalog, e.g. the report-category label "Inventory", is not a leak.)
    for (const [locale, cat] of STAFF_CATALOGS) {
      const staffGuideBlob = JSON.stringify(read(cat, 'guide'));
      const adminCat = ADMIN_CATALOGS.find(([l]) => l === locale)![1];
      const leaked = guideTopics('admin')
        .map((t) => read(adminCat, `${ROOT}${t.key}.purpose`) as string)
        .filter((purpose) => staffGuideBlob.includes(purpose));
      expect({ locale, leaked }).toEqual({ locale, leaked: [] });
    }
  });

  it('the shared EODCount id carries DIFFERENT copy on the two surfaces', () => {
    // Proof the two catalogs are genuinely independent trees over one model
    // rather than one tree with two roots.
    expect(read(staffEn as Catalog, 'guide.topics.eodCount.title')).not.toBe(
      read(adminEn as Catalog, 'guide.topics.eodCount.title'),
    );
  });
});

describe('AC-15 — no staff source file imports the admin registry', () => {
  // The architect's concrete reading (§11): the staff subtree may import
  // `guideTopics` / `findGuideTopic` / `guideTopicKeys` / `GUIDE_CHROME_KEYS`
  // and the types — never `ADMIN_SECTION_TOPICS`, `ADMIN_STANDALONE_TOPICS`, or
  // `adminSections` (which is `import type`-only even inside `guide.ts`).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path');

  const STAFF_ROOT = path.join(__dirname, '..', 'screens', 'staff');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      // Test files are excluded: the lint is about what the SHIPPED staff
      // bundle can reach. A staff suite may legitimately assert against the
      // admin registry to prove admin topics are unreachable.
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const FORBIDDEN = ['ADMIN_SECTION_TOPICS', 'ADMIN_STANDALONE_TOPICS', 'adminSections'];

  it('greps clean across the whole staff subtree', () => {
    const offenders: string[] = [];
    for (const file of walk(STAFF_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const token of FORBIDDEN) {
        if (src.includes(token)) offenders.push(`${path.relative(STAFF_ROOT, file)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every staff call site passes the LITERAL 'staff' audience", () => {
    // A caller-controlled audience (route param, prop, variable) would let a
    // staff screen render admin topics. Only literals are allowed.
    const offenders: string[] = [];
    for (const file of walk(STAFF_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\b(guideTopics|findGuideTopic|visibleGuideTopics)\(\s*([^,)]+)/g)) {
        const arg = m[2].trim();
        if (arg !== "'staff'" && arg !== '"staff"') {
          offenders.push(`${path.relative(STAFF_ROOT, file)}: ${m[1]}(${arg}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
