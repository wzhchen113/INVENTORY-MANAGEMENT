// src/screens/DashboardScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useStore } from '../store/useStore';
import { Card, CardHeader, KpiCard, Badge, WhoChip, EmptyState } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';

const ALL_STORES_ID = '__all__';

export default function DashboardScreen() {
  const nav = useNavigation<any>();
  const {
    currentUser, currentStore, stores, inventory, wasteLog,
    eodSubmissions, getItemStatus, addStore,
  } = useStore();

  const C = useColors();

  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const isAllStores = currentStore.id === ALL_STORES_ID;
  const [showAddStore, setShowAddStore] = useState(false);
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreAddress, setNewStoreAddress] = useState('');
  const [deleteStore, setDeleteStore] = useState<typeof stores[0] | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  // Filter data — show all stores or just current
  const storeInventory = useMemo(
    () => isAllStores ? inventory : inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id, isAllStores]
  );

  const storeWaste = useMemo(
    () => isAllStores ? wasteLog : wasteLog.filter((w) => w.storeId === currentStore.id),
    [wasteLog, currentStore.id, isAllStores]
  );

  const storeEOD = useMemo(
    () => isAllStores ? eodSubmissions : eodSubmissions.filter((e) => e.storeId === currentStore.id),
    [eodSubmissions, currentStore.id, isAllStores]
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

  const foodCostPct = storeInventory.length > 0 ? 31.4 : 0;

  const handleDeleteStore = async () => {
    if (!deleteStore || deleteConfirmName !== deleteStore.name) return;
    // Delete from Supabase + local
    try {
      const { supabase } = await import('../lib/supabase');
      await supabase.from('inventory_items').delete().eq('store_id', deleteStore.id);
      await supabase.from('recipes').delete().eq('store_id', deleteStore.id);
      await supabase.from('eod_submissions').delete().eq('store_id', deleteStore.id);
      await supabase.from('waste_log').delete().eq('store_id', deleteStore.id);
      await supabase.from('stores').delete().eq('id', deleteStore.id);
    } catch {}
    // Remove from local state
    const { useStore: getStore } = require('../store/useStore');
    const state = getStore.getState();
    getStore.setState({
      stores: state.stores.filter((s: any) => s.id !== deleteStore.id),
      inventory: state.inventory.filter((i: any) => i.storeId !== deleteStore.id),
      recipes: state.recipes.filter((r: any) => r.storeId !== deleteStore.id),
    });
    // Switch to first remaining store
    const remaining = stores.filter((s) => s.id !== deleteStore.id);
    if (remaining.length > 0) {
      const { setCurrentStore } = require('../store/useStore').useStore.getState();
      setCurrentStore(remaining[0]);
    }
    setDeleteStore(null);
    setDeleteConfirmName('');
  };

  const handleAddStore = () => {
    if (!newStoreName.trim()) {
      if (Platform.OS === 'web') alert('Store name is required');
      else Alert.alert('Error', 'Store name is required');
      return;
    }
    addStore({
      name: newStoreName.trim(),
      address: newStoreAddress.trim(),
      status: 'active',
    });
    setNewStoreName('');
    setNewStoreAddress('');
    setShowAddStore(false);
  };

  return (
    <WebScrollView id="dashboard-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
      {/* Store info bar */}
      <View style={styles.storeInfoBar}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.storeTitle, { color: C.textPrimary }]}>{isAllStores ? 'All Stores' : currentStore.name}</Text>
          {!isAllStores && currentStore.address ? (
            <Text style={[styles.storeAddr, { color: C.textTertiary }]}>{currentStore.address}</Text>
          ) : null}
          {isAllStores && (
            <Text style={[styles.storeAddr, { color: C.textTertiary }]}>{stores.length} store{stores.length !== 1 ? 's' : ''} combined</Text>
          )}
        </View>
        <Text style={[styles.storeItemCount, { color: C.textTertiary }]}>
          {storeInventory.length} item{storeInventory.length !== 1 ? 's' : ''}
        </Text>
        {isAdmin && (
          <TouchableOpacity style={[styles.addStoreBtn, { backgroundColor: C.textPrimary }]} onPress={() => setShowAddStore(true)}>
            <Ionicons name="add" size={14} color={C.bgPrimary} />
            <Text style={[styles.addStoreBtnText, { color: C.bgPrimary }]}>Add store</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Store list with delete (All Stores view only) */}
      {isAllStores && isAdmin && (
        <Card>
          <CardHeader title="Stores" />
          {stores.map((store) => {
            const itemCount = inventory.filter((i) => i.storeId === store.id).length;
            return (
              <View key={store.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: C.borderLight }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '500', color: C.textPrimary }}>{store.name}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: C.textTertiary }}>{store.address || 'No address'} · {itemCount} items</Text>
                </View>
                {stores.length > 1 && (
                  <TouchableOpacity onPress={() => { setDeleteStore(store); setDeleteConfirmName(''); }}>
                    <Ionicons name="trash-outline" size={16} color={C.danger} />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </Card>
      )}

      {/* KPI Row */}
      <View style={styles.kpiRow}>
        <KpiCard
          label="Food cost %"
          value={storeInventory.length > 0 ? `${foodCostPct.toFixed(1)}%` : '—'}
          sub="Target 28–35%"
          variant="success"
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

      {/* Quick actions — placed right after KPIs for easy access */}
      <Card>
        <CardHeader title="Quick actions" />
        <View style={styles.quickActions}>
          <TouchableOpacity style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('EODCount')}>
            <Text style={[styles.qaText, { color: C.textPrimary }]}>Submit EOD count</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('WasteLog')}>
            <Text style={[styles.qaText, { color: C.textPrimary }]}>Log waste</Text>
          </TouchableOpacity>
          {isAdmin && (
            <>
              <TouchableOpacity style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('Ingredients')}>
                <Text style={[styles.qaText, { color: C.textPrimary }]}>Manage ingredients</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('POSImport')}>
                <Text style={[styles.qaText, { color: C.textPrimary }]}>Import POS CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.qa, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]} onPress={() => nav.navigate('Restock')}>
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

      {/* Add Store Modal */}
      <Modal visible={showAddStore} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
          <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
            <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Add store</Text>
            <TouchableOpacity onPress={() => setShowAddStore(false)}>
              <Text style={[styles.modalCancel, { color: C.info }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modalBody}>
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Store name *</Text>
              <TextInput
                style={[styles.formInput, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                value={newStoreName}
                onChangeText={setNewStoreName}
                placeholder="e.g. Downtown, Bel Air, Columbia"
                placeholderTextColor={C.textTertiary}
              />
            </View>
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: C.textSecondary }]}>Address</Text>
              <TextInput
                style={[styles.formInput, { borderColor: C.borderMedium, color: C.textPrimary, backgroundColor: C.bgSecondary }]}
                value={newStoreAddress}
                onChangeText={setNewStoreAddress}
                placeholder="123 Main St, City MD 21000"
                placeholderTextColor={C.textTertiary}
              />
            </View>
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: C.textPrimary }]} onPress={handleAddStore}>
              <Text style={[styles.saveBtnText, { color: C.bgPrimary }]}>Add store</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Delete Store Confirmation Modal */}
      <Modal visible={!!deleteStore} transparent animationType="fade">
        <View style={styles.confirmOverlay}>
          <View style={[styles.confirmBox, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            <Text style={[styles.confirmTitle, { color: C.danger }]}>Delete store</Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary }]}>
              This will permanently delete <Text style={{ fontWeight: '700', color: C.textPrimary }}>"{deleteStore?.name}"</Text> and all its inventory, recipes, and history. This cannot be undone.
            </Text>
            <Text style={[styles.confirmMessage, { color: C.textSecondary, marginTop: Spacing.sm }]}>
              Type the store name to confirm:
            </Text>
            <TextInput
              style={[styles.formInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, marginTop: Spacing.sm }]}
              value={deleteConfirmName}
              onChangeText={setDeleteConfirmName}
              placeholder={deleteStore?.name || ''}
              placeholderTextColor={C.textTertiary}
              autoFocus
            />
            <View style={styles.confirmBtnRow}>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: C.bgSecondary }]} onPress={() => { setDeleteStore(null); setDeleteConfirmName(''); }}>
                <Text style={[styles.confirmBtnText, { color: C.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmBtn, { backgroundColor: C.danger }, deleteConfirmName !== deleteStore?.name && { opacity: 0.3 }]}
                onPress={handleDeleteStore}
                disabled={deleteConfirmName !== deleteStore?.name}
              >
                <Text style={[styles.confirmBtnText, { color: C.bgPrimary }]}>Delete store</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </WebScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },

  // Store info
  storeInfoBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    marginBottom: Spacing.md, paddingVertical: Spacing.sm,
  },
  storeTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  storeAddr: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
  storeItemCount: { fontSize: FontSize.xs, color: Colors.textTertiary },
  addStoreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: Colors.textPrimary, borderRadius: Radius.md,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  addStoreBtnText: { color: Colors.bgPrimary, fontSize: FontSize.xs, fontWeight: '500' },

  // KPIs
  kpiRow: { flexDirection: 'row', marginBottom: Spacing.sm },

  // Alerts
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6, marginBottom: 4 },
  alertDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  alertText: { fontSize: FontSize.sm, flex: 1 },

  // Tables
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  tableName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary, flex: 1 },
  tableCell: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },
  link: { fontSize: FontSize.sm, color: Colors.info },

  // Quick actions
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  qa: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 0.5, borderColor: Colors.borderLight },
  qaText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },

  // Modal
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  modalCancel: { fontSize: FontSize.base, color: Colors.info },
  modalBody: { padding: Spacing.lg },
  formField: { marginBottom: Spacing.lg },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 6 },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center', marginTop: Spacing.sm },
  saveBtnText: { color: Colors.bgPrimary, fontSize: FontSize.base, fontWeight: '600' },
  confirmOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  confirmBox: { width: '100%', maxWidth: 400, borderRadius: Radius.xl, padding: Spacing.xl, borderWidth: 0.5 },
  confirmTitle: { fontSize: FontSize.lg, fontWeight: '600', marginBottom: Spacing.sm },
  confirmMessage: { fontSize: FontSize.sm, lineHeight: 20 },
  confirmBtnRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  confirmBtn: { flex: 1, paddingVertical: Spacing.md, borderRadius: Radius.md, alignItems: 'center' },
  confirmBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
});
