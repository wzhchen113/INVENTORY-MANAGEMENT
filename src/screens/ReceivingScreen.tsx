// src/screens/ReceivingScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';

export default function ReceivingScreen() {
  const nav = useNavigation();
  const { purchaseOrders, receivePO, currentUser } = useStore();
  const [received, setReceived] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  // Find the most recently sent PO
  const po = purchaseOrders.find((p) => p.status === 'sent');

  if (!po) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No pending deliveries</Text>
        <Text style={styles.emptySub}>All purchase orders have been received or are still in draft.</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => nav.goBack()}>
          <Text style={styles.backBtnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleConfirm = () => {
    const hasAny = po.items.some((item) => received[item.itemId] !== undefined);
    if (!hasAny) {
      Alert.alert('No quantities entered', 'Enter received quantities for at least one item before confirming.');
      return;
    }

    Alert.alert(
      'Confirm delivery',
      `This will update stock levels for all items and mark ${po.poNumber} as received. Cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => {
            const receivedItems = po.items.map((item) => ({
              itemId: item.itemId,
              receivedQty: parseFloat(received[item.itemId] || String(item.orderedQty)),
            }));
            receivePO(po.id, receivedItems, currentUser?.name || 'Admin');
            setDone(true);
          },
        },
      ]
    );
  };

  if (done) {
    return (
      <View style={styles.doneContainer}>
        <View style={styles.doneCard}>
          <View style={styles.doneIcon}><Text style={styles.doneIconText}>✓</Text></View>
          <Text style={styles.doneTitle}>Delivery confirmed</Text>
          <Text style={styles.doneSub}>
            Stock levels updated. All discrepancies logged in the audit trail.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => nav.goBack()}>
            <Text style={styles.doneBtnText}>Back to purchase orders</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const getMatchStatus = (itemId: string, orderedQty: number) => {
    const val = parseFloat(received[itemId] || '');
    if (isNaN(val)) return null;
    if (val === orderedQty) return 'match';
    if (val < orderedQty) return 'short';
    return 'over';
  };

  return (
    <WebScrollView id="receiving-scroll" contentContainerStyle={styles.content}>
      <Card>
        <CardHeader
          title={`Receiving ${po.poNumber}`}
          right={<Badge label={po.status.charAt(0).toUpperCase() + po.status.slice(1)} variant="sent" />}
        />
        <View style={styles.poMeta}>
          <Text style={styles.poMetaText}>Vendor: <Text style={{ fontWeight: '500', color: Colors.textPrimary }}>{po.vendorName}</Text></Text>
          <Text style={styles.poMetaText}>Expected: <Text style={{ fontWeight: '500', color: Colors.textPrimary }}>{po.expectedDelivery}</Text></Text>
          <Text style={styles.poMetaText}>Items: <Text style={{ fontWeight: '500', color: Colors.textPrimary }}>{po.items.length}</Text></Text>
        </View>
      </Card>

      <View style={styles.infoBar}>
        <Text style={styles.infoText}>
          Enter the actual quantity received for each item. Discrepancies will be flagged and logged. Leave blank to accept the ordered quantity.
        </Text>
      </View>

      <Card style={{ padding: 0 }}>
        {po.items.map((item, idx) => {
          const matchStatus = getMatchStatus(item.itemId, item.orderedQty);
          const totalCost = (parseFloat(received[item.itemId] || String(item.orderedQty)) * item.costPerUnit);

          return (
            <View
              key={item.itemId}
              style={[
                styles.itemRow,
                idx < po.items.length - 1 && styles.itemRowBorder,
              ]}
            >
              <View style={styles.itemInfo}>
                <Text style={styles.itemName}>{item.itemName}</Text>
                <Text style={styles.itemOrdered}>Ordered: {item.orderedQty} {item.unit} · ${item.costPerUnit.toFixed(2)}/unit</Text>
              </View>

              <View style={styles.inputGroup}>
                <TextInput
                  style={[
                    styles.qtyInput,
                    matchStatus === 'short' && styles.qtyInputShort,
                    matchStatus === 'over' && styles.qtyInputOver,
                    matchStatus === 'match' && styles.qtyInputMatch,
                  ]}
                  placeholder={String(item.orderedQty)}
                  placeholderTextColor={Colors.textTertiary}
                  keyboardType="decimal-pad"
                  value={received[item.itemId] || ''}
                  onChangeText={(v) => setReceived((prev) => ({ ...prev, [item.itemId]: v }))}
                />
                <Text style={styles.unitLabel}>{item.unit}</Text>
              </View>

              <View style={styles.itemRight}>
                {matchStatus && (
                  <Badge
                    label={matchStatus === 'match' ? 'Match' : matchStatus === 'short' ? 'Short' : 'Over'}
                    variant={matchStatus === 'match' ? 'ok' : matchStatus === 'short' ? 'out' : 'review'}
                  />
                )}
                <Text style={styles.itemCost}>${isNaN(totalCost) ? '—' : totalCost.toFixed(2)}</Text>
              </View>
            </View>
          );
        })}
      </Card>

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Estimated total</Text>
        <Text style={styles.totalValue}>
          ${po.items.reduce((sum, item) => {
            const qty = parseFloat(received[item.itemId] || String(item.orderedQty));
            return sum + (isNaN(qty) ? 0 : qty * item.costPerUnit);
          }, 0).toFixed(2)}
        </Text>
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.partialBtn}>
          <Text style={styles.partialBtnText}>Save as partial</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
          <Text style={styles.confirmBtnText}>Confirm & update stock</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </WebScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },
  poMeta: { flexDirection: 'row', gap: Spacing.lg },
  poMetaText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  infoBar: { backgroundColor: Colors.infoBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  infoText: { fontSize: FontSize.xs, color: Colors.info, lineHeight: 17 },
  itemRow: { padding: Spacing.md, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  itemRowBorder: { borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  itemInfo: { flex: 1.5 },
  itemName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  itemOrdered: { fontSize: 10, color: Colors.textSecondary, marginTop: 2 },
  inputGroup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  qtyInput: { width: 68, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, paddingHorizontal: 8, paddingVertical: 6, fontSize: FontSize.sm, color: Colors.textPrimary, textAlign: 'center', backgroundColor: Colors.bgSecondary },
  qtyInputMatch: { borderColor: Colors.success, backgroundColor: Colors.successBg + '55' },
  qtyInputShort: { borderColor: Colors.danger, backgroundColor: Colors.dangerBg + '55' },
  qtyInputOver: { borderColor: Colors.warning, backgroundColor: Colors.warningBg + '55' },
  unitLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, width: 32 },
  itemRight: { alignItems: 'flex-end', gap: 4, minWidth: 60 },
  itemCost: { fontSize: 10, color: Colors.textSecondary },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.borderLight },
  totalLabel: { fontSize: FontSize.sm, color: Colors.textSecondary },
  totalValue: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  actionRow: { flexDirection: 'row', gap: Spacing.sm },
  partialBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  partialBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  confirmBtn: { flex: 2, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  confirmBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '600' },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, backgroundColor: Colors.bgTertiary },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.sm },
  emptySub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', marginBottom: Spacing.xl },
  backBtn: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 0.5, borderColor: Colors.borderLight },
  backBtnText: { fontSize: FontSize.sm, color: Colors.textPrimary },
  doneContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, backgroundColor: Colors.bgTertiary },
  doneCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.xxxl, alignItems: 'center', borderWidth: 0.5, borderColor: Colors.borderLight, width: '100%' },
  doneIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.successBg, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  doneIconText: { fontSize: 24, color: Colors.success },
  doneTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.sm },
  doneSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: Spacing.xl },
  doneBtn: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 0.5, borderColor: Colors.borderLight },
  doneBtnText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },
});
