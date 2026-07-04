import { Alert, Platform } from 'react-native';

// Cross-platform confirmation prompt. Web → window.confirm (synchronous,
// blocks the event loop just enough). Native → Alert.alert with a 2-button
// pattern. Caller's `onConfirm` runs only when the user picks the destructive
// option.
//
// Spec 063 — `confirmLabel` was added so the merged staff app's sign-out
// confirm can show "Sign out" instead of "Delete" on native. Defaults to
// `'OK'` so non-destructive new callers get sensible copy; existing
// destructive admin callers (delete-recipe, delete-ingredient, etc.) pass
// an explicit `'Delete'` to preserve the prior on-screen label.
//
// Spec 109 — optional `onCancel` fires when the user declines (Cancel button,
// web-confirm "Cancel", or Android back/outside dismiss via onDismiss — button
// presses do NOT also trigger onDismiss). Callers that hold UI state across the
// native async dialog window (e.g. a busy flag disabling the triggering button)
// need it to release that state on decline.
export function confirmAction(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = 'OK',
  onCancel?: () => void,
): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    } else {
      onCancel?.();
    }
    return;
  }
  Alert.alert(
    title,
    message,
    [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: confirmLabel, style: 'destructive', onPress: onConfirm },
    ],
    onCancel ? { cancelable: true, onDismiss: onCancel } : undefined,
  );
}
