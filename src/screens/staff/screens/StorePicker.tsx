// src/screens/staff/screens/StorePicker.tsx — vertical list of stores (tap to select).
//
// Spec 062 §B4 — shown when user_stores returns >1 rows and no valid
// persisted active store. Tap navigates to EODCount via the navigation
// state machine (RootStack reads authState + activeStore to render the
// correct screen).
//
// Spec 070: an off-white field with each store as a soft card (via the
// restyled ListRow) separated by inter-card spacing, plus a trailing
// chevron to signal tap-affordance. Colors from `useStaffColors()`.
//
// Spec 071: root element is `SafeAreaView` from
// `react-native-safe-area-context` with `edges={['top', 'bottom']}` so the
// title row sits below the device status bar / notch and the last list row
// sits above the home indicator. Mirrors EODCount.tsx:390. The App-level
// SafeAreaProvider in App.tsx:336 supplies the insets; do NOT nest another
// provider here — it would shadow the outer one and zero the insets.

import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ListRow } from '../components/ListRow';
import { selectStaffStores, useStaffStore } from '../store/useStaffStore';
import { t } from '../i18n';
import { spacing, typography, useStaffColors } from '../theme';
import type { UserStore } from '../lib/types';

export function StorePicker() {
  const c = useStaffColors();
  const stores = useStaffStore(selectStaffStores);
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  const onSelect = (store: UserStore) => {
    setActiveStore({ id: store.storeId, name: store.storeName });
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bg }]}
      edges={['top', 'bottom']}
      testID="store-picker-root"
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
          {t('store.picker.title')}
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          {t('store.picker.subtitle', { count: stores.length })}
        </Text>
      </View>
      <FlatList
        data={stores}
        keyExtractor={(item) => item.storeId}
        // flex: 1 keeps the list as the scroll container under the
        // SafeAreaView (symmetry with EODCount's items list). With only
        // a couple of stores this is invisible; with more it prevents
        // body-scroll on web / overflow on native.
        style={styles.listBody}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => (
          <ListRow
            onPress={() => onSelect(item)}
            testID={`store-row-${item.storeId}`}
            accessibilityLabel={`Select store ${item.storeName}`}
            leading={
              <Text style={[styles.rowText, { color: c.text }]} numberOfLines={1}>
                {item.storeName}
              </Text>
            }
            trailing={
              <Text style={[styles.chevron, { color: c.textTertiary }]}>›</Text>
            }
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    // Absolute-fill the React Navigation card (the nearest positioned
    // ancestor) instead of `flex: 1`. See EODCount.tsx#container for
    // the full rationale — same shape, same reason. With only a couple
    // of stores this is invisible today; the symmetry keeps it
    // bulletproof if Towson/Frederick grow.
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  title: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: typography.body,
  },
  listBody: {
    flex: 1,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  separator: {
    height: spacing.md,
  },
  rowText: {
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
  },
  chevron: {
    fontSize: typography.headline,
    fontWeight: typography.regular,
  },
});
