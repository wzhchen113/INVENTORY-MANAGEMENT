import { Alert, Platform } from 'react-native';

// Cross-platform confirmation prompt. Web → window.confirm (synchronous,
// blocks the event loop just enough). Native → Alert.alert with a 2-button
// pattern. Caller's `onConfirm` runs only when the user picks the destructive
// option.
export function confirmAction(title: string, message: string, onConfirm: () => void): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}
