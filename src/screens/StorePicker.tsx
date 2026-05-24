// src/screens/StorePicker.tsx — vertical list of stores (tap to select).
//
// Spec 062 §B4 — shown when user_stores returns >1 rows and no valid
// persisted active store. Tap navigates to EODCount via the navigation
// state machine (RootStack reads authState + activeStore to render the
// correct screen).

import { FlatList, StyleSheet, Text, View } from 'react-native';
import { ListRow } from '../components/ListRow';
import { selectStores, useStore } from '../store/useStore';
import { t } from '../i18n';
import { colors, spacing, typography } from '../theme';
import type { UserStore } from '../lib/types';

export function StorePicker() {
  const stores = useStore(selectStores);
  const setActiveStore = useStore((s) => s.setActiveStore);

  const onSelect = (store: UserStore) => {
    setActiveStore({ id: store.storeId, name: store.storeName });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {t('store.picker.title')}
        </Text>
        <Text style={styles.subtitle}>
          {t('store.picker.subtitle', { count: stores.length })}
        </Text>
      </View>
      <FlatList
        data={stores}
        keyExtractor={(item) => item.storeId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <ListRow
            onPress={() => onSelect(item)}
            testID={`store-row-${item.storeId}`}
            accessibilityLabel={`Select store ${item.storeName}`}
            leading={
              <Text style={styles.rowText} numberOfLines={1}>
                {item.storeName}
              </Text>
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
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  title: {
    fontSize: typography.headline,
    fontWeight: typography.bold,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: typography.body,
    color: colors.textSecondary,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  rowText: {
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
    color: colors.text,
  },
});
