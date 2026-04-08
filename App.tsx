// App.tsx
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Toast from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { useColors } from './src/theme/colors';

// Only import and configure notifications on native platforms
if (Platform.OS !== 'web') {
  const Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export default function App() {
  const C = useColors();

  useEffect(() => {
    if (Platform.OS !== 'web') {
      registerForPushNotifications();
    }
  }, []);

  // Set HTML body background for overscroll coverage on web
  useEffect(() => {
    if (Platform.OS === 'web') {
      document.documentElement.style.backgroundColor = C.bgTertiary;
      document.body.style.backgroundColor = C.bgTertiary;
    }
  }, [C.bgTertiary]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <AppNavigator />
        <Toast />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

async function registerForPushNotifications() {
  try {
    const Notifications = require('expo-notifications');
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('Push notification permission not granted');
    }
  } catch (e) {
    console.log('Notifications setup:', e);
  }
}
