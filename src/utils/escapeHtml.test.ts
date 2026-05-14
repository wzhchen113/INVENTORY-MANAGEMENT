// src/utils/escapeHtml.test.ts — Spec 028 Track C jest coverage.
//
// Exercises the TS mirror of the inline `escapeHtml` helper that ships
// in two Deno edge functions:
//   - supabase/functions/send-invite-email/index.ts
//   - supabase/functions/send-welcome-email/index.ts
//
// The TS module at src/utils/escapeHtml.ts is byte-identical (body) to
// the two Deno copies. Jest cannot run Deno code, so the function body
// is duplicated at the source level and identity is enforced at
// code-review time via the diff one-liner in spec 028 §"Resolution of
// open questions" Q1.
//
// Test cases (spec 028 AC C2):
//   (a) Each of `&`, `<`, `>`, `"`, `'` individually maps to its entity.
//   (b) `<script>` attack payload round-trips to escaped string.
//   (c) Attribute-context payload escapes the double-quote.
//   (d) Plain ASCII passthrough.
//   (e) Emoji / multi-byte passthrough (no double-encoding of UTF-8).
//   (f) Null / undefined / non-string coerces to "".
//   (g) Already-encoded `&amp;` double-escapes to `&amp;amp;` (the
//       intentional "blind escape, no detection" contract).

import { escapeHtml } from './escapeHtml';

describe('escapeHtml', () => {
  it('maps each of the five HTML-significant characters to its named entity', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a <script> attack payload to safe entity-encoded text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('escapes an attribute-context payload — the double-quote breaks the attribute', () => {
    // Classic attribute-break payload: `" onerror="alert(1)`. The
    // double-quote MUST be escaped to &quot; so the attribute boundary
    // is preserved.
    expect(escapeHtml('" onerror="alert(1)')).toBe(
      '&quot; onerror=&quot;alert(1)'
    );
  });

  it('passes plain ASCII strings through unchanged', () => {
    expect(escapeHtml('Alice')).toBe('Alice');
  });

  it('passes UTF-8 / emoji / accented characters through unchanged', () => {
    // Pins the regression of a byte-level escape that would corrupt
    // multi-byte sequences. Only the five named chars are transformed.
    expect(escapeHtml('Café 🍰')).toBe('Café 🍰');
  });

  it('coerces null / undefined / non-string inputs to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('');
    expect(escapeHtml({})).toBe('');
  });

  it('double-escapes already-encoded entities (intentional blind-escape contract)', () => {
    // We do NOT detect "already-encoded" inputs — that's a known footgun
    // (e.g., `&amp` without trailing `;` is ambiguous). Blind escape is
    // the safe default for the one-way "user input → HTML body" pipeline.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});
