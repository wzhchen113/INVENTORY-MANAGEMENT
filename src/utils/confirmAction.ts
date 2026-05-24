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
export function confirmAction(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = 'OK',
): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
