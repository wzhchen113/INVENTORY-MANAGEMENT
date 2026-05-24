// App.tsx — root for imr-staff.
//
// Mounts: SafeAreaProvider → ErrorBoundary → RootStack + Toast.
// On mount: migrate the queue store key (one-time per spec 062 §0 Q4)
// then hydrate the in-memory queue mirror from AsyncStorage so the
// QueueIndicator reflects items left over from a prior session.

import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { RootStack } from './src/navigation/RootStack';
import { useStore } from './src/store/useStore';
import { hydrateQueue, migrateQueueIfNeeded } from './src/lib/eodQueue';
import { notifyBackendError } from './src/lib/notifyBackendError';

export default function App() {
  const hydrateQueueFromStorage = useStore((s) => s.hydrateQueueFromStorage);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await migrateQueueIfNeeded();
        const items = await hydrateQueue();
        if (!cancelled) hydrateQueueFromStorage(items);
      } catch (err) {
        notifyBackendError('queue hydrate', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateQueueFromStorage]);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <RootStack />
      </ErrorBoundary>
      <Toast />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
