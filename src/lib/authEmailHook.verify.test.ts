// Spec 169 §7 — the inline Standard Webhooks verifier in the auth-email-hook
// core block (src/lib/authEmailHook.ts, byte-identical in the edge function).
//
// Expectations come ONLY from the fixed literals (openssl and node agreed on
// them in spec 168) or from the independent node:crypto oracle below — never
// from signWebhook's own signing path. crypto.subtle is the real runtime
// global; nothing here mocks or polyfills it (spec 169 §4).
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  base64ToBytes,
  timingSafeEqualString,
  signWebhook,
  verifyWebhook,
  parseHookSecrets,
} from './authEmailHook';

const ROOT = path.resolve(__dirname, '..', '..');

// D7: the committed local dev secret (spec 166). Public by design.
const D7 = 'LOCAL/DEV/ONLY/imr/SendEmailHook/NotForProd/0000';
const D7_HEX = '2ce0802ff0c457f38d2d8fe29abfd27a774499a8a51e8a24fcda2d168acfae877fd34d34';
const OTHER = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw';
const OTHER2 = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpa';
const ID = 'msg_vector';
const TS = 1700000000;
const NOW = 1700000000;
const BODY_AB = '{"a":"b"}';
const BODY_E = '{"e":"é—"}';
const SIG_AB = 'xqgCspicZv/oSTd9Q1fnDS8JxTgxgn77rND6oyBOui4=';
const SIG_E = '9tmyMw8kfLRfWKnqherF2jbqNDoM6962K50b8EUjMLE=';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ALPHABET_CHARS = ALPHABET.split('');

/** Independent oracle: node:crypto HMAC over the exact signed-content text. */
function oracle(b64: string, id: string, tsText: string, body: string): string {
  return createHmac('sha256', Buffer.from(b64, 'base64'))
    .update(`${id}.${tsText}.${body}`, 'utf8')
    .digest('base64');
}

function hdrs(id: string, ts: string, sig: string): Record<string, string> {
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig };
}

/** Hex of a byte view. Compare hex, never Uint8Arrays (jest realm split). */
function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seeded PRNG so property failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

const LENGTHS: number[] = [];
for (let l = 32; l <= 88; l += 4) LENGTHS.push(l);

/** Random member of S: alphabet chars + 0..2 trailing "=", length % 4 === 0. */
function randomMemberOfS(rnd: () => number): string {
  const L = pick(rnd, LENGTHS);
  const p = pick(rnd, [0, 1, 2]);
  let s = '';
  for (let i = 0; i < L - p; i++) s += pick(rnd, ALPHABET_CHARS);
  return s + '='.repeat(p);
}

/** good(ts): a v1 entry signed with D7 over BODY_AB at the given timestamp text. */
function good(ts: number | string, body: string = BODY_AB, id: string = ID): string {
  return 'v1,' + oracle(D7, id, String(ts), body);
}

describe('V0 runtime reachability', () => {
  it('crypto.subtle, atob, btoa and TextEncoder are reachable without mocks', () => {
    expect(typeof globalThis.crypto?.subtle?.importKey).toBe('function');
    expect(typeof globalThis.crypto?.subtle?.sign).toBe('function');
    expect(typeof atob).toBe('function');
    expect(typeof btoa).toBe('function');
    expect(typeof TextEncoder).toBe('function');
  });
});

describe('V1 fixed vectors and signing parity', () => {
  it('V1.1 {"a":"b"}: oracle and signWebhook both give SIG_AB', async () => {
    expect(oracle(D7, ID, '1700000000', BODY_AB)).toBe(SIG_AB);
    await expect(signWebhook(D7, ID, TS, BODY_AB)).resolves.toBe(SIG_AB);
  });

  it('V1.2 {"e":"é—"} (13 UTF-8 bytes): oracle and signWebhook both give SIG_E', async () => {
    expect(Buffer.byteLength(BODY_E, 'utf8')).toBe(13);
    expect(oracle(D7, ID, '1700000000', BODY_E)).toBe(SIG_E);
    await expect(signWebhook(D7, ID, TS, BODY_E)).resolves.toBe(SIG_E);
  });

  it('V1.3 verifyWebhook accepts v1,<vector> for both bodies', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '1700000000', 'v1,' + SIG_AB), NOW)).resolves.toBe(true);
    await expect(verifyWebhook([D7], BODY_E, hdrs(ID, '1700000000', 'v1,' + SIG_E), NOW)).resolves.toBe(true);
  });

  it('V1.4 66-byte key (88 chars) and 22-byte key (32 chars, "==")', async () => {
    const k66 = Buffer.from(Array.from({ length: 66 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64');
    const k22 = Buffer.from(Array.from({ length: 22 }, (_, i) => (i * 53 + 7) & 0xff)).toString('base64');
    expect(k66.length).toBe(88);
    expect(k22.length).toBe(32);
    expect(k22.endsWith('==')).toBe(true);
    for (const k of [k66, k22]) {
      expect(parseHookSecrets('v1,whsec_' + k)).toEqual([k]);
      const want = oracle(k, ID, '1700000000', BODY_AB);
      await expect(signWebhook(k, ID, TS, BODY_AB)).resolves.toBe(want);
      await expect(verifyWebhook([k], BODY_AB, hdrs(ID, '1700000000', 'v1,' + want), NOW)).resolves.toBe(true);
    }
  });

  it('V1.5 300 random (key, id, ts, body) cases: signWebhook === oracle', async () => {
    const rnd = mulberry32(169);
    const idChars = 'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('');
    // BMP, astral and multibyte code points (no lone surrogates). The two
    // invisible ones are escaped so a whitespace-trim pass cannot change them:
    // \u00a0 is NBSP and \u2028 is LINE SEPARATOR.
    const bodyChars = ['a', 'Z', '{', '"', ':', ' ', '\n', 'é', '—', 'ü', '中', '文', '😀', '𝄞', '🙂', '\u00a0', '\u2028'];
    for (let n = 0; n < 300; n++) {
      const key = randomMemberOfS(rnd);
      let id = 'msg_';
      for (let i = 0; i < 1 + Math.floor(rnd() * 24); i++) id += pick(rnd, idChars);
      const ts = 1e9 + Math.floor(rnd() * 1e9);
      let body = '';
      for (let i = 0; i < Math.floor(rnd() * 64); i++) body += pick(rnd, bodyChars);
      const want = oracle(key, id, String(ts), body);
      const got = await signWebhook(key, id, ts, body);
      // The inputs sit on both sides so a failure prints the failing case;
      // only got vs want can differ.
      expect({ key, id, ts, body, got }).toEqual({ key, id, ts, body, got: want });
    }
  });
});

describe('V2 key-decode equivalence', () => {
  it('V2.1 3000 random members of S: accepted by parseHookSecrets, bytes equal Buffer, length 3L/4 - p', () => {
    const rnd = mulberry32(169);
    for (let n = 0; n < 3000; n++) {
      const s = randomMemberOfS(rnd);
      const p = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
      const want = Buffer.from(s, 'base64').toString('hex');
      const bytes = base64ToBytes(s);
      expect({ s, parsed: parseHookSecrets('v1,whsec_' + s), got: hex(bytes), len: bytes.length }).toEqual({
        s,
        parsed: [s],
        got: want,
        len: (s.length / 4) * 3 - p,
      });
    }
  });

  it('V2.2 3000 random strings over the 65-char alphabet: parseHookSecrets accepts iff base64ToBytes does not throw', () => {
    const rnd = mulberry32(1690);
    const alpha65 = (ALPHABET + '=').split('');
    let accepted = 0;
    for (let n = 0; n < 3000; n++) {
      const L = pick(rnd, LENGTHS);
      let s = '';
      for (let i = 0; i < L; i++) s += pick(rnd, alpha65);
      const parsedOk = parseHookSecrets('v1,whsec_' + s) !== null;
      let decoded: string | null = null;
      try {
        decoded = hex(base64ToBytes(s));
      } catch {
        decoded = null;
      }
      expect({ s, parsedOk, decodedOk: decoded !== null }).toEqual({ s, parsedOk, decodedOk: parsedOk });
      if (decoded !== null) {
        accepted++;
        expect({ s, decoded }).toEqual({ s, decoded: Buffer.from(s, 'base64').toString('hex') });
      }
    }
    // Both sides of the iff were exercised.
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(3000);
  });

  it('V2.3 D7 decodes to D7_HEX; a non-canonical tail matches Buffer', () => {
    expect(hex(base64ToBytes(D7))).toBe(D7_HEX);
    const nonCanonical = 'A'.repeat(42) + 'B=';
    expect(hex(base64ToBytes(nonCanonical))).toBe(Buffer.from(nonCanonical, 'base64').toString('hex'));
  });

  it('V2.4 malformed base64 throws', () => {
    for (const bad of ['', 'A'.repeat(43), 'A'.repeat(20) + '=' + 'A'.repeat(23), 'A'.repeat(29) + '===', 'AAAA AAAA', 'AAAAAA']) {
      expect(() => base64ToBytes(bad)).toThrow();
    }
  });
});

describe('V3 timestamp', () => {
  it('V3.1 exactly ±300 s is accepted', async () => {
    for (const ts of [NOW - 300, NOW + 300]) {
      await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(ts), good(ts)), NOW)).resolves.toBe(true);
    }
  });

  it('V3.2 ±301 s is rejected (too old / too new)', async () => {
    for (const ts of [NOW - 301, NOW + 301]) {
      await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(ts), good(ts)), NOW)).resolves.toBe(false);
    }
  });

  it('V3.3 non-numeric and empty timestamps are rejected', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, 'abc', good('abc')), NOW)).resolves.toBe(false);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '', good('')), NOW)).resolves.toBe(false);
  });

  it('V3.4 replicated parseInt leniency: lenient headers verify against the canonical integer', async () => {
    for (const t of ['1700000000abc', '+1700000000', '01700000000', '1700000000.9', ' 1700000000']) {
      await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, t, good('1700000000')), NOW)).resolves.toBe(true);
    }
  });

  it('V3.5 a signature over the raw lenient text is rejected', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '1700000000abc', good('1700000000abc')), NOW)).resolves.toBe(false);
  });

  it('V3.6 "17e8", an Infinity-sized integer and a negative timestamp are rejected', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '17e8', good('17')), NOW)).resolves.toBe(false);
    const huge = '1' + '0'.repeat(400);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, huge, good('Infinity')), NOW)).resolves.toBe(false);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, huge, good(huge)), NOW)).resolves.toBe(false);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '-1700000000', good('-1700000000')), NOW)).resolves.toBe(false);
  });

  it('V3.7 D1 (spec 169 §2.6 clock guard): a NaN / Infinity / fractional / out-of-range clock is refused', async () => {
    for (const now of [NaN, Infinity, 1700000000.5]) {
      await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(TS), good(TS)), now)).resolves.toBe(false);
    }
    const edge = 8.64e12;
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(edge), good(String(edge))), edge)).resolves.toBe(false);
  });

  it('V3.8 the inner D1 boundary (8.64e12 - 300) with a matching timestamp and a valid signature is accepted', async () => {
    const inner = 8.64e12 - 300;
    expect(String(inner)).toBe('8639999999700');
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(inner), good(inner)), inner)).resolves.toBe(true);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(inner + 1), good(inner + 1)), inner + 1)).resolves.toBe(false);
  });
});

describe('V4 required headers', () => {
  const full = hdrs(ID, String(TS), 'v1,' + SIG_AB);

  it('V4.1 each missing header is rejected', async () => {
    for (const k of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h: Record<string, string> = { ...full };
      delete h[k];
      await expect(verifyWebhook([D7], BODY_AB, h, NOW)).resolves.toBe(false);
    }
  });

  it('V4.2 each header set to "" is rejected', async () => {
    for (const k of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      await expect(verifyWebhook([D7], BODY_AB, { ...full, [k]: '' }, NOW)).resolves.toBe(false);
    }
  });

  it('V4.2b each header present with an explicit undefined value is rejected', async () => {
    for (const k of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const h: Record<string, string | undefined> = { ...full, [k]: undefined };
      expect(Object.keys(h)).toContain(k);
      await expect(verifyWebhook([D7], BODY_AB, h, NOW)).resolves.toBe(false);
    }
  });

  it('V4.3 header names are case-insensitive; unrelated headers are ignored', async () => {
    const h = {
      'Webhook-Id': ID,
      'WEBHOOK-TIMESTAMP': String(TS),
      'Webhook-Signature': 'v1,' + SIG_AB,
      'content-type': 'application/json',
      'X-Other': 'x',
    };
    await expect(verifyWebhook([D7], BODY_AB, h, NOW)).resolves.toBe(true);
  });

  it('V4.3b names differing only in case: the last key in object order wins (as the library)', async () => {
    const sig = 'v1,' + SIG_AB;
    const goodLast = { 'webhook-id': 'msg_other', 'Webhook-Id': ID, 'webhook-timestamp': String(TS), 'webhook-signature': sig };
    const badLast = { 'Webhook-Id': ID, 'webhook-id': 'msg_other', 'webhook-timestamp': String(TS), 'webhook-signature': sig };
    await expect(verifyWebhook([D7], BODY_AB, goodLast, NOW)).resolves.toBe(true);
    await expect(verifyWebhook([D7], BODY_AB, badLast, NOW)).resolves.toBe(false);
  });

  it('V4.4 combined duplicate headers: id rejected, timestamp replicated (first value)', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs('msg_vector, msg_other', String(TS), 'v1,' + SIG_AB), NOW)).resolves.toBe(false);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '1700000000, 1700000001', 'v1,' + SIG_AB), NOW)).resolves.toBe(true);
  });
});

describe('V5 signature header', () => {
  const g = oracle(D7, ID, String(TS), BODY_AB);
  const bad = oracle(OTHER, ID, String(TS), BODY_AB);
  const bad2 = oracle(OTHER2, ID, String(TS), BODY_AB);
  const v = (sig: string) => verifyWebhook([D7], BODY_AB, hdrs(ID, String(TS), sig), NOW);

  it('V5.1 any v1 entry may match', async () => {
    await expect(v(`v1,${bad} v1,${g}`)).resolves.toBe(true);
    await expect(v(`v1,${bad} v1,${bad2}`)).resolves.toBe(false);
  });

  it('V5.2 non-v1 versions carrying the correct signature are skipped', async () => {
    for (const s of [`v2,${g}`, `v1a,${g}`, `V1,${g}`, g]) {
      await expect(v(s)).resolves.toBe(false);
    }
  });

  it('V5.3 malformed entries are non-matches, never exceptions', async () => {
    for (const s of ['v1', 'v1,', 'v1,!!!notbase64!!!', `,${g}`, ' ']) {
      await expect(v(s)).resolves.toBe(false);
    }
  });

  it('V5.4 an unpadded (43-char) copy of the good signature is rejected', async () => {
    expect(g.endsWith('=')).toBe(true);
    await expect(v('v1,' + g.slice(0, -1))).resolves.toBe(false);
  });

  it('V5.5 trailing and repeated spaces', async () => {
    await expect(v(`v1,${g} `)).resolves.toBe(true);
    await expect(v(`v1,${bad}  v1,${g}`)).resolves.toBe(true);
  });

  it('V5.6 lax multi-comma entries (replicated), incl. the GoTrue ", " join shape', async () => {
    await expect(v(`v1,${g},extra`)).resolves.toBe(true);
    await expect(v(`v1,${g}, v1,${bad}`)).resolves.toBe(true);
  });

  it('V5.7 combined duplicate signature header', async () => {
    await expect(v(`v1,${bad}, v1,${g}`)).resolves.toBe(true);
  });

  it('V5.8 a non-canonical alias (same decoded bytes, different string) is rejected', async () => {
    expect(SIG_AB.endsWith('ui4=')).toBe(true);
    const alias = SIG_AB.slice(0, -4) + 'ui5=';
    expect(Buffer.from(alias, 'base64').toString('hex')).toBe(Buffer.from(SIG_AB, 'base64').toString('hex'));
    await expect(v('v1,' + alias)).resolves.toBe(false);
    await expect(v('v1,' + SIG_AB)).resolves.toBe(true);
  });
});

describe('V6 rotation and key handling', () => {
  const h = hdrs(ID, String(TS), 'v1,' + SIG_AB);

  it('OTHER and OTHER2 are well-formed secrets', () => {
    expect(parseHookSecrets('v1,whsec_' + OTHER)).toEqual([OTHER]);
    expect(parseHookSecrets('v1,whsec_' + OTHER2)).toEqual([OTHER2]);
    expect(new Set([D7, OTHER, OTHER2]).size).toBe(3);
  });

  it('V6.1 a match on any rotated secret accepts', async () => {
    await expect(verifyWebhook([OTHER, D7], BODY_AB, h, NOW)).resolves.toBe(true);
    await expect(verifyWebhook([D7, OTHER], BODY_AB, h, NOW)).resolves.toBe(true);
  });

  it('V6.2 no matching secret, or no secrets, rejects', async () => {
    await expect(verifyWebhook([OTHER, OTHER2], BODY_AB, h, NOW)).resolves.toBe(false);
    await expect(verifyWebhook([], BODY_AB, h, NOW)).resolves.toBe(false);
  });

  it('V6.3 wrong key', async () => {
    const sig = 'v1,' + oracle(OTHER, ID, String(TS), BODY_AB);
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, String(TS), sig), NOW)).resolves.toBe(false);
  });

  it('V6.4 a secret that cannot be imported is skipped, never rejected', async () => {
    await expect(verifyWebhook(['!!!!', D7], BODY_AB, h, NOW)).resolves.toBe(true);
    await expect(verifyWebhook(['!!!!'], BODY_AB, h, NOW)).resolves.toBe(false);
    await expect(verifyWebhook(['', D7], BODY_AB, h, NOW)).resolves.toBe(true);
    await expect(verifyWebhook([''], BODY_AB, h, NOW)).resolves.toBe(false);
  });

  it('V6.5 fail-open guard: a throwing secret never matches an empty "v1," entry', async () => {
    await expect(verifyWebhook(['!!!!'], BODY_AB, hdrs(ID, String(TS), 'v1,'), NOW)).resolves.toBe(false);
    await expect(verifyWebhook(['', '!!!!'], BODY_AB, hdrs(ID, String(TS), 'v1, v1,'), NOW)).resolves.toBe(false);
  });
});

describe('V7 tampering', () => {
  it('V7.1 tampered body', async () => {
    await expect(verifyWebhook([D7], '{"a":"c"}', hdrs(ID, String(TS), 'v1,' + SIG_AB), NOW)).resolves.toBe(false);
  });

  it('V7.2 tampered id', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs('msg_vectoR', String(TS), 'v1,' + SIG_AB), NOW)).resolves.toBe(false);
  });

  it('V7.3 tampered timestamp inside the window', async () => {
    await expect(verifyWebhook([D7], BODY_AB, hdrs(ID, '1700000001', 'v1,' + SIG_AB), NOW)).resolves.toBe(false);
  });
});

describe('V8 signed non-JSON body (replicated 401)', () => {
  it('V8.1 a correctly signed non-JSON body fails verification', async () => {
    for (const body of ['not json', '', '{"a":']) {
      await expect(verifyWebhook([D7], body, hdrs(ID, String(TS), good(TS, body)), NOW)).resolves.toBe(false);
    }
  });

  it('V8.2 a correctly signed JSON body of the wrong shape passes the gate (step 5 answers 400)', async () => {
    for (const body of ['{}', 'null', '[]', '1']) {
      await expect(verifyWebhook([D7], body, hdrs(ID, String(TS), good(TS, body)), NOW)).resolves.toBe(true);
    }
  });

  it('V8.3 rotation does not rescue a signed non-JSON body', async () => {
    const body = 'not json';
    await expect(verifyWebhook([OTHER, D7], body, hdrs(ID, String(TS), good(TS, body)), NOW)).resolves.toBe(false);
  });
});

describe('V9 timingSafeEqualString', () => {
  it('compares UTF-8 bytes', () => {
    expect(timingSafeEqualString(SIG_AB, SIG_AB)).toBe(true);
    expect(timingSafeEqualString('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualString('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualString('é', 'e')).toBe(false);
  });
});

describe('S static checks', () => {
  it('S1 index.ts has no imports and no library verifier', () => {
    const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/auth-email-hook/index.ts'), 'utf8');
    const lines = src.split('\n');
    for (const line of lines) {
      expect({ line, importStmt: /^\s*import[\s{*]/.test(line) }).toEqual({ line, importStmt: false });
      if (line.includes('standardwebhooks') || line.includes('esm.sh')) {
        expect({ line, comment: /^\s*\/\//.test(line) }).toEqual({ line, comment: true });
      }
      // Any module specifier on a code line: `import … from "x"`, a
      // re-exporting `export … from "x"`, or a multi-line `} from "x"`, for
      // any scheme. A bare https:// check would trip on RESEND_API_URL.
      if (!/^\s*\/\//.test(line)) {
        expect({ line, fromSpecifier: /\bfrom\s*['"]/.test(line) }).toEqual({ line, fromSpecifier: false });
      }
    }
    expect(src).not.toContain('import(');
    // Dynamic import with whitespace before the parenthesis.
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/['"]npm:/);
    expect(src).not.toContain('jsr:');
    expect(src).not.toContain('verifySignature');
    expect(src).not.toContain('new Webhook(');
  });

  it('S2 the canonical core block reads no clock and uses no subtle.verify / require', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/authEmailHook.ts'), 'utf8');
    const lines = src.split('\n');
    const b = lines.findIndex((l) => l.trim() === '// BEGIN auth-email-hook-core (spec 166)');
    const e = lines.findIndex((l) => l.trim() === '// END auth-email-hook-core (spec 166)');
    expect(b).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(b + 1);
    const block = lines.slice(b + 1, e).join('\n');
    expect(block).not.toContain('Date.now');
    expect(block).not.toContain('new Date(');
    expect(block).not.toContain('subtle.verify');
    expect(block).not.toContain('require(');
    expect(block).toContain('async function verifyWebhook(');
  });
});
