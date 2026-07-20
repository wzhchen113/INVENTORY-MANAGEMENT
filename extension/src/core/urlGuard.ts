// Spec 132 — URL scheme validation. Every order_page_url / product_page_url is
// vendor-supplied free-form text (131: nullable, no format constraint). Before
// ANY `new URL()` navigation or origin comparison the extension MUST confirm the
// value parses AND is http(s) — never `javascript:`, `data:`, `file:`, etc.
// (defense against a poisoned URL column driving a hostile navigation).

/** True iff `value` parses as an absolute URL with an http: or https: scheme. */
export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * The origin of a safe http(s) URL, or null if unsafe/unparseable. Used for the
 * vendor↔site join (matching a pending PO's order_page_url origin to the current
 * tab origin — 131 D-2 / 132 OQ-5).
 */
export function safeOrigin(value: string | null | undefined): string | null {
  if (!isSafeHttpUrl(value)) return null;
  try {
    return new URL(value as string).origin;
  } catch {
    return null;
  }
}
