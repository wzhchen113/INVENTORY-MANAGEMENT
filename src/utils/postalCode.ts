// src/utils/postalCode.ts
//
// Spec 155 §5.1 (AC-3) — PURE, framework-free parsing/validation of a US
// postal code typed into the Cmd store drawer. Same purity discipline as
// `orderChannel.ts` / `poCaseDisplay.ts`: no React, no supabase, no theme, no
// i18n import, jest-pinned truth table.
//
// ONE validator is shared by BOTH the create and the edit path of
// `StoreFormDrawer` (AC-3). That is a DELIBERATE, spec-authorized behavior
// delta on the create path, which previously accepted any text: an invalid ZIP
// now refuses the save with an inline field error instead of storing garbage
// the `instacart-cart-link` retailers probe can never use.
//
// `null` (never `''`) is the explicit clear — it matches `db.updateStore`'s
// `updates.postalCode || null` mapping and the R-4 semantics already pinned in
// `StoreFormDrawer.test.tsx`.

/** The result of parsing operator-typed ZIP input.
 *  - `ok: true,  value: string` ⇒ a valid 5-digit ZIP (optionally +4), trimmed.
 *  - `ok: true,  value: null`   ⇒ blank/whitespace-only — an EXPLICIT clear.
 *  - `ok: false, value: null`   ⇒ invalid; the caller must NOT issue a write. */
export type PostalCodeParse =
  | { ok: true; value: string | null }
  | { ok: false; value: null };

/** 5-digit US ZIP, optionally followed by the `+4` extension. */
const US_ZIP = /^\d{5}(-\d{4})?$/;

/**
 * Trim; `''` / whitespace-only / `null` / `undefined` ⇒ `{ ok: true, value: null }`.
 * Otherwise the trimmed value must match `^\d{5}(-\d{4})?$` ⇒
 * `{ ok: true, value: <trimmed> }`. Anything else ⇒ `{ ok: false, value: null }`.
 *
 * ZIP+4 is accepted and stored VERBATIM (OQ-7) — the edge function passes
 * `postal_code` through unmodified and degrades to an advisory if the upstream
 * retailers endpoint dislikes it.
 */
export function parsePostalCode(raw: string | null | undefined): PostalCodeParse {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!US_ZIP.test(trimmed)) return { ok: false, value: null };
  return { ok: true, value: trimmed };
}
