// src/utils/openExternalUrl.ts — spec 149 review round (code-reviewer Should-fix
// + security-auditor Medium 1).
//
// ONE cross-platform "open a stored, operator-editable URL" helper, shared by
// the two call sites that had drifted apart:
//   • `openExternalOrderUrl` in src/store/useStore.ts (webstaurant channel →
//     `vendors.order_page_url`; instacart channel → the minted cart link)
//   • `openInNewContext` in the phone Approve Order screen (RE-OPEN LINK →
//     `order_approvals.external_ref`)
// The screen copy previously had NO `.catch` on the native `Linking.openURL`
// promise, so a native open failure became an unhandled rejection with zero
// user feedback while the store copy toasted correctly. Sharing one helper is
// what stops the two from drifting on error handling again.
//
// SECURITY (security-auditor Medium 1): both sources are operator-writable
// under RLS, not server-minted, so the scheme is an ALLOWLIST — only
// `http://` / `https://` are ever handed to `window.open` / `Linking.openURL`.
// A planted `javascript:` / `data:` / `file:` / custom-scheme value is refused
// here and surfaced through the caller's `notifyBackendError`, never opened.
// `noopener,noreferrer` (reverse-tabnabbing) is kept on the web branch.
//
// Deliberately toast-free: `src/utils/` stays pure of the toast surface, so the
// caller passes its own reporter (the store's module-local
// `notifyBackendError`), matching how `confirmAction` keeps its own boundary.

import { Platform, Linking } from 'react-native';

/** How a refusal / native failure is reported. Structurally identical to the
 *  store's `notifyBackendError(action, e)` so it can be passed verbatim. */
export type ExternalUrlErrorReporter = (action: string, e: unknown) => void;

/**
 * PURE. `true` only for an absolute `http://` / `https://` URL.
 *
 * Leading/trailing whitespace is tolerated (operators paste), everything else
 * is rejected: protocol-relative (`//host`), scheme-less (`example.com`),
 * `javascript:`, `data:`, `file:`, `tel:`, `intent:`, app deep links, and any
 * non-string value.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\/\S/i.test(url.trim());
}

/**
 * Open an external URL in the user's own session — a new tab on web, the OS
 * handler on native. NOTHING is ever checked out on the user's behalf; this
 * only ever navigates.
 *
 * Returns `true` when the open was dispatched, `false` when the URL was refused
 * by the scheme allowlist (caller may branch on it — e.g. the webstaurant
 * channel refuses instead of half-approving an order it never opened). A native
 * open that is dispatched but later REJECTS reports through `onError`
 * asynchronously; the return value is still `true`.
 */
export function openExternalUrl(
  url: unknown,
  action: string,
  onError: ExternalUrlErrorReporter,
): boolean {
  if (!isSafeExternalUrl(url)) {
    onError(action, new Error('Blocked a link that is not an http(s) URL'));
    return false;
  }
  const safe = url.trim();
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.open(safe, '_blank', 'noopener,noreferrer');
    return true;
  }
  void Linking.openURL(safe).catch((e: unknown) => onError(action, e));
  return true;
}
