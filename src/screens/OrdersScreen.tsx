// src/screens/OrdersScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { OrderDayVendor } from '../types';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DELIVERY_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const TIMEZONES = [
  { label: 'Eastern (New York)', value: 'America/New_York' },
  { label: 'Central (Chicago)', value: 'America/Chicago' },
  { label: 'Mountain (Denver)', value: 'America/Denver' },
  { label: 'Pacific (Seattle)', value: 'America/Los_Angeles' },
  { label: 'Alaska (Anchorage)', value: 'America/Anchorage' },
  { label: 'Hawaii (Honolulu)', value: 'Pacific/Honolulu' },
];

function getNowInTZ(tz: string): Date {
  const str = new Date().toLocaleString('en-US', { timeZone: tz });
  return new Date(str);
}

function getDayName(tz: string): string {
  return new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
}

function getDateForDay(dayName: string, tz: string): string {
  const now = getNowInTZ(tz);
  const currentDayIdx = now.getDay(); // 0=Sun
  const targetIdx = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(dayName);
  const diff = targetIdx - currentDayIdx;
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  return target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function OrdersScreen() {
  const {
    currentUser, currentStore, orderSchedule, orderSubmissions,
    setOrderSchedule, submitOrder, timezone, setTimezone,
  } = useStore();
  const isAdmin = currentUser?.role === 'admin';
  const todayName = getDayName(timezone);
  const todayISO = getNowInTZ(timezone).toISOString().split('T')[0];

  const [showEditModal, setShowEditModal] = useState(false);
  const [editDay, setEditDay] = useState('');
  const [editVendors, setEditVendors] = useState<OrderDayVendor[]>([]);
  const [showTZModal, setShowTZModal] = useState(false);

  const weekSubmissions = useMemo(() => {
    return orderSubmissions.filter(
      (s) => s.storeId === currentStore.id
    );
  }, [orderSubmissions, currentStore.id]);

  const isDaySubmitted = (day: string, vendorName: string) => {
    return weekSubmissions.some(
      (s) => s.day === day && s.vendorName === vendorName && s.date === todayISO
    );
  };

  const isDayPastOrToday = (day: string) => {
    const dayIdx = DAYS.indexOf(day);
    const todayIdx = DAYS.indexOf(todayName);
    if (todayIdx === -1) return false;
    // Adjust: Sunday = -1 for comparison since DAYS starts at Monday
    return dayIdx <= todayIdx;
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
    setEditVendors(editVendors.map((v, i) => i === idx ? { ...v, [field]: value } : v));
  };

  const saveSchedule = () => {
    const valid = editVendors.filter((v) => v.vendorName.trim());
    setOrderSchedule(editDay, valid);
    setShowEditModal(false);
  };

  const handleSubmitOrder = (day: string, vendorName: string) => {
    const doSubmit = () => {
      submitOrder({
        storeId: currentStore.id,
        day,
        date: todayISO,
        vendorName,
        submittedBy: currentUser?.name || '',
        submittedAt: getNowInTZ(timezone).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      });
    };
    if (Platform.OS === 'web') {
      if (confirm(`Confirm order submitted to ${vendorName}?`)) doSubmit();
    } else {
      Alert.alert('Confirm Order', `Mark order to ${vendorName} as submitted?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', onPress: doSubmit },
      ]);
    }
  };

  const currentTZLabel = TIMEZONES.find((t) => t.value === timezone)?.label || timezone;

  return (
    <View style={styles.container}>
      {/* Timezone bar */}
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
                  const needsAttention = isToday && !submitted && vendors.length > 0;

                  return (
                    <View key={idx} style={styles.vendorRow}>
                      <View style={styles.vendorInfo}>
                        {needsAttention && (
                          <Ionicons name="alert-circle" size={18} color={Colors.warning} style={{ marginRight: 6 }} />
                        )}
                        {submitted && (
                          <Ionicons name="checkmark-circle" size={18} color={Colors.success} style={{ marginRight: 6 }} />
                        )}
                        <View>
                          <Text style={styles.vendorName}>{vendor.vendorName}</Text>
                          <Text style={styles.deliveryText}>
                            Delivery by {vendor.deliveryDay}
                          </Text>
                        </View>
                      </View>
                      {isToday && !submitted && (
                        <TouchableOpacity
                          style={styles.submitBtn}
                          onPress={() => handleSubmitOrder(day, vendor.vendorName)}
                        >
                          <Text style={styles.submitBtnText}>Confirm</Text>
                        </TouchableOpacity>
                      )}
                      {submitted && (
                        <View style={styles.submittedBadge}>
                          <Text style={styles.submittedText}>Submitted</Text>
                        </View>
                      )}
                    </View>
                  );
                })
              )}
            </View>
          );
        })}
      </WebScrollView>

      {/* Edit Day Modal */}
      <Modal visible={showEditModal} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{editDay} - Vendors</Text>
            <TouchableOpacity onPress={() => setShowEditModal(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
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
                        {DELIVERY_DAYS.map((d) => (
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

      {/* Timezone Modal */}
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

  // Vendor row
  vendorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Spacing.sm, borderTopWidth: 0.5, borderTopColor: Colors.borderLight },
  vendorInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  vendorName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  deliveryText: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
  submitBtn: { backgroundColor: Colors.info, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 6 },
  submitBtnText: { color: Colors.white, fontSize: FontSize.xs, fontWeight: '600' },
  submittedBadge: { backgroundColor: Colors.successBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.round },
  submittedText: { fontSize: FontSize.xs, color: Colors.success, fontWeight: '500' },

  // Modal
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  modalCancel: { fontSize: FontSize.base, color: Colors.info },
  modalBody: { padding: Spacing.lg },

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
