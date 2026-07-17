// src/screens/staff/components/SettingsGear.tsx — the gear (⚙) button that
// opens the consolidated staff Settings screen.
//
// Spec 126. There is NO shared in-store header, so this small self-contained
// control is dropped into each of the four in-store screens' header rows
// (EODCount / Reorder / WeeklyCount / Receiving). It owns its own
// `useNavigation` so a screen only needs to render `<SettingsGear />` — the
// `navigation.navigate('Settings')` call bubbles from the nested tab navigator
// up to the parent stack where the `Settings` Stack.Screen is registered.

import { useMemo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import { useI18n } from '../i18n';

type Props = {
  testID?: string;
};

export function SettingsGear({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const navigation = useNavigation<{ navigate: (screen: string) => void }>();

  return (
    <Pressable
      onPress={() => navigation.navigate('Settings')}
      testID={testID ?? 'staff-settings-gear'}
      accessibilityRole="button"
      accessibilityLabel={t('chrome.settings.gearAria')}
      style={({ pressed }) => [
        styles.gear,
        pressed ? { backgroundColor: c.surfaceAlt } : null,
      ]}
    >
      <Ionicons name="settings-outline" size={22} color={c.textSecondary} />
    </Pressable>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  gear: {
    minHeight: T.touchTarget.min,
    minWidth: T.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: T.radius.sm,
  },
});
