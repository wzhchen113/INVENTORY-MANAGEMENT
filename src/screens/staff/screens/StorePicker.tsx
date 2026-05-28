// src/screens/StorePicker.tsx — vertical list of stores (tap to select).
//
// Spec 062 §B4 — shown when user_stores returns >1 rows and no valid
// persisted active store. Tap navigates to EODCount via the navigation
// state machine (RootStack reads authState + activeStore to render the
// correct screen).
//
// Spec 070: an off-white field with each store as a soft card (via the
// restyled ListRow) separated by inter-card spacing, plus a trailing
// chevron to signal tap-affordance. Colors from `useStaffColors()`.

import { FlatList, StyleSheet, Text, View } from 'react-native';
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
    <View style={[styles.container, { backgroundColor: c.bg }]}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
