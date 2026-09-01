// Spec 162 — the PURE half of auto-place. Everything here is DOM-free,
// chrome-free and total, so the decision that spends money is unit-testable in
// isolation (the same boundary spec 132 drew around plan/report/dryRun).
//
// This module answers exactly one question: MAY the extension click BJ's
// place-order button right now? Every "no" is a stage-tagged failure that flows
// straight into `record_vendor_order_attempt` and, from there, into the bell
// notification and the failure email.

import type { ReportLine } from '../lib/types';

/**
 * Where an auto-place run ended. Mirrors the `stage` CHECK on
 * `public.vendor_order_attempts` (20260829000000) — if you add a stage here,
 * widen the CHECK in the same commit.
 *
 *   cart-verify   the live vendor cart didn't match the PO plan
 *   cap-check     the cart total was over the operator's spend cap
 *   checkout-nav  couldn't reach or advance BJ's checkout
 *   place         the place-order control never fired
 *   confirm       terminal — an order number was found, or it wasn't
 *   challenge     CAPTCHA / bot wall / sign-in wall
 *   error         an exception escaped the run
 */
export type CheckoutStage =
  | 'cart-verify'
  | 'cap-check'
  | 'address-verify'
  | 'card-verify'
  | 'checkout-nav'
  | 'place'
  | 'confirm'
  | 'challenge'
  | 'error';

/** What the adapter read off the live vendor cart page. */
export interface CartSnapshot {
  /** Distinct product rows in the cart, or null if the page couldn't be read. */
  lineCount: number | null;
  /** Cart subtotal in dollars, or null if it couldn't be read. */
  total: number | null;
}

export interface GateFailure {
  stage: CheckoutStage;
  detail: string;
}

/**
 * The pre-checkout gate (AC-2 / AC-3). Returns `null` to proceed, or the failure
 * that stops the run.
 *
 * STRICTNESS IS THE POINT — three deliberate refusals:
 *
 *  1. **Any line that isn't `added` blocks the whole placement.** A PO with one
 *     unmapped item would otherwise place a SHORT order unattended, and nobody
 *     would find out until the delivery arrived light. Failing here costs the
 *     operator one manual checkout; the alternative costs them a stockout. (If
 *     this proves too strict in practice it becomes a per-vendor
 *     "allow partial" flag — flagged in spec 162 OQ, not built.)
 *
 *  2. **An unreadable cart blocks.** `lineCount: null` means the selectors
 *     drifted. Placing an order we cannot see is the worst available option.
 *
 *  3. **An unreadable TOTAL blocks.** Without a total there is no cap check, and
 *     the cap is the only thing standing between a selector bug and the
 *     operator's card. There is deliberately no "cap couldn't be evaluated, so
 *     proceed" path.
 */
export function evaluateCartGate(
  report: ReportLine[],
  cart: CartSnapshot,
  capTotal: number,
): GateFailure | null {
  const notAdded = report.filter((l) => l.status !== 'added');
  if (notAdded.length > 0) {
    const names = notAdded.slice(0, 5).map((l) => `${l.itemName || l.orderCode || l.itemId} (${l.status})`);
    const more = notAdded.length > names.length ? ` +${notAdded.length - names.length} more` : '';
    return {
      stage: 'cart-verify',
      detail: `${notAdded.length} of ${report.length} PO lines did not make it into the cart: ${names.join(', ')}${more}. Nothing was ordered.`,
    };
  }

  if (report.length === 0) {
    return { stage: 'cart-verify', detail: 'The PO produced no cart lines at all. Nothing was ordered.' };
  }

  if (cart.lineCount === null) {
    return {
      stage: 'cart-verify',
      detail: 'Could not read the BJ’s cart page, so the cart could not be checked against the PO. Nothing was ordered.',
    };
  }

  if (cart.lineCount !== report.length) {
    return {
      stage: 'cart-verify',
      detail: `The BJ’s cart holds ${cart.lineCount} product line(s) but the PO has ${report.length}. Nothing was ordered.`,
    };
  }

  if (cart.total === null) {
    return {
      stage: 'cart-verify',
      detail: 'Could not read the BJ’s cart total, so the spend cap could not be checked. Nothing was ordered.',
    };
  }

  if (cart.total > capTotal) {
    return {
      stage: 'cap-check',
      detail: `The BJ’s cart total is $${cart.total.toFixed(2)}, over the $${capTotal.toFixed(2)} spend cap. Nothing was ordered.`,
    };
  }

  return null;
}

// ─── spec 162 (revision): who gets charged, and where it ships ─────────────
//
// The first cut of auto-place clicked BJ's "Place Order" without ever looking
// at the delivery address or the card. On an account with defaults that is a
// silent wrong-address / wrong-card order; the owner asked the obvious question
// and this is the answer.
//
// The operator PINS the expected shipping address and card last-4 in the popup
// (per browser, alongside the spend cap). Both are REQUIRED — there is no
// "unset means don't check" path, because that is exactly the posture that made
// the first cut wrong.

/** What the adapter read off BJ's checkout review step. */
export interface CheckoutSelections {
  /** The delivery address as rendered, or null if it couldn't be read. */
  addressText: string | null;
  /** Last 4 of the selected card, or null if it couldn't be read. */
  cardLast4: string | null;
  /**
   * Every address BJ's offers to switch to, as rendered. Empty when the page
   * shows no picker (the single-address account's normal state).
   */
  addressOptions: string[];
  detail: string;
}

/** What the operator pinned in the popup. Both required. */
export interface ExpectedSelections {
  /** The one address every order should ship to (or a distinctive part of it). */
  address: string;
  /** Last 4 digits of the card orders may be charged to. */
  cardLast4: string;
}

/**
 * The selection gate's verdict. `switchToOption` asks the caller to pick that
 * address from BJ's picker and then RE-READ and RE-GATE — a switch is never
 * trusted to have worked.
 */
export type SelectionVerdict =
  | { ok: true }
  | { ok: false; failure: GateFailure }
  | { ok: false; switchToOption: string };

/**
 * Normalize an address for comparison: lowercase, strip punctuation, collapse
 * whitespace. Street addresses render differently in every context ("1234 York
 * Rd, Towson MD 21204" vs "1234 YORK RD\nTOWSON, MD 21204"), so an exact string
 * compare would fail on formatting alone and train the operator to ignore the
 * alarm.
 */
export function normalizeAddress(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,#\-\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does the address on the page match what the operator pinned?
 *
 * Containment in EITHER direction, because the pinned value is allowed to be a
 * distinctive fragment ("1234 York Rd") while the page renders the full postal
 * address — and because the page sometimes renders a shortened form of a longer
 * pinned value. An empty pinned address never matches: that would make the
 * check vacuous.
 */
export function addressMatches(pageAddress: string | null, expected: string): boolean {
  if (!pageAddress) return false;
  const a = normalizeAddress(pageAddress);
  const b = normalizeAddress(expected);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/** Last-4 comparison, tolerant of "•••• 1234" / "ending in 1234" renderings. */
export function cardMatches(pageLast4: string | null, expected: string): boolean {
  if (!pageLast4) return false;
  const a = pageLast4.replace(/\D/g, '').slice(-4);
  const b = expected.replace(/\D/g, '').slice(-4);
  return a.length === 4 && a === b;
}

/**
 * The address + card gate (the revision's core). Runs on the checkout review
 * step, BEFORE the place-order click.
 *
 * CARD IS CHECKED FIRST and never auto-corrected. Switching a delivery address
 * is a reversible logistics decision; putting a charge on a card the operator
 * didn't name is not something an automation should ever fix for itself. A card
 * it can't read is a refusal, not a shrug — "couldn't tell which card" is the
 * one state where placing anyway is indefensible.
 *
 * ADDRESS may be auto-corrected, but only to an option BJ's is already
 * offering, and the caller must re-read and re-gate afterwards.
 */
export function evaluateSelections(
  selections: CheckoutSelections,
  expected: ExpectedSelections,
): SelectionVerdict {
  if (!expected.cardLast4 || !expected.address) {
    return {
      ok: false,
      failure: {
        stage: 'card-verify',
        detail: 'No expected card or shipping address is set in the extension. Nothing was ordered.',
      },
    };
  }

  if (selections.cardLast4 === null) {
    return {
      ok: false,
      failure: {
        stage: 'card-verify',
        detail: `Could not read which card BJ’s would charge. Nothing was ordered. (${selections.detail})`,
      },
    };
  }
  if (!cardMatches(selections.cardLast4, expected.cardLast4)) {
    return {
      ok: false,
      failure: {
        stage: 'card-verify',
        detail: `BJ’s had the card ending ${selections.cardLast4} selected, not the ${expected.cardLast4} you set. Nothing was ordered.`,
      },
    };
  }

  if (addressMatches(selections.addressText, expected.address)) {
    return { ok: true };
  }

  // Wrong (or unreadable) address — can BJ's switch to the right one?
  const option = selections.addressOptions.find((o) => addressMatches(o, expected.address));
  if (option) return { ok: false, switchToOption: option };

  return {
    ok: false,
    failure: {
      stage: 'address-verify',
      detail: selections.addressText
        ? `BJ’s would ship to "${selections.addressText.trim().replace(/\s+/g, ' ')}", not the "${expected.address}" you set, and no saved address matches. Nothing was ordered.`
        : `Could not read the BJ’s delivery address, so it could not be checked against the "${expected.address}" you set. Nothing was ordered. (${selections.detail})`,
    },
  };
}

/**
 * Stage → the sentence a human reads first. MIRRORED at the source level in
 * supabase/functions/send-order-failure-email/index.ts (`STAGE_REASON`) — the
 * edge function is a separate Deno bundle and cannot import this. If you change
 * one, change the other in the same commit (the escapeHtml / derivePushCopy
 * posture, CLAUDE.md spec 028 / spec 149).
 */
export const STAGE_REASON: Record<CheckoutStage, string> = {
  'cart-verify': 'The BJ’s cart did not match the purchase order, so nothing was ordered.',
  'cap-check': 'The BJ’s cart total was over the spend cap, so nothing was ordered.',
  'address-verify': 'BJ’s was set to ship somewhere other than your saved address, so nothing was ordered.',
  'card-verify': 'BJ’s was set to charge a card other than the one you saved, so nothing was ordered.',
  'checkout-nav': 'BJ’s checkout could not be reached or advanced, so nothing was ordered.',
  place: 'BJ’s never accepted the place-order click, so nothing was ordered.',
  confirm: 'BJ’s did not return an order number, so the order is NOT confirmed.',
  challenge: 'BJ’s showed a CAPTCHA or sign-in wall, so nothing was ordered.',
  error: 'The automation hit an unexpected error, so nothing was ordered.',
};

/** The one-line summary shown in the popup and stored as the attempt detail. */
export function failureReason(stage: CheckoutStage, detail: string): string {
  const head = STAGE_REASON[stage] ?? STAGE_REASON.error;
  return detail ? `${head} ${detail}` : head;
}

/**
 * Parse a money string off a vendor page ("$1,234.56", "Subtotal: $89.00") into
 * a number, or null when there is no confident read.
 *
 * Pure + defensive on purpose: this feeds the cap check, and a mis-parse that
 * returns a SMALL number would wave a large order through. A string with no
 * digits, or one whose parse isn't finite, returns null — which the gate treats
 * as a hard stop, not as zero.
 */
export function parseMoney(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}
