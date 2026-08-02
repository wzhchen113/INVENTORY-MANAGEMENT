// src/utils/pushNotificationCopy.test.ts — spec 149 AC-7 (jest track).
//
// Closes the test-engineer's Critical: the `order_ready` branch of
// supabase/functions/submission-push-fanout/index.ts had zero coverage in any
// of the three tracks. It is not reachable from a shell smoke — the function's
// response body carries only `{ ok, recipients, pushed }`, and the copy itself
// travels inside an encrypted web-push payload, so no HTTP-level assertion can
// observe it. The honest option is therefore the same one the repo already uses
// for Deno-side pure logic: a source-level TS mirror (src/utils/escapeHtml.ts →
// send-*-email), exercised here.
//
// What this pins:
//   • AC-7 — order_ready title/body copy, and that NEITHER contains the word
//     "submitted" (the exact regression the default branch would cause).
//   • The other three branches, so a future edit to the shared derivation
//     cannot silently change spec-120 / 121 / 126 copy while "fixing" 149.

import { derivePushCopy } from './pushNotificationCopy';

describe('derivePushCopy — order_ready (spec 149, AC-7)', () => {
  it('asks for a REVIEW rather than announcing a submission', () => {
    expect(
      derivePushCopy({
        type: 'order_ready',
        store_name: 'Frederick',
        body: "BJ's Wholesale",
        actor_name: 'maria',
      }),
    ).toEqual({ title: 'Order ready to approve', body: "Frederick · BJ's Wholesale" });
  });

  it('never uses the word "submitted" in either the title or the body', () => {
    const copy = derivePushCopy({
      type: 'order_ready',
      store_name: 'Frederick',
      body: 'Sysco',
      actor_name: 'maria',
    });
    expect(copy.title.toLowerCase()).not.toContain('submitted');
    expect(copy.body.toLowerCase()).not.toContain('submitted');
    // The submitter's name is deliberately NOT in the body — the vendor is.
    expect(copy.body).not.toContain('maria');
  });

  it('drops the separator when the vendor name is missing', () => {
    expect(derivePushCopy({ type: 'order_ready', store_name: 'Towson', body: null })).toEqual({
      title: 'Order ready to approve',
      body: 'Towson',
    });
  });

  it('drops the separator when the store name is missing', () => {
    expect(derivePushCopy({ type: 'order_ready', store_name: null, body: 'Sysco' })).toEqual({
      title: 'Order ready to approve',
      body: 'Sysco',
    });
  });
});

describe('derivePushCopy — the branches spec 149 must not disturb', () => {
  it('keeps the spec-120 default copy for a routine eod notification', () => {
    expect(
      derivePushCopy({ type: 'eod', actor_name: 'maria', store_name: 'Frederick' }),
    ).toEqual({ title: 'EOD count submitted', body: 'maria · Frederick' });
  });

  it('falls back to "Submission submitted" for an unknown type', () => {
    expect(derivePushCopy({ type: 'brand_new_type', store_name: 'Frederick' })).toEqual({
      title: 'Submission submitted',
      body: 'A user · Frederick',
    });
  });

  it('keeps the spec-121 missed_eod copy (no submitter, vendor rides actor_name)', () => {
    expect(
      derivePushCopy({ type: 'missed_eod', store_name: 'Frederick', actor_name: 'Sysco' }),
    ).toEqual({ title: 'Missed EOD count', body: 'Frederick · Sysco' });
  });

  it('keeps the spec-126 issue copy, truncating the preview at 100 characters', () => {
    const long = 'x'.repeat(150);
    const copy = derivePushCopy({
      type: 'issue',
      store_name: 'Frederick',
      category: 'equipment',
      body: long,
    });
    expect(copy.title).toBe('Issue reported');
    expect(copy.body).toBe(`Frederick · Equipment · ${'x'.repeat(100)}…`);
  });

  it('falls back to the raw category when the issue category is unmapped', () => {
    expect(
      derivePushCopy({ type: 'issue', store_name: 'Frederick', category: 'plumbing', body: 'leak' }),
    ).toEqual({ title: 'Issue reported', body: 'Frederick · plumbing · leak' });
  });
});
