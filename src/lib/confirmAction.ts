// src/lib/confirmAction.ts — cross-platform confirm prompt.
//
// Mirrors imr-inventory's src/utils/confirmAction.ts. Web → window.confirm,
// native → Alert.alert. The callback only fires on the destructive choice.

import { Alert, Platform } from 'react-native';

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
