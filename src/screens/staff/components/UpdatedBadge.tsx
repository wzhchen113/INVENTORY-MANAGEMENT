// src/screens/staff/components/UpdatedBadge.tsx — spec 128.
//
// Subtle "Updated" pill shown next to the ingredient name on the EOD / Weekly
// count rows when the item's product effectively changed (photo or primary
// vendor) since the store last counted it (spec 128 §7). View-only — staff
// have no acknowledge/dismiss control; the pill clears when the store next
// counts the item.
//
// Uses the calm `info` (teal) tone — deliberately DISTINCT from the Weekly
// `LOW` warning pill (warning/amber) and from the notification RED, which is
// reserved for the notifications nudge. Self-contained so both count screens
// render a byte-identical pill (mirrors IngredientThumb). No layout shift: the
// pill keeps its intrinsic width inside the name row.

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../i18n';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';

type Props = {
  testID?: string;
};

export function UpdatedBadge({ testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const { t } = useI18n();
  const styles = useMemo(() => makeStyles(T), [T]);
  const label = t('chrome.count.updatedBadge');

  return (
    <View
      style={[styles.badge, { backgroundColor: c.infoBg, borderColor: c.info }]}
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID ?? 'updated-badge'}
    >
      <Text style={[styles.badgeText, { color: c.info }]}>{label}</Text>
    </View>
  );
}

const makeStyles = (T: StaffTokens) =>
  StyleSheet.create({
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 1,
      borderRadius: T.radius.pill,
      borderWidth: 1,
    },
    badgeText: {
      fontSize: T.typography.caption,
      fontWeight: T.typography.bold,
      letterSpacing: 0.5,
    },
  });
