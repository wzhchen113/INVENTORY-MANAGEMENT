// src/screens/cmd/lib/sharePo.ts — cross-platform "Share PO" I/O orchestrator.
//
// Spec 108 (D-2/D-3). The IMPURE, platform-branched sibling to the PURE
// `src/utils/poShareText.ts` builder — same split-of-concerns as the staff
// reorder pair (`src/utils/reorderExport.ts` builder + the impure
// `src/screens/staff/lib/shareReorder.ts` orchestrator). This module is
// admin-Cmd-only (the staff app gets no share affordance — spec 108 Out of
// scope), lives under `src/screens/cmd/lib/`, and makes NO Supabase call at
// all, so no `db.ts` carve-out question arises.
//
// A PO is a TEXT MESSAGE (a body), not a document. Branch (mirrors
// `shareReorder.ts`'s `Platform.OS` gate, with web split in two):
//   1. Platform.OS !== 'web' → RN `Share.share({ message })` — the honest
//      text-body primitive. `expo-sharing` is FILE-oriented (it shares a URI,
//      leaving a stray .txt in the vendor's chat), so we deliberately use RN
//      `Share` for a message body here rather than `Sharing.shareAsync`.
//      Availability is still gated via `Sharing.isAvailableAsync()` to mirror
//      the precedent's pre-flight check.  ← PINNED: RN `Share`, not expo-sharing.
//   2. Platform.OS === 'web' AND navigator.share present → `navigator.share({ text })`.
//   3. Platform.OS === 'web' AND navigator.share absent → `navigator.clipboard
//      .writeText` (D-1) + return `previewText` so the caller renders the
//      always-present, selectable text preview pane (D-3).
//
// Error posture mirrors `shareReorder.ts` verbatim: wrap the whole thing in
// try/catch, route failures to a bottom error Toast, and NEVER throw to the
// caller. A user-dismissed native/web share (`AbortError`) is swallowed as a
// non-error no-op — it must NOT fire a failure toast and must NOT trigger the
// caller's mark-as-sent prompt (returns `shared: false`).

import { Platform, Share } from 'react-native';
import Toast from 'react-native-toast-message';
import * as Sharing from 'expo-sharing';

// What the orchestrator hands back to the caller:
//   - `shared`      → true iff the share/copy step COMPLETED (a real hand-off).
//                     Gates the draft-only "Did you send it?" prompt. false on
//                     dismiss (AbortError) and on any failure.
//   - `previewText` → non-null ONLY on the desktop-web (clipboard) branch, so
//                     the caller renders the inline preview pane (D-3); null on
//                     native, mobile-web, dismiss, and failure.
export interface SharePoResult {
  shared: boolean;
  previewText: string | null;
}

export interface SharePoOpts {
  // Localized share-sheet dialog title (native only; caller resolves via T()).
  dialogTitle: string;
  // Fired on a SUCCESSFUL desktop-web clipboard write (caller shows a toast).
  onCopyToast: () => void;
  // Optional: fired when the clipboard is present but the write was BLOCKED
  // (permission/focus) — a neutral "select the text below" nudge. The preview
  // pane is already on screen either way, so this is advisory, not an error.
  onCopyBlocked?: () => void;
}

// Some browsers throw a DOMException named 'AbortError' when the user dismisses
// the share sheet. Node/jsdom may not define DOMException the same way, so we
// duck-type on the `name` property rather than `instanceof`.
function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function failureToast(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // eslint-disable-next-line no-console
  console.warn('[imr] share PO failed:', message);
  Toast.show({
    type: 'error',
    text1: 'Share failed',
    text2: message.slice(0, 120) || 'Unable to share this order',
    position: 'bottom',
    visibilityTime: 4000,
  });
}

// Desktop-web copy — web-only `navigator.clipboard.writeText` behind a runtime
// guard (D-1: no `expo-clipboard` dependency; this branch is provably
// web-only). The visible preview pane the caller renders is the always-present
// fallback, so a blocked/absent clipboard is NOT an error — it never throws.
async function copyToClipboard(text: string, opts: SharePoOpts): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      opts.onCopyToast();
    } catch {
      // Clipboard blocked (permission / focus). NOT an error toast — the
      // preview pane is already visible. Optionally nudge toward it.
      opts.onCopyBlocked?.();
    }
  } else {
    // navigator.clipboard unavailable (older browser / insecure context). Do
    // NOT silently claim success and do NOT error — the preview is the
    // fallback. A neutral nudge if the caller provided one.
    opts.onCopyBlocked?.();
  }
}

/**
 * Share a single purchase order's text body. Never throws.
 * @returns `{ shared, previewText }` — see `SharePoResult`.
 */
export async function sharePurchaseOrder(text: string, opts: SharePoOpts): Promise<SharePoResult> {
  try {
    if (Platform.OS !== 'web') {
      // ── native: OS share sheet via RN `Share` (message body, no file) ──
      // Mirror `shareReorder.ts`: gate on share-sheet availability first.
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        throw new Error('Sharing is not available on this device');
      }
      const result = await Share.share({ message: text }, { dialogTitle: opts.dialogTitle });
      // RN Share resolves with `{ action }`; a dismiss is `Share.dismissedAction`
      // (iOS). Treat a dismiss as a no-op — no prompt.
      const dismissed = result.action === Share.dismissedAction;
      return { shared: !dismissed, previewText: null };
    }

    // ── web ──
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      // mobile web (Safari / Chrome Android share API present)
      await navigator.share({ text });
      return { shared: true, previewText: null };
    }

    // desktop web (navigator.share absent) — clipboard (D-1) + preview (D-3).
    await copyToClipboard(text, opts);
    return { shared: true, previewText: text };
  } catch (err) {
    // A user-dismissed share is a no-op, NOT a failure — swallow it silently
    // and signal `shared: false` so the caller does not prompt to mark sent.
    if (isAbortError(err)) {
      return { shared: false, previewText: null };
    }
    failureToast(err);
    return { shared: false, previewText: null };
  }
}
