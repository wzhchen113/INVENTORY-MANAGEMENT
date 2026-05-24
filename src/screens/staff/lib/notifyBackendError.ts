// src/lib/notifyBackendError.ts — central error sink.
//
// Mirrors imr-inventory's `notifyBackendError` (src/store/useStore.ts:23)
// but stripped: console.warn + an optional toast via
// react-native-toast-message. The toast surface is best-effort — if
// the Toast root isn't mounted yet, the console.warn still fires.

import Toast from 'react-native-toast-message';

export function notifyBackendError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // eslint-disable-next-line no-console
  console.warn(`[imr-staff] ${label}:`, message);
  try {
    Toast.show({
      type: 'error',
      text1: label,
      text2: message.slice(0, 120),
      position: 'bottom',
    });
  } catch {
    // Toast may not be mounted yet (very early app boot). Console
    // suffices in that case.
  }
}
