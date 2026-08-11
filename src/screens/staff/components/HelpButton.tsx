// src/screens/staff/components/HelpButton.tsx — Spec 158 §4.
//
// A direct structural mirror of `SettingsGear`: there is NO shared in-store
// header on the staff surface, so this small self-contained control is dropped
// into each screen's header row. It owns its own `useNavigation`, so a screen
// only renders `<HelpButton topicId="EODCount" />` and the
// `navigation.navigate('Guide', { topicId })` call bubbles from the nested tab
// navigator up to the parent stack where the `Guide` Stack.Screen lives.
//
// Icon-only (`help-circle-outline`) to keep the 375px header row from pushing
// `SettingsGear` or the store name out — the gear already carries a text label.
//
// Spec-063 isolation: staff-local tokens (`useStaffTokens`) + the staff
// catalog (`useI18n`) only. `useStaffStore` is NOT read — the Guide is static
// documentation with no store scope, which is exactly what lets the `Guide`
// screen be registered in the pre-active-store navigator branch too (§0 C-5).

import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';
import { useI18n } from '../i18n';

type Props = {
  /** The staff guide topic this screen documents — e.g. 'EODCount'. Always a
   *  LITERAL at the call site; an unknown id falls back to the index rather
   *  than throwing (`findGuideTopic` returns null). */
  topicId: string;
  testID?: string;
};

export function HelpButton({ topicId, testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const navigation = useNavigation<{
    navigate: (screen: string, params?: { topicId?: string }) => void;
  }>();

  return (
    <Pressable
      onPress={() => navigation.navigate('Guide', { topicId })}
      testID={testID ?? 'staff-guide-help-button'}
      accessibilityRole="button"
      accessibilityLabel={t('guide.helpAria')}
      // AC-13 wants a ≥44×44 target, but the staff surface's own density pass
      // put `touchTarget.min` at 24 at scale x1 (SettingsGear, ListRow and the
      // rest of the surface all sit on that token). Hard-coding 44 here would
      // render a control visibly larger than the gear beside it. So the VISUAL
      // box follows the token and `hitSlop` carries the touch box the rest of
      // the way to 44 — which is what AC-13 is actually protecting. At larger
      // scales the token already exceeds 44 and the slop is simply extra room.
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={({ pressed }) => [
        styles.button,
        pressed ? { backgroundColor: c.surfaceAlt } : null,
      ]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name="help-circle-outline" size={22} color={c.textSecondary} />
      </View>
    </Pressable>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  button: {
    minHeight: T.touchTarget.min,
    minWidth: T.touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: T.radius.sm,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
