// src/screens/DashboardScreen.tsx
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { useStore } from '../store/useStore';
import { Card, CardHeader, KpiCard, EmptyState } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { TimezoneBar } from '../components/TimezoneBar';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { computeEODStatus, EODStatus } from '../utils/eodStatus';
import { getBusinessTodayParts } from '../utils/businessDay';
import * as db from '../lib/db';
import { Store, EODSubmission } from '../types';

export default function DashboardScreen() {
  const nav = useNavigation<any>();
  const {
    currentUser, currentStore, stores, inventory, wasteLog,
    eodSubmissions, posImports, recipes, getRecipeCost,
    getItemStatus, timezone, users, setCurrentStore,
  } = useStore();

  const C = useColors();

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';

  // Stores this user can see — drives the EOD overview row count.
  const accessibleStores = useMemo(
    () => isAdmin
      ? stores
      : stores.filter((s) => currentUser?.stores.includes(s.id)),
    [isAdmin, stores, currentUser?.stores]
  );

  // Per-store data — currentStore is always a real store now (no __all__).
  const storeInventory = useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id]
  );

  const storeWaste = useMemo(
    () => wasteLog.filter((w) => w.storeId === currentStore.id),
    [wasteLog, currentStore.id]
  );

  const lowItems = useMemo(
    () => storeInventory.filter((i) => {
      const s = getItemStatus(i);
      return s === 'low' || s === 'out';
    }),
    [storeInventory, getItemStatus]
  );

  const inventoryValue = useMemo(
    () => storeInventory.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0),
    [storeInventory]
  );

  const wasteValue = useMemo(
    () => storeWaste.reduce((sum, e) => sum + e.quantity * e.costPerUnit, 0),
    [storeWaste]
  );

  const expiringItems = useMemo(
    () => storeInventory.filter((i) => i.expiryDate && i.expiryDate.length > 0),
    [storeInventory]
  );

  // Real food cost % for the focal store, this week. COGS / sales.
  // Falls back to null (rendered as "—") when there are no POS imports for
  // the period — better honest empty than the old hardcoded 31.4%.
  const foodCostPct = useMemo(() => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const cutoffISO = sevenDaysAgo.toISOString().slice(0, 10);
    let cogs = 0, sales = 0;
    for (const imp of posImports) {
      if (imp.storeId !== currentStore.id) continue;
      if (imp.date && imp.date < cutoffISO) continue;
      for (const sale of imp.items) {
        sales += sale.revenue;
        if (sale.recipeId) {
          const recipe = recipes.find((r) => r.id === sale.recipeId);
          if (recipe) cogs += getRecipeCost(recipe.id) * sale.qtySold;
        }
      }
    }
    if (sales <= 0) return null;
    return (cogs / sales) * 100;
  }, [posImports, recipes, currentStore.id, getRecipeCost]);

  // Today's EOD submissions across every accessible store. Loaded from the DB
  // because state.eodSubmissions only holds the focal store's rows.
  const [fleetEODs, setFleetEODs] = useState<EODSubmission[]>([]);
  const today = useMemo(() => getBusinessTodayParts(timezone || 'America/New_York'), [timezone]);

  const refreshFleet = useCallback(async () => {
    if (accessibleStores.length === 0) return;
    const rows = await db.fetchTodaysEODForStores(
      accessibleStores.map((s) => s.id),
      today.dateISO,
    );
    setFleetEODs(rows as EODSubmission[]);
  }, [accessibleStores, today.dateISO]);

  useEffect(() => { refreshFleet(); }, [refreshFleet]);
  // Also re-pull when state.eodSubmissions changes — that's the realtime
  // signal that something landed for the focal store. Cheap to refetch.
  useEffect(() => { refreshFleet(); }, [eodSubmissions.length, refreshFleet]);

  const handleRemind = useCallback(async (store: Store) => {
    const targets = users.filter((u) =>
      u.id !== currentUser?.id &&
      (u.role === 'admin' || u.role === 'master' || u.stores.includes(store.id))
    );
    const message = `Reminder: ${store.name} EOD count not submitted yet.`;
    if (targets.length === 0) {
      Toast.show({ type: 'info', text1: 'No teammates to remind for this store', visibilityTime: 1500 });
      return;
    }
    await Promise.all(
      targets.map((u) => db.createNotification(u.id, message).catch(() => null))
    );
    Toast.show({ type: 'success', text1: `Reminder sent to ${targets.length}`, visibilityTime: 1500 });
  }, [users, currentUser?.id]);

  const handleViewStore = useCallback((store: Store) => {
    if (store.id !== currentStore.id) setCurrentStore(store);
    nav.navigate('EODHistory');
  }, [currentStore.id, setCurrentStore, nav]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
      <WebScrollView id="dashboard-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>

      {/* Page header — title left, scope pill right */}
      <View style={styles.storeInfoBar}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.storeTitle, { color: C.textPrimary }]}>
            Dashboard · <Text style={{ color: C.textSecondary }}>{currentStore.name}</Text>
          </Text>
          {currentStore.address ? (
            <Text style={[styles.storeAddr, { color: C.textTertiary }]}>{currentStore.address}</Text>
          ) : null}
        </View>
        <View style={[styles.scopePill, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
          <View style={[styles.scopeDot, { backgroundColor: C.info }]} />
          <Text style={[styles.scopeText, { color: C.textSecondary }]}>
            {isAdmin ? 'Admin' : 'Staff'} · {accessibleStores.length === 1 ? `${accessibleStores[0].name}` : `${accessibleStores.length} stores`}
          </Text>
        </View>
      </View>

      {/* KPI Row */}
      <View style={styles.kpiRow}>
        <KpiCard
          label="Food cost %"
          value={foodCostPct !== null ? `${foodCostPct.toFixed(1)}%` : '—'}
          sub={foodCostPct !== null ? 'Target 28–35%' : 'No POS imports this week'}
          variant={foodCostPct !== null && foodCostPct >= 28 && foodCostPct <= 35 ? 'success' : 'default'}
        />
        <View style={{ width: Spacing.sm }} />
        <KpiCard
          label="Waste value"
          value={`$${wasteValue.toFixed(0)}`}
          sub="This week"
          variant={wasteValue > 0 ? 'warning' : 'default'}
        />
      </View>
      <View style={styles.kpiRow}>
        <KpiCard
          label="Low / out of stock"
          value={String(lowItems.length)}
          sub="items need attention"
          variant={lowItems.length > 0 ? 'danger' : 'success'}
        />
        <View style={{ width: Spacing.sm }} />
        <KpiCard
          label="Inventory value"
          value={`$${inventoryValue.toFixed(0)}`}
          sub="on hand"
        />
      </View>

      {/* EOD overview — every accessible store, tonight's status */}
      <Card>
        <CardHeader
          title="EOD counts · tonight"
          right={
            <TouchableOpacity onPress={() => nav.navigate('EODCount')}>
              <Text style={[styles.link, { color: C.info }]}>Open EOD →</Text>
            </TouchableOpacity>
          }
        />
        {accessibleStores.map((store) => (
          <EODRow
            key={store.id}
            store={store}
            inventory={inventory}
            fleetEODs={fleetEODs}
            timezone={timezone || 'America/New_York'}
            onView={() => handleViewStore(store)}
            onRemind={() => handleRemind(store)}
          />
        ))}
        {accessibleStores.length === 0 && (
          <EmptyState message="No stores assigned to your account." />
        )}
      </Card>

      {/* Quick actions */}
      <Card>
        <CardHeader title="Quick actions" />
        <View style={styles.quickActions}>
          <TouchableOpacity testID="quick-action-eod-count" style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('EODCount')}>
            <Text style={[styles.qaText, { color: C.textPrimary }]}>Submit EOD count</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="quick-action-waste-log" style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('WasteLog')}>
            <Text style={[styles.qaText, { color: C.textPrimary }]}>Log waste</Text>
          </TouchableOpacity>
          {isAdmin && (
            <>
              <TouchableOpacity testID="quick-action-ingredients" style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('Ingredients')}>
                <Text style={[styles.qaText, { color: C.textPrimary }]}>Manage ingredients</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="quick-action-pos-import" style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('POSImport')}>
                <Text style={[styles.qaText, { color: C.textPrimary }]}>Import POS CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="quick-action-restock" style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('Restock')}>
                <Text style={[styles.qaText, { color: C.textPrimary }]}>Restock report</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </Card>

      {/* Stock alerts */}
      {lowItems.length > 0 && (
        <Card>
          <CardHeader title="Stock alerts" right={
            <TouchableOpacity onPress={() => nav.navigate('Items')}>
              <Text style={[styles.link, { color: C.info }]}>View all</Text>
            </TouchableOpacity>
          } />
          {lowItems.slice(0, 5).map((item) => {
            const status = getItemStatus(item);
            return (
              <View key={item.id} style={[styles.alertRow, { backgroundColor: status === 'out' ? C.dangerBg : C.warningBg }]}>
                <View style={[styles.alertDot, { backgroundColor: status === 'out' ? C.danger : C.warning }]} />
                <Text style={[styles.alertText, { color: status === 'out' ? C.danger : C.warning }]}>
                  <Text style={{ fontWeight: '600' }}>{item.name}</Text>
                  {' — '}{item.currentStock} {item.unit} left (par: {item.parLevel})
                </Text>
              </View>
            );
          })}
        </Card>
      )}

      {/* Expiring soon */}
      {expiringItems.length > 0 && (
        <Card>
          <CardHeader title="Expiring soon" />
          {expiringItems.map((item) => (
            <View key={item.id} style={[styles.alertRow, { backgroundColor: C.warningBg }]}>
              <View style={[styles.alertDot, { backgroundColor: C.warning }]} />
              <Text style={[styles.alertText, { color: C.warning }]}>
                <Text style={{ fontWeight: '600' }}>{item.name}</Text>{' — '}expires {item.expiryDate}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {/* Empty store */}
      {storeInventory.length === 0 && (
        <Card>
          <EmptyState message={`No inventory for ${currentStore.name} yet. Go to Ingredients to add items.`} />
        </Card>
      )}

      <View style={{ height: 40 }} />

      </WebScrollView>
    </View>
  );
}

// ─── EOD overview row ────────────────────────────────────────────
// One row per accessible store. Layout collapses to stacked on narrow widths
// via flexWrap on the outer row; the action button always wraps to the right.

interface EODRowProps {
  store: Store;
  inventory: { storeId: string; currentStock: number; costPerUnit: number }[];
  fleetEODs: EODSubmission[];
  timezone: string;
  onView: () => void;
  onRemind: () => void;
}

function EODRow({ store, inventory, fleetEODs, timezone, onView, onRemind }: EODRowProps) {
  const C = useColors();

  const result = computeEODStatus(store, fleetEODs, timezone);

  const totalItems = inventory.filter((i) => i.storeId === store.id).length;
  const submitted = result.status === 'submitted';

  // Inventory value only meaningful when EOD just landed — otherwise the
  // numbers are stale relative to tonight's actual state.
  const invValue = submitted
    ? inventory
        .filter((i) => i.storeId === store.id)
        .reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0)
    : null;

  const initials = store.name
    .split(/\s+/).filter(Boolean)
    .map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const avatarColor = colorForString(store.id);

  return (
    <View style={[eodStyles.row, { borderBottomColor: C.borderLight }]}>
      {/* Avatar + name */}
      <View style={eodStyles.nameCell}>
        <View style={[eodStyles.avatar, { backgroundColor: avatarColor + '33' }]}>
          <Text style={[eodStyles.avatarText, { color: avatarColor }]}>{initials}</Text>
        </View>
        <View style={{ flexShrink: 1 }}>
          <Text style={[eodStyles.storeName, { color: C.textPrimary }]} numberOfLines={1}>{store.name}</Text>
          <Text style={[eodStyles.storeSub, { color: C.textTertiary }]} numberOfLines={1}>
            Closing{result.submitter ? ` · ${result.submitter}` : ''}
          </Text>
        </View>
      </View>

      {/* Status badge */}
      <View style={eodStyles.statusCell}>
        <StatusBadge status={result.status} />
        {result.status === 'submitted' && result.submittedAt ? (
          <Text style={[eodStyles.statusSub, { color: C.textTertiary }]}>{result.submittedAt}</Text>
        ) : null}
        {result.status === 'late' && result.overdueMinutes > 0 ? (
          <Text style={[eodStyles.statusSub, { color: C.textTertiary }]}>overdue {result.overdueMinutes}m</Text>
        ) : null}
        {result.status === 'missing' ? (
          <Text style={[eodStyles.statusSub, { color: C.textTertiary }]}>no submission</Text>
        ) : null}
      </View>

      {/* Items counted */}
      <View style={eodStyles.itemsCell}>
        <Text style={[eodStyles.itemsText, { color: C.textSecondary }]}>
          {result.itemsCounted}/{totalItems}
        </Text>
      </View>

      {/* Inv value */}
      <View style={eodStyles.valueCell}>
        <Text style={[eodStyles.valueText, { color: submitted ? C.textPrimary : C.textTertiary }]}>
          {invValue !== null ? `$${invValue.toFixed(0)}` : '—'}
        </Text>
      </View>

      {/* Action */}
      <View style={eodStyles.actionCell}>
        {result.status === 'submitted' && (
          <TouchableOpacity onPress={onView}>
            <Text style={[eodStyles.actionText, { color: C.info }]}>View →</Text>
          </TouchableOpacity>
        )}
        {result.status === 'pending' && (
          <Text style={[eodStyles.actionText, { color: C.textTertiary }]}>Watching</Text>
        )}
        {(result.status === 'late' || result.status === 'missing') && (
          <TouchableOpacity onPress={onRemind}>
            <Text style={[eodStyles.actionText, { color: C.info }]}>Remind →</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function StatusBadge({ status }: { status: EODStatus }) {
  const C = useColors();
  const map: Record<EODStatus, { fg: string; bg: string; label: string }> = {
    submitted: { fg: C.statusGreen,  bg: C.statusGreenBg,  label: 'Submitted' },
    pending:   { fg: C.statusBlue,   bg: C.statusBlueBg,   label: 'In progress' },
    late:      { fg: C.statusOrange, bg: C.statusOrangeBg, label: 'Late' },
    missing:   { fg: C.statusRed,    bg: C.statusRedBg,    label: 'Missing' },
  };
  const { fg, bg, label } = map[status];
  return (
    <View style={[eodStyles.badge, { backgroundColor: bg }]}>
      <View style={[eodStyles.badgeDot, { backgroundColor: fg }]} />
      <Text style={[eodStyles.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

// Stable per-string color from the user palette so each store gets a
// consistent avatar tint across renders.
function colorForString(s: string): string {
  const palette = ['#378ADD', '#1D9E75', '#D85A30', '#D4537E', '#7F77DD', '#BA7517'];
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },

  // Page header
  storeInfoBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    marginBottom: Spacing.md, paddingVertical: Spacing.sm,
    flexWrap: 'wrap',
  },
  storeTitle: { fontSize: FontSize.xl, fontWeight: '600' },
  storeAddr: { fontSize: FontSize.xs, marginTop: 2 },

  scopePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5,
    borderWidth: 0.5, borderRadius: Radius.round,
  },
  scopeDot: { width: 6, height: 6, borderRadius: 3 },
  scopeText: { fontSize: FontSize.xs, fontWeight: '500' },

  // KPIs
  kpiRow: { flexDirection: 'row', marginBottom: Spacing.sm },

  // Alerts
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6, marginBottom: 4 },
  alertDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  alertText: { fontSize: FontSize.sm, flex: 1 },

  link: { fontSize: FontSize.sm, color: Colors.info },

  // Quick actions
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  qa: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 0.5, borderColor: Colors.borderLight },
  qaText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },
});

const eodStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, gap: Spacing.sm,
    borderBottomWidth: 0.5,
    flexWrap: 'wrap',
  },
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 2, minWidth: 180 },
  avatar: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: FontSize.xs, fontWeight: '700' },
  storeName: { fontSize: FontSize.base, fontWeight: '600' },
  storeSub: { fontSize: FontSize.xs },

  statusCell: { flex: 1, minWidth: 110, gap: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.round },
  badgeDot: { width: 5, height: 5, borderRadius: 2.5 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  statusSub: { fontSize: FontSize.xs },

  itemsCell: { flex: 1, minWidth: 70 },
  itemsText: { fontSize: FontSize.sm, fontVariant: ['tabular-nums' as any] },

  valueCell: { flex: 1, minWidth: 70 },
  valueText: { fontSize: FontSize.sm, fontWeight: '500', fontVariant: ['tabular-nums' as any] },

  actionCell: { minWidth: 80, alignItems: 'flex-end' },
  actionText: { fontSize: FontSize.sm, fontWeight: '500' },
});
