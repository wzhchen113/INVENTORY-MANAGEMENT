// src/screens/DashboardScreen.tsx
import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStore } from '../store/useStore';
import { Card, CardHeader, KpiCard, Badge, WhoChip, EmptyState } from '../components';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { InventoryItem } from '../types';

export default function DashboardScreen() {
  const nav = useNavigation<any>();
  const { currentUser, inventory, wasteLog, purchaseOrders, eodSubmissions,
          getLowStockItems, getInventoryValue, getItemStatus } = useStore();

  const isAdmin = currentUser?.role === 'admin';
  const lowItems = getLowStockItems();
  const inventoryValue = getInventoryValue();
  const wasteValue = wasteLog.reduce((s, e) => s + e.quantity * e.costPerUnit, 0);
  const openPOs = purchaseOrders.filter((p) => p.status !== 'received');

  const expiringItems = inventory.filter(
    (i) => i.expiryDate && i.expiryDate.length > 0
  );

  const userColors: Record<string, string> = {
    'Maria G.': Colors.userMaria,
    'James T.': Colors.userJames,
    'Admin': Colors.userAdmin,
    'Ana R.': Colors.userAna,
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* KPI Row */}
      <View style={styles.kpiRow}>
        <KpiCard label="Food cost %" value="31.4%" sub="Target 28–35%" variant="success" />
        <View style={{ width: Spacing.sm }} />
        <KpiCard label="Waste value" value={`$${wasteValue.toFixed(0)}`} sub="This week" variant="warning" />
      </View>
      <View style={styles.kpiRow}>
        <KpiCard label="Low / out of stock" value={String(lowItems.length)} sub="items need attention" variant={lowItems.length > 0 ? 'danger' : 'success'} />
        <View style={{ width: Spacing.sm }} />
        <KpiCard label="Inventory value" value={`$${inventoryValue.toFixed(0)}`} sub="on hand" />
      </View>

      {/* Alerts */}
      {lowItems.length > 0 && (
        <Card>
          <CardHeader title="Stock alerts" right={
            <TouchableOpacity onPress={() => nav.navigate('Items')}>
              <Text style={styles.link}>View all</Text>
            </TouchableOpacity>
          } />
          {lowItems.slice(0, 5).map((item) => {
            const status = getItemStatus(item);
            return (
              <View key={item.id} style={[styles.alertRow, { backgroundColor: status === 'out' ? Colors.dangerBg : Colors.warningBg }]}>
                <View style={[styles.alertDot, { backgroundColor: status === 'out' ? Colors.danger : Colors.warning }]} />
                <Text style={[styles.alertText, { color: status === 'out' ? Colors.danger : Colors.warning }]}>
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
            <View key={item.id} style={[styles.alertRow, { backgroundColor: Colors.warningBg }]}>
              <View style={[styles.alertDot, { backgroundColor: Colors.warning }]} />
              <Text style={[styles.alertText, { color: Colors.warning }]}>
                <Text style={{ fontWeight: '600' }}>{item.name}</Text>{' — '}expires {item.expiryDate}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {/* EOD Submissions */}
      <Card>
        <CardHeader title="Today's EOD submissions" right={
          <TouchableOpacity onPress={() => nav.navigate('EODCount')}>
            <Text style={styles.link}>{isAdmin ? 'View' : 'Submit'}</Text>
          </TouchableOpacity>
        } />
        {[
          { name: 'Maria G.', store: 'Towson', items: 15, time: '4:12 PM', status: 'ok', color: Colors.userMaria },
          { name: 'James T.', store: 'Towson', items: 15, time: '4:31 PM', status: 'ok', color: Colors.userJames },
          { name: 'Ana R.', store: 'Baltimore', items: 0, time: '—', status: 'pending', color: Colors.userAna },
        ].map((row) => (
          <View key={row.name} style={styles.tableRow}>
            <WhoChip name={row.name} color={row.color} />
            <Text style={styles.tableCell}>{row.store}</Text>
            <Text style={styles.tableCell}>{row.items > 0 ? `${row.items} items` : '—'}</Text>
            <Text style={styles.tableCell}>{row.time}</Text>
            <Badge label={row.status === 'ok' ? 'Done' : 'Pending'} variant={row.status as any} />
          </View>
        ))}
      </Card>

      {/* Open POs — admin only */}
      {isAdmin && (
        <Card>
          <CardHeader title="Open purchase orders" right={
            <TouchableOpacity onPress={() => nav.navigate('PurchaseOrders')}>
              <Text style={styles.link}>View all</Text>
            </TouchableOpacity>
          } />
          {openPOs.length === 0 ? (
            <EmptyState message="No open purchase orders" />
          ) : (
            openPOs.map((po) => (
              <View key={po.id} style={styles.tableRow}>
                <Text style={[styles.tableName, { flex: 1.5 }]}>{po.vendorName}</Text>
                <Text style={styles.tableCell}>${po.totalCost.toFixed(0)}</Text>
                <Text style={styles.tableCell}>{po.expectedDelivery}</Text>
                <Badge label={po.status.charAt(0).toUpperCase() + po.status.slice(1)} variant={po.status as any} />
              </View>
            ))
          )}
        </Card>
      )}

      {/* Quick actions */}
      <Card>
        <CardHeader title="Quick actions" />
        <View style={styles.quickActions}>
          <TouchableOpacity style={styles.qa} onPress={() => nav.navigate('EODCount')}>
            <Text style={styles.qaText}>Submit EOD count</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.qa} onPress={() => nav.navigate('WasteLog')}>
            <Text style={styles.qaText}>Log waste</Text>
          </TouchableOpacity>
          {isAdmin && (
            <>
              <TouchableOpacity style={styles.qa} onPress={() => nav.navigate('POSImport')}>
                <Text style={styles.qaText}>Import POS CSV</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.qa} onPress={() => nav.navigate('Restock')}>
                <Text style={styles.qaText}>Restock report</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },
  kpiRow: { flexDirection: 'row', marginBottom: Spacing.sm },
  alertRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6, marginBottom: 4 },
  alertDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  alertText: { fontSize: FontSize.sm, flex: 1 },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  tableName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary, flex: 1 },
  tableCell: { fontSize: FontSize.sm, color: Colors.textSecondary, flex: 1 },
  link: { fontSize: FontSize.sm, color: Colors.info },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  qa: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 0.5, borderColor: Colors.borderLight },
  qaText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },
});
