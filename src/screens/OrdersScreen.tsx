// src/screens/OrdersScreen.tsx
// Smart Ordering Hub — weekly schedule + live suggested order detail
import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { OrderDayVendor, Vendor } from '../types';
import { calculateDynamicOrder, DynamicOrderLine } from '../lib/orderCalculator';

const isWeb = Platform.OS === 'web';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIMEZONES = [
  { label: 'Eastern (New York)', value: 'America/New_York' },
  { label: 'Central (Chicago)', value: 'America/Chicago' },
  { label: 'Mountain (Denver)', value: 'America/Denver' },
  { label: 'Pacific (Seattle)', value: 'America/Los_Angeles' },
  { label: 'Alaska (Anchorage)', value: 'America/Anchorage' },
  { label: 'Hawaii (Honolulu)', value: 'Pacific/Honolulu' },
];

// ── Helpers ──────────────────────────────────────────────────
function getNowInTZ(tz: string): Date {
  const str = new Date().toLocaleString('en-US', { timeZone: tz });
  return new Date(str);
}

function getDayName(tz: string): string {
  return new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
}

function getDateForDay(dayName: string, tz: string): string {
  const now = getNowInTZ(tz);
  const currentDayIdx = now.getDay();
  const targetIdx = DAY_FULL.indexOf(dayName);
  const diff = targetIdx - currentDayIdx;
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  return target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDateObjectForDay(dayName: string, tz: string): Date {
  const now = getNowInTZ(tz);
  const currentDayIdx = now.getDay();
  const targetIdx = DAY_FULL.indexOf(dayName);
  const diff = targetIdx - currentDayIdx;
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  return target;
}

function formatDate(d: Date) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function toISODate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── CSV Export ───────────────────────────────────────────────
function exportToCSV(data: DynamicOrderLine[], vendorName: string, dateStr: string) {
  const headers = ['Item Name', 'Category', 'Unit', 'Daily Usage', 'Days to Cover', 'Safety Stock', 'Target Par', 'EOD Remaining', 'Order Qty', 'Cost/Unit', 'Est. Cost'];
  const rows = data.map((d) => [
    d.itemName, d.category, d.unit,
    d.dailyUsage, d.daysToCover, d.safetyStock, d.dynamicPar,
    d.eodRemaining, d.orderQuantity,
    d.costPerUnit.toFixed(2), d.estimatedCost.toFixed(2),
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `2AM_Order_${vendorName.replace(/\s/g, '_')}_${dateStr}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ── PDF Export ───────────────────────────────────────────────
async function exportToPDF(data: DynamicOrderLine[], vendorName: string, storeName: string, orderDate: Date) {
  const { default: jsPDF } = await import('jspdf');
  await import('jspdf-autotable');

  const dtc = data.length > 0 ? data[0].daysToCover : 0;
  const dateStr = formatDate(orderDate);
  const doc = new jsPDF();

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('2AM', 14, 20);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text('Daily Replenishment Guide', 14, 28);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Store: ${storeName}  |  Vendor: ${vendorName}  |  Order Date: ${dateStr}`, 14, 35);
  doc.text(`${data.length} items  |  ${dtc} days coverage  |  Est. total: $${data.reduce((s, d) => s + d.estimatedCost, 0).toFixed(2)}`, 14, 41);

  (doc as any).autoTable({
    startY: 48,
    head: [['Item', 'Category', 'Unit', 'Daily Use', 'Days', 'Target Par', 'EOD Rem.', 'Order Qty', 'Est. Cost']],
    body: data.map((d) => [
      d.itemName, d.category, d.unit,
      d.dailyUsage, d.daysToCover, d.dynamicPar,
      d.eodRemaining, d.orderQuantity,
      `$${d.estimatedCost.toFixed(2)}`,
    ]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [26, 26, 24], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 245, 243] },
    columnStyles: {
      3: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'center' },
      6: { halign: 'center' },
      7: { halign: 'center', fontStyle: 'bold', textColor: [121, 31, 31] },
      8: { halign: 'right' },
    },
  });

  const pageHeight = doc.internal.pageSize.height;
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text('Generated by 2AM Inventory Management System', 14, pageHeight - 10);
  doc.save(`2AM_Order_${vendorName.replace(/\s/g, '_')}_${toISODate(orderDate)}.pdf`);
}

// ═════════════════════════════════════════════════════════════
// ── Main Component ───────────────────────────────────────────
// ═════════════════════════════════════════════════════════════
export default function OrdersScreen() {
  const {
    currentUser, currentStore, inventory, vendors: allVendors,
    orderSchedule, orderSubmissions,
    setOrderSchedule, submitOrder, timezone, setTimezone,
  } = useStore();
  const isAdmin = currentUser?.role === 'admin';
  const todayName = getDayName(timezone);
  const todayISO = getNowInTZ(timezone).toISOString().split('T')[0];

  // ── Schedule edit state ──
  const [showEditModal, setShowEditModal] = useState(false);
  const [editDay, setEditDay] = useState('');
  const [editVendors, setEditVendors] = useState<OrderDayVendor[]>([]);
  const [showTZModal, setShowTZModal] = useState(false);

  // ── Detail modal state ──
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDay, setDetailDay] = useState('');
  const [detailVendorName, setDetailVendorName] = useState('');

  // ── Derived data ──
  const storeInventory = useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );

  const weekSubmissions = useMemo(
    () => orderSubmissions.filter((s) => s.storeId === currentStore.id),
    [orderSubmissions, currentStore.id],
  );

  const isDaySubmitted = useCallback(
    (day: string, vendorName: string) =>
      weekSubmissions.some((s) => s.day === day && s.vendorName === vendorName && s.date === todayISO),
    [weekSubmissions, todayISO],
  );

  // ── Detail modal computed order lines ──
  const detailDate = useMemo(
    () => detailDay ? getDateObjectForDay(detailDay, timezone) : new Date(),
    [detailDay, timezone],
  );

  const detailVendor: Vendor | undefined = useMemo(
    () => allVendors.find((v) => v.name.toLowerCase() === detailVendorName.toLowerCase()),
    [allVendors, detailVendorName],
  );

  const detailLines: DynamicOrderLine[] = useMemo(() => {
    if (!detailVendor || !detailOpen) return [];
    return calculateDynamicOrder(storeInventory, detailVendor, detailDate);
  }, [detailVendor, detailOpen, storeInventory, detailDate]);

  const detailTotalCost = useMemo(
    () => detailLines.reduce((s, l) => s + l.estimatedCost, 0),
    [detailLines],
  );

  const detailDaysCover = detailLines.length > 0 ? detailLines[0].daysToCover : 0;
  const detailSubmitted = isDaySubmitted(detailDay, detailVendorName);
  const detailSubmission = weekSubmissions.find(
    (s) => s.day === detailDay && s.vendorName === detailVendorName && s.date === todayISO,
  );

  // ── Handlers ──
  const openDetail = (day: string, vendorName: string) => {
    setDetailDay(day);
    setDetailVendorName(vendorName);
    setDetailOpen(true);
  };

  const openEdit = (day: string) => {
    setEditDay(day);
    setEditVendors([...(orderSchedule[day] || [])]);
    setShowEditModal(true);
  };

  const addVendorRow = () => {
    setEditVendors([...editVendors, { vendorName: '', deliveryDay: 'Wednesday' }]);
  };

  const removeVendorRow = (idx: number) => {
    setEditVendors(editVendors.filter((_, i) => i !== idx));
  };

  const updateVendorRow = (idx: number, field: keyof OrderDayVendor, value: string) => {
    setEditVendors(editVendors.map((v, i) => (i === idx ? { ...v, [field]: value } : v)));
  };

  const saveSchedule = () => {
    setOrderSchedule(editDay, editVendors.filter((v) => v.vendorName.trim()));
    setShowEditModal(false);
  };

  const handleMarkSubmitted = () => {
    submitOrder({
      storeId: currentStore.id,
      day: detailDay,
      date: todayISO,
      vendorName: detailVendorName,
      submittedBy: currentUser?.name || '',
      submittedAt: getNowInTZ(timezone).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    });
    setDetailOpen(false);
  };

  const handleCSV = () => {
    if (!isWeb || detailLines.length === 0) return;
    exportToCSV(detailLines, detailVendorName, toISODate(detailDate));
  };

  const handlePDF = () => {
    if (!isWeb || detailLines.length === 0) return;
    exportToPDF(detailLines, detailVendorName, currentStore.name, detailDate);
  };

  const currentTZLabel = TIMEZONES.find((t) => t.value === timezone)?.label || timezone;

  // ═════════════════════════════════════════════════════════════
  // ── RENDER ─────────────────────────────────────────────────
  // ═════════════════════════════════════════════════════════════
  return (
    <View style={styles.container}>
      {/* ── Timezone bar ── */}
      <TouchableOpacity style={styles.tzBar} onPress={() => isAdmin && setShowTZModal(true)}>
        <Ionicons name="time-outline" size={14} color={Colors.textTertiary} />
        <Text style={styles.tzText}>{currentTZLabel}</Text>
        <Text style={styles.tzDate}>
          {getNowInTZ(timezone).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          {' \u00B7 '}
          {getNowInTZ(timezone).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </Text>
        {isAdmin && <Ionicons name="chevron-forward" size={12} color={Colors.textTertiary} />}
      </TouchableOpacity>

      {/* ── Weekly schedule ── */}
      <WebScrollView id="orders-scroll" contentContainerStyle={styles.list}>
        {DAYS.map((day) => {
          const vendors = orderSchedule[day] || [];
          const isToday = day === todayName;
          const dateStr = getDateForDay(day, timezone);

          return (
            <View key={day} style={[styles.dayCard, isToday && styles.dayCardToday]}>
              <View style={styles.dayHeader}>
                <View style={styles.dayHeaderLeft}>
                  <Text style={[styles.dayName, isToday && styles.dayNameToday]}>{day}</Text>
                  <Text style={styles.dayDate}>{dateStr}</Text>
                  {isToday && (
                    <View style={styles.todayBadge}>
                      <Text style={styles.todayBadgeText}>Today</Text>
                    </View>
                  )}
                </View>
                {isAdmin && (
                  <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(day)}>
                    <Ionicons name="create-outline" size={14} color={Colors.textSecondary} />
                  </TouchableOpacity>
                )}
              </View>

              {vendors.length === 0 ? (
                <View style={styles.noVendors}>
                  <Text style={styles.noVendorsText}>No orders scheduled</Text>
                  {isAdmin && (
                    <TouchableOpacity onPress={() => openEdit(day)}>
                      <Text style={styles.addVendorLink}>+ Add vendor</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : (
                vendors.map((vendor, idx) => {
                  const submitted = isDaySubmitted(day, vendor.vendorName);
                  const needsAttention = isToday && !submitted;

                  return (
                    <TouchableOpacity
                      key={idx}
                      style={styles.vendorRow}
                      activeOpacity={0.6}
                      onPress={() => openDetail(day, vendor.vendorName)}
                    >
                      <View style={styles.vendorInfo}>
                        {needsAttention && (
                          <Ionicons name="alert-circle" size={18} color={Colors.warning} style={{ marginRight: 6 }} />
                        )}
                        {submitted && (
                          <Ionicons name="checkmark-circle" size={18} color={Colors.success} style={{ marginRight: 6 }} />
                        )}
                        <View style={{ flex: 1 }}>
                          <Text style={styles.vendorName}>{vendor.vendorName}</Text>
                          <Text style={styles.deliveryText}>Delivery by {vendor.deliveryDay}</Text>
                        </View>
                      </View>
                      {submitted ? (
                        <View style={styles.submittedBadge}>
                          <Text style={styles.submittedText}>Submitted</Text>
                        </View>
                      ) : isToday ? (
                        <View style={styles.pendingBadge}>
                          <Text style={styles.pendingText}>Pending</Text>
                        </View>
                      ) : null}
                      <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} style={{ marginLeft: 8 }} />
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          );
        })}
      </WebScrollView>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* ── DETAIL MODAL — Suggested Order for Vendor ──────── */}
      {/* ═══════════════════════════════════════════════════════ */}
      <Modal visible={detailOpen} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          {/* Header */}
          <View style={styles.detailHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.detailTitle}>{detailVendorName}</Text>
              <Text style={styles.detailSubtitle}>
                {detailDay} · {formatDate(detailDate)} · {currentStore.name}
              </Text>
            </View>
            <View style={styles.detailHeaderActions}>
              {isWeb && detailLines.length > 0 && (
                <>
                  <TouchableOpacity style={styles.exportBtn} onPress={handleCSV}>
                    <Ionicons name="download-outline" size={15} color={Colors.textSecondary} />
                    <Text style={styles.exportBtnText}>CSV</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.exportBtn} onPress={handlePDF}>
                    <Ionicons name="document-text-outline" size={15} color={Colors.textSecondary} />
                    <Text style={styles.exportBtnText}>PDF</Text>
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity style={styles.closeBtn} onPress={() => setDetailOpen(false)}>
                <Ionicons name="close" size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Summary stats */}
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{detailLines.length}</Text>
              <Text style={styles.statLabel}>Items</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statValue}>{detailDaysCover}</Text>
              <Text style={styles.statLabel}>Days cover</Text>
            </View>
            <View style={[styles.statBox, { flex: 1.5 }]}>
              <Text style={[styles.statValue, { color: Colors.danger }]}>
                ${detailTotalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </Text>
              <Text style={styles.statLabel}>Est. total</Text>
            </View>
            {detailSubmitted && detailSubmission && (
              <View style={[styles.statBox, { backgroundColor: Colors.successBg }]}>
                <Text style={[styles.statValue, { color: Colors.success, fontSize: FontSize.sm }]}>
                  {detailSubmission.submittedAt}
                </Text>
                <Text style={styles.statLabel}>by {detailSubmission.submittedBy}</Text>
              </View>
            )}
          </View>

          {/* Order table */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 100 }}>
            {!detailVendor ? (
              <View style={styles.emptyDetail}>
                <Ionicons name="alert-circle-outline" size={40} color={Colors.textTertiary} />
                <Text style={styles.emptyTitle}>Vendor not found</Text>
                <Text style={styles.emptyText}>
                  "{detailVendorName}" doesn't match any vendor in your system.{'\n'}
                  Add this vendor under More &gt; Vendors and assign inventory items to it.
                </Text>
              </View>
            ) : detailLines.length === 0 ? (
              <View style={styles.emptyDetail}>
                <Ionicons name="checkmark-circle-outline" size={40} color={Colors.success} />
                <Text style={styles.emptyTitle}>No items to order</Text>
                <Text style={styles.emptyText}>
                  All {detailVendorName} items are sufficiently stocked for the next {detailDaysCover} days.
                </Text>
              </View>
            ) : (
              <>
                {/* Table header */}
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, { flex: 2.5 }]}>Item</Text>
                  <Text style={[styles.th, styles.thCenter]}>EOD</Text>
                  <Text style={[styles.th, styles.thCenter]}>Par</Text>
                  <Text style={[styles.th, styles.thCenter, { fontWeight: '700' }]}>Order</Text>
                  <Text style={[styles.th, styles.thRight]}>Cost</Text>
                </View>

                {/* Table rows */}
                {detailLines.map((line, idx) => (
                  <View key={line.itemId} style={[styles.tableRow, idx % 2 === 0 && styles.tableRowAlt]}>
                    <View style={{ flex: 2.5 }}>
                      <Text style={styles.tdName}>{line.itemName}</Text>
                      <Text style={styles.tdMeta}>{line.category} · {line.unit}</Text>
                    </View>
                    <Text style={[styles.td, styles.tdCenter]}>{line.eodRemaining}</Text>
                    <Text style={[styles.td, styles.tdCenter]}>{line.dynamicPar}</Text>
                    <View style={styles.orderQtyCell}>
                      <Text style={styles.orderQtyText}>{line.orderQuantity}</Text>
                    </View>
                    <Text style={[styles.td, styles.tdRight]}>
                      ${line.estimatedCost.toFixed(2)}
                    </Text>
                  </View>
                ))}

                {/* Totals row */}
                <View style={styles.totalRow}>
                  <Text style={[styles.totalLabel, { flex: 2.5 }]}>
                    Total ({detailLines.length} items)
                  </Text>
                  <Text style={styles.totalLabel} />
                  <Text style={styles.totalLabel} />
                  <Text style={[styles.totalValue, styles.tdCenter]}>
                    {detailLines.reduce((s, l) => s + l.orderQuantity, 0)}
                  </Text>
                  <Text style={[styles.totalValue, styles.tdRight]}>
                    ${detailTotalCost.toFixed(2)}
                  </Text>
                </View>
              </>
            )}
          </ScrollView>

          {/* Footer — Submit button */}
          <View style={styles.detailFooter}>
            {detailSubmitted ? (
              <View style={styles.submittedFooter}>
                <Ionicons name="checkmark-circle" size={20} color={Colors.success} />
                <Text style={styles.submittedFooterText}>
                  Submitted by {detailSubmission?.submittedBy} at {detailSubmission?.submittedAt}
                </Text>
              </View>
            ) : (
              <TouchableOpacity style={styles.markSubmittedBtn} onPress={handleMarkSubmitted}>
                <Ionicons name="checkmark-circle-outline" size={20} color={Colors.white} />
                <Text style={styles.markSubmittedText}>Mark Order as Submitted</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* ── EDIT SCHEDULE MODAL ───────────────────────────────  */}
      {/* ═══════════════════════════════════════════════════════ */}
      <Modal visible={showEditModal} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <View style={styles.editModalHeader}>
            <Text style={styles.editModalTitle}>{editDay} - Vendors</Text>
            <TouchableOpacity onPress={() => setShowEditModal(false)}>
              <Text style={styles.editModalCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.editModalBody}>
            {editVendors.map((vendor, idx) => (
              <View key={idx} style={styles.vendorEditRow}>
                <View style={styles.vendorEditFields}>
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>Vendor name</Text>
                    <TextInput
                      style={styles.formInput}
                      value={vendor.vendorName}
                      onChangeText={(v) => updateVendorRow(idx, 'vendorName', v)}
                      placeholder="e.g. US Foods"
                      placeholderTextColor={Colors.textTertiary}
                    />
                  </View>
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>Delivery by</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={styles.chipRow}>
                        {DAYS.map((d) => (
                          <TouchableOpacity
                            key={d}
                            style={[styles.chip, vendor.deliveryDay === d && styles.chipActive]}
                            onPress={() => updateVendorRow(idx, 'deliveryDay', d)}
                          >
                            <Text style={[styles.chipText, vendor.deliveryDay === d && styles.chipTextActive]}>
                              {d.slice(0, 3)}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                </View>
                <TouchableOpacity style={styles.removeBtn} onPress={() => removeVendorRow(idx)}>
                  <Ionicons name="trash-outline" size={16} color={Colors.danger} />
                </TouchableOpacity>
              </View>
            ))}

            <TouchableOpacity style={styles.addRowBtn} onPress={addVendorRow}>
              <Text style={styles.addRowBtnText}>+ Add vendor</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.saveBtn} onPress={saveSchedule}>
              <Text style={styles.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* ── Timezone Modal ── */}
      <Modal visible={showTZModal} animationType="fade" transparent>
        <TouchableOpacity style={styles.tzOverlay} activeOpacity={1} onPress={() => setShowTZModal(false)}>
          <View style={styles.tzDropdown}>
            <Text style={styles.tzDropdownTitle}>Time zone</Text>
            {TIMEZONES.map((tz) => {
              const active = tz.value === timezone;
              return (
                <TouchableOpacity
                  key={tz.value}
                  style={[styles.tzOption, active && styles.tzOptionActive]}
                  onPress={() => { setTimezone(tz.value); setShowTZModal(false); }}
                >
                  <Text style={[styles.tzOptionText, active && { fontWeight: '600' }]}>{tz.label}</Text>
                  {active && <Ionicons name="checkmark" size={16} color={Colors.success} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════
// ── Styles ───────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },

  // TZ bar
  tzBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm, backgroundColor: Colors.bgPrimary, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  tzText: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.textSecondary },
  tzDate: { flex: 1, fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'right', marginRight: 4 },

  // List
  list: { padding: Spacing.lg, paddingBottom: Spacing.xxxl },

  // Day card
  dayCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  dayCardToday: { borderColor: Colors.info, borderWidth: 1.5 },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  dayHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dayName: { fontSize: FontSize.base, fontWeight: '600', color: Colors.textPrimary },
  dayNameToday: { color: Colors.info },
  dayDate: { fontSize: FontSize.xs, color: Colors.textTertiary },
  todayBadge: { backgroundColor: Colors.infoBg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.round },
  todayBadgeText: { fontSize: 9, fontWeight: '600', color: Colors.info },
  editBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: Colors.borderLight },

  // No vendors
  noVendors: { paddingVertical: Spacing.sm, alignItems: 'center' },
  noVendorsText: { fontSize: FontSize.xs, color: Colors.textTertiary },
  addVendorLink: { fontSize: FontSize.xs, color: Colors.info, fontWeight: '500', marginTop: 4 },

  // Vendor row — now touchable
  vendorRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.sm + 2, paddingHorizontal: 4, borderTopWidth: 0.5, borderTopColor: Colors.borderLight },
  vendorInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  vendorName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  deliveryText: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
  submittedBadge: { backgroundColor: Colors.successBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.round },
  submittedText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '500' },
  pendingBadge: { backgroundColor: Colors.warningBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.round },
  pendingText: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '500' },

  // ── Modals shared ──
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },

  // ── Detail Modal ──
  detailHeader: {
    flexDirection: 'row', alignItems: 'flex-start',
    padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  detailTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textPrimary },
  detailSubtitle: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  detailHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: Radius.md, borderWidth: 0.5, borderColor: Colors.borderLight,
    backgroundColor: Colors.bgSecondary,
  },
  exportBtnText: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.textSecondary },
  closeBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 0.5, borderColor: Colors.borderLight,
  },

  // Stats row
  statsRow: {
    flexDirection: 'row', gap: 8, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  statBox: {
    flex: 1, backgroundColor: Colors.bgSecondary, borderRadius: Radius.md,
    padding: Spacing.sm, alignItems: 'center',
    borderWidth: 0.5, borderColor: Colors.borderLight,
  },
  statValue: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.textPrimary },
  statLabel: { fontSize: 9, color: Colors.textTertiary, marginTop: 1 },

  // Table
  tableHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    backgroundColor: Colors.bgSecondary, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  th: { flex: 1, fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary },
  thCenter: { textAlign: 'center' },
  thRight: { textAlign: 'right' },

  tableRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  tableRowAlt: { backgroundColor: Colors.bgTertiary },

  tdName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  tdMeta: { fontSize: 9, color: Colors.textTertiary, marginTop: 1 },
  td: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary },
  tdCenter: { textAlign: 'center' },
  tdRight: { textAlign: 'right' },

  orderQtyCell: {
    flex: 1, alignItems: 'center',
  },
  orderQtyText: {
    fontSize: FontSize.sm, fontWeight: '700', color: Colors.danger,
    backgroundColor: Colors.dangerBg, borderRadius: Radius.sm,
    paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
    textAlign: 'center',
  },

  totalRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md,
    backgroundColor: Colors.bgSecondary, borderTopWidth: 1, borderTopColor: Colors.borderMedium,
  },
  totalLabel: { flex: 1, fontSize: FontSize.sm, fontWeight: '600', color: Colors.textSecondary },
  totalValue: { flex: 1, fontSize: FontSize.sm, fontWeight: '700', color: Colors.textPrimary },

  // Empty states
  emptyDetail: { alignItems: 'center', padding: Spacing.xxxl, gap: Spacing.md },
  emptyTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  emptyText: { fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', lineHeight: 20 },

  // Footer
  detailFooter: {
    padding: Spacing.lg, borderTopWidth: 0.5, borderTopColor: Colors.borderLight,
    backgroundColor: Colors.bgPrimary,
  },
  markSubmittedBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.success, borderRadius: Radius.lg,
    paddingVertical: Spacing.md + 2,
  },
  markSubmittedText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '700' },
  submittedFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.successBg, borderRadius: Radius.lg,
    paddingVertical: Spacing.md + 2,
  },
  submittedFooterText: { fontSize: FontSize.sm, color: Colors.success, fontWeight: '500' },

  // ── Edit Modal ──
  editModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  editModalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  editModalCancel: { fontSize: FontSize.base, color: Colors.info },
  editModalBody: { padding: Spacing.lg },

  // Vendor edit row
  vendorEditRow: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight, paddingBottom: Spacing.lg },
  vendorEditFields: { flex: 1 },
  formField: { marginBottom: Spacing.sm },
  formLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, marginBottom: 4 },
  formInput: { borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, fontSize: FontSize.base, color: Colors.textPrimary, backgroundColor: Colors.bgSecondary },
  chipRow: { flexDirection: 'row', gap: 4 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.round, backgroundColor: Colors.bgSecondary, borderWidth: 0.5, borderColor: Colors.borderLight },
  chipActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  chipText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  chipTextActive: { color: Colors.white, fontWeight: '500' },
  removeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.dangerBg, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },

  addRowBtn: { borderWidth: 1, borderColor: Colors.borderLight, borderStyle: 'dashed', borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center', marginBottom: Spacing.lg },
  addRowBtnText: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '500' },
  saveBtn: { backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md + 2, alignItems: 'center' },
  saveBtnText: { color: Colors.white, fontSize: FontSize.base, fontWeight: '600' },

  // TZ modal
  tzOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', paddingHorizontal: Spacing.xl },
  tzDropdown: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.lg, maxWidth: 400, alignSelf: 'center', width: '100%' },
  tzDropdownTitle: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: Spacing.md },
  tzOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm, borderRadius: Radius.md, marginBottom: 2 },
  tzOptionActive: { backgroundColor: Colors.successBg },
  tzOptionText: { fontSize: FontSize.sm, color: Colors.textPrimary },
});
