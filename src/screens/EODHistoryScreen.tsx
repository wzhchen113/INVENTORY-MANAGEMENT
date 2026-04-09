// src/screens/EODHistoryScreen.tsx
// Admin view: all EOD submissions across all stores
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { WebScrollView } from '../components/WebScrollView';
import DatePicker from '../components/DatePicker';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { EODSubmission } from '../types';

export default function EODHistoryScreen() {
  const { eodSubmissions, stores, users, inventory } = useStore();
  const C = useColors();
  const [storeFilter, setStoreFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [selectedSubmission, setSelectedSubmission] = useState<EODSubmission | null>(null);

  const filtered = useMemo(() => {
    let subs = [...eodSubmissions].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    if (storeFilter) subs = subs.filter((s) => s.storeId === storeFilter);
    if (userFilter) subs = subs.filter((s) => s.submittedByUserId === userFilter);
    if (dateFilter) subs = subs.filter((s) => s.date === dateFilter);
    return subs;
  }, [eodSubmissions, storeFilter, userFilter, dateFilter]);

  const submitterIds = useMemo(() => {
    const ids = [...new Set(eodSubmissions.map((s) => s.submittedByUserId))];
    return ids;
  }, [eodSubmissions]);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  const getUserColor = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    return user?.color || '#378ADD';
  };

  const getUserInitials = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    return user?.initials || '??';
  };

  return (
    <View style={[styles.container, { backgroundColor: C.bgTertiary }]}>
      {/* Store filter pills */}
      <View style={styles.pillWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
          <TouchableOpacity
            style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !storeFilter && styles.pillActive, !storeFilter && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
            onPress={() => setStoreFilter('')}
          >
            <Text style={[styles.pillText, { color: C.textSecondary }, !storeFilter && { color: C.bgPrimary }]}>
              All stores ({eodSubmissions.length})
            </Text>
          </TouchableOpacity>
          {stores.map((store) => {
            const count = eodSubmissions.filter((s) => s.storeId === store.id).length;
            if (count === 0) return null;
            const isActive = storeFilter === store.id;
            return (
              <TouchableOpacity
                key={store.id}
                style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && styles.pillActive, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                onPress={() => setStoreFilter(isActive ? '' : store.id)}
              >
                <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
                  {store.name} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* User filter pills */}
      {submitterIds.length > 1 && (
        <View style={[styles.pillWrapper, { paddingTop: 0 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
            <TouchableOpacity
              style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !userFilter && styles.pillActive, !userFilter && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
              onPress={() => setUserFilter('')}
            >
              <Text style={[styles.pillText, { color: C.textSecondary }, !userFilter && { color: C.bgPrimary }]}>
                All users
              </Text>
            </TouchableOpacity>
            {submitterIds.map((uid) => {
              const user = users.find((u) => u.id === uid);
              if (!user) return null;
              const count = eodSubmissions.filter((s) => s.submittedByUserId === uid).length;
              const isActive = userFilter === uid;
              return (
                <TouchableOpacity
                  key={uid}
                  style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && styles.pillActive, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                  onPress={() => setUserFilter(isActive ? '' : uid)}
                >
                  <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
                    {user.name} ({count})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Date filter */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
        <DatePicker value={dateFilter} onChange={setDateFilter} label="Filter by date" placeholder="All dates" />
      </View>

      {/* Summary */}
      <View style={styles.summaryBar}>
        <Text style={[styles.summaryText, { color: C.textTertiary }]}>
          {filtered.length} submission{filtered.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Submission list */}
      <WebScrollView id="eod-history-scroll" contentContainerStyle={styles.list}>
        {filtered.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="clipboard-outline" size={32} color={C.textTertiary} />
            <Text style={[styles.emptyText, { color: C.textTertiary }]}>No EOD submissions found</Text>
          </View>
        ) : (
          filtered.map((sub) => {
            const color = getUserColor(sub.submittedByUserId);
            return (
              <TouchableOpacity
                key={sub.id}
                style={[styles.card, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}
                onPress={() => setSelectedSubmission(sub)}
                activeOpacity={0.7}
              >
                <View style={styles.cardTop}>
                  <View style={[styles.avatar, { backgroundColor: color + '22' }]}>
                    <Text style={[styles.avatarText, { color }]}>
                      {getUserInitials(sub.submittedByUserId)}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cardName, { color: C.textPrimary }]}>{sub.submittedBy}</Text>
                    <Text style={[styles.cardMeta, { color: C.textTertiary }]}>
                      {formatDate(sub.timestamp)} · {formatTime(sub.timestamp)}
                    </Text>
                  </View>
                  <View style={[styles.storeBadge, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}>
                    <Text style={[styles.storeBadgeText, { color: C.textSecondary }]}>{sub.storeName}</Text>
                  </View>
                </View>
                <View style={[styles.cardStats, { borderTopColor: C.borderLight }]}>
                  <View style={styles.stat}>
                    <Text style={[styles.statValue, { color: C.textPrimary }]}>{sub.itemCount}</Text>
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>items counted</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={[styles.statValue, { color: C.textPrimary }]}>{sub.date}</Text>
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>date</Text>
                  </View>
                  <View style={styles.stat}>
                    <View style={[styles.statusDot, { backgroundColor: sub.status === 'submitted' ? C.success : C.warning }]} />
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>{sub.status}</Text>
                  </View>
                </View>
                {sub.entries.some((e) => e.notes) && (
                  <View style={styles.notesHint}>
                    <Ionicons name="chatbubble-outline" size={10} color={C.textTertiary} />
                    <Text style={[styles.notesHintText, { color: C.textTertiary }]}>Has notes</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}
      </WebScrollView>

      {/* Detail modal */}
      <Modal visible={!!selectedSubmission} animationType="slide" presentationStyle="pageSheet">
        {selectedSubmission && (
          <View style={[styles.modal, { backgroundColor: C.bgPrimary }]}>
            <View style={[styles.modalHeader, { borderBottomColor: C.borderLight }]}>
              <View>
                <Text style={[styles.modalTitle, { color: C.textPrimary }]}>EOD Count Detail</Text>
                <Text style={[styles.modalSub, { color: C.textTertiary }]}>
                  {selectedSubmission.storeName} · {formatDate(selectedSubmission.timestamp)}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setSelectedSubmission(null)}>
                <Text style={[styles.modalClose, { color: C.info }]}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* Submitter info */}
            <View style={[styles.submitterRow, { backgroundColor: C.bgSecondary, borderBottomColor: C.borderLight }]}>
              <View style={[styles.avatar, { backgroundColor: getUserColor(selectedSubmission.submittedByUserId) + '22' }]}>
                <Text style={[styles.avatarText, { color: getUserColor(selectedSubmission.submittedByUserId) }]}>
                  {getUserInitials(selectedSubmission.submittedByUserId)}
                </Text>
              </View>
              <View>
                <Text style={[styles.submitterName, { color: C.textPrimary }]}>{selectedSubmission.submittedBy}</Text>
                <Text style={[styles.submitterTime, { color: C.textTertiary }]}>
                  Submitted {formatTime(selectedSubmission.timestamp)} · {selectedSubmission.itemCount} items
                </Text>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.modalBody}>
              {/* Entries table */}
              <View style={[styles.tableHeader, { borderBottomColor: C.borderMedium }]}>
                <Text style={[styles.tableHeaderText, { flex: 2, color: C.textTertiary }]}>Item</Text>
                <Text style={[styles.tableHeaderText, { flex: 1, textAlign: 'right', color: C.textTertiary }]}>Remaining</Text>
              </View>
              {selectedSubmission.entries.map((entry) => (
                <View key={entry.id} style={[styles.tableRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 2 }}>
                    <Text style={[styles.entryName, { color: C.textPrimary }]}>{entry.itemName}</Text>
                    {entry.notes ? (
                      <Text style={[styles.entryNote, { color: C.textTertiary }]}>{entry.notes}</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.entryValue, { color: C.textPrimary }]}>
                    {entry.actualRemaining} {entry.unit}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },

  // Pills
  pillWrapper: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.round, backgroundColor: Colors.bgPrimary, borderWidth: 0.5, borderColor: Colors.borderLight },
  pillActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  pillTextActive: { color: Colors.bgPrimary },

  // Summary
  summaryBar: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  summaryText: { fontSize: FontSize.xs, color: Colors.textTertiary },

  // List
  list: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxxl },
  card: {
    backgroundColor: Colors.bgPrimary, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: Spacing.sm,
    borderWidth: 0.5, borderColor: Colors.borderLight,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  cardName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  cardMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },
  storeBadge: {
    backgroundColor: Colors.bgSecondary, borderRadius: Radius.round,
    paddingHorizontal: 8, paddingVertical: 3,
    borderWidth: 0.5, borderColor: Colors.borderLight,
  },
  storeBadgeText: { fontSize: 9, fontWeight: '500', color: Colors.textSecondary },
  cardStats: { flexDirection: 'row', gap: Spacing.lg, paddingTop: Spacing.sm, borderTopWidth: 0.5, borderTopColor: Colors.borderLight },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statValue: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary },
  statLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  notesHint: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: Spacing.sm },
  notesHintText: { fontSize: 9, color: Colors.textTertiary },

  // Empty
  emptyBox: { alignItems: 'center', paddingVertical: Spacing.xxxl * 2 },
  emptyText: { fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: Spacing.md },

  // Modal
  modal: { flex: 1, backgroundColor: Colors.bgPrimary },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: Spacing.lg, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600', color: Colors.textPrimary },
  modalSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  modalClose: { fontSize: FontSize.base, color: Colors.info },
  modalBody: { padding: Spacing.lg },

  // Submitter
  submitterRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    padding: Spacing.lg, backgroundColor: Colors.bgSecondary,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  submitterName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  submitterTime: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 1 },

  // Table
  tableHeader: {
    flexDirection: 'row', paddingBottom: Spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderMedium,
    marginBottom: Spacing.sm,
  },
  tableHeaderText: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  tableRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight,
  },
  entryName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  entryNote: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2, fontStyle: 'italic' },
  entryValue: { flex: 1, fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary, textAlign: 'right' },
});
