// src/screens/EODCountScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Card, CardHeader } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';
import { EODEntry } from '../types';

export default function EODCountScreen() {
  const { currentUser, currentStore, inventory, eodSubmissions, submitEOD, vendors } = useStore();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState('');

  const todayISO = new Date().toISOString().split('T')[0];

  // Find if current user already submitted today
  const myTodaySubmission = eodSubmissions.find(
    (s) =>
      s.submittedByUserId === currentUser?.id &&
      s.storeId === currentStore.id &&
      s.date === todayISO
  );

  const [isEditing, setIsEditing] = useState(false);
  const [editCounts, setEditCounts] = useState<Record<string, string>>({});
  const [editNotes, setEditNotes] = useState<Record<string, string>>({});

  const storeInventory = useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id]
  );

  const categories = useMemo(
    () => [...new Set(storeInventory.map((i) => i.category))].sort(),
    [storeInventory]
  );

  const vendorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    storeInventory.forEach((i) => {
      if (i.vendorName) counts[i.vendorName] = (counts[i.vendorName] || 0) + 1;
    });
    return counts;
  }, [storeInventory]);

  const vendorNames = useMemo(
    () => Object.keys(vendorCounts).sort(),
    [vendorCounts]
  );

  const filteredItems = useMemo(() => {
    let items = storeInventory;
    if (selectedCategory) {
      items = items.filter((i) => i.category === selectedCategory);
    }
    if (vendorFilter) {
      items = items.filter((i) => i.vendorName === vendorFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
      );
    }
    return items;
  }, [storeInventory, selectedCategory, vendorFilter, search]);

  const filteredCategories = useMemo(() => {
    const cats = [...new Set(filteredItems.map((i) => i.category))];
    return cats.sort();
  }, [filteredItems]);

  const updateCount = (id: string, value: string) => {
    setCounts((prev) => ({ ...prev, [id]: value }));
  };

  const filledCount = Object.values(counts).filter((v) => v !== '' && v !== undefined).length;

  const handleSubmit = () => {
    const entries: EODEntry[] = storeInventory
      .filter((item) => counts[item.id] !== undefined && counts[item.id] !== '')
      .map((item) => ({
        id: `eod-${item.id}-${Date.now()}`,
        itemId: item.id,
        itemName: item.name,
        actualRemaining: parseFloat(counts[item.id]) || 0,
        unit: item.unit,
        submittedBy: currentUser?.name || '',
        submittedByUserId: currentUser?.id || '',
        timestamp: new Date().toISOString(),
        date: todayISO,
        storeId: currentStore.id,
        notes: notes[item.id] || '',
      }));

    if (entries.length === 0) {
      Alert.alert('No counts entered', 'Please enter at least one remaining quantity before submitting.');
      return;
    }

    const confirmSubmit = () => {
      submitEOD({
        date: todayISO,
        storeId: currentStore.id,
        storeName: currentStore.name,
        submittedBy: currentUser?.name || '',
        submittedByUserId: currentUser?.id || '',
        timestamp: new Date().toISOString(),
        itemCount: entries.length,
        status: 'submitted',
        entries,
      });
      setCounts({});
      setNotes({});
      setSearch('');
      setSelectedCategory(null);
    };

    if (Platform.OS === 'web') {
      confirmSubmit();
    } else {
      Alert.alert(
        'Submit EOD count?',
        `You are submitting counts for ${entries.length} item(s).`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Submit', onPress: confirmSubmit },
        ]
      );
    }
  };

  const startEditing = () => {
    if (!myTodaySubmission) return;
    const ec: Record<string, string> = {};
    const en: Record<string, string> = {};
    myTodaySubmission.entries.forEach((entry) => {
      ec[entry.itemId] = String(entry.actualRemaining);
      en[entry.itemId] = entry.notes || '';
    });
    setEditCounts(ec);
    setEditNotes(en);
    setIsEditing(true);
  };

  const handleUpdate = () => {
    if (!myTodaySubmission) return;

    const updatedEntries: EODEntry[] = myTodaySubmission.entries.map((entry) => ({
      ...entry,
      actualRemaining:
        editCounts[entry.itemId] !== undefined
          ? parseFloat(editCounts[entry.itemId]) || 0
          : entry.actualRemaining,
      notes: editNotes[entry.itemId] ?? entry.notes,
      timestamp: new Date().toISOString(),
    }));

    // Update the submission in the store
    submitEOD({
      ...myTodaySubmission,
      entries: updatedEntries,
      timestamp: new Date().toISOString(),
    });

    setIsEditing(false);
    setEditCounts({});
    setEditNotes({});
  };

  const formatDateTime = (isoStr: string) => {
    const d = new Date(isoStr);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  // ── Already submitted view ──────────────────────────────
  if (myTodaySubmission && !isEditing) {
    const submittedAt = formatDateTime(myTodaySubmission.timestamp);
    const lastEdited =
      myTodaySubmission.entries.length > 0
        ? formatDateTime(
            myTodaySubmission.entries.reduce((latest, e) =>
              e.timestamp > latest ? e.timestamp : latest,
              myTodaySubmission.entries[0].timestamp
            )
          )
        : submittedAt;
    const wasEdited = lastEdited !== submittedAt;

    const submittedCategories = [
      ...new Set(myTodaySubmission.entries.map((e) => {
        const item = inventory.find((i) => i.id === e.itemId);
        return item?.category || 'Other';
      })),
    ].sort();

    return (
      <WebScrollView id="eod-submitted-scroll" contentContainerStyle={styles.content}>
        {/* Summary header */}
        <View style={styles.submittedHeader}>
          <View style={styles.doneIcon}>
            <Ionicons name="checkmark-circle" size={28} color={Colors.success} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.submittedTitle}>EOD count submitted</Text>
            <Text style={styles.submittedMeta}>
              Submitted {submittedAt}
              {wasEdited ? `  ·  Last edited ${lastEdited}` : ''}
            </Text>
            <Text style={styles.submittedMeta}>
              {myTodaySubmission.entries.length} item(s) counted by {currentUser?.name}
            </Text>
          </View>
        </View>

        {/* Edit button */}
        <TouchableOpacity style={styles.editBtn} onPress={startEditing}>
          <Ionicons name="create-outline" size={16} color={Colors.info} />
          <Text style={styles.editBtnText}>Edit today's count</Text>
        </TouchableOpacity>

        {/* Submitted entries grouped by category */}
        {submittedCategories.map((cat) => {
          const catEntries = myTodaySubmission.entries.filter((e) => {
            const item = inventory.find((i) => i.id === e.itemId);
            return (item?.category || 'Other') === cat;
          });
          return (
            <Card key={cat} style={{ marginBottom: Spacing.md }}>
              <CardHeader title={cat} />
              {catEntries.map((entry) => (
                <View key={entry.itemId} style={styles.submittedRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{entry.itemName}</Text>
                    {entry.notes ? (
                      <Text style={styles.entryNote}>{entry.notes}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.submittedValue}>
                    {entry.actualRemaining} {entry.unit}
                  </Text>
                </View>
              ))}
            </Card>
          );
        })}

        <View style={{ height: 40 }} />
      </WebScrollView>
    );
  }

  // ── Editing view ────────────────────────────────────────
  if (isEditing && myTodaySubmission) {
    const editCategories = [
      ...new Set(myTodaySubmission.entries.map((e) => {
        const item = inventory.find((i) => i.id === e.itemId);
        return item?.category || 'Other';
      })),
    ].sort();

    return (
      <WebScrollView id="eod-edit-scroll" contentContainerStyle={styles.content}>
        <View style={styles.editingBanner}>
          <Ionicons name="create-outline" size={16} color={Colors.warning} />
          <Text style={styles.editingBannerText}>
            Editing today's count · Changes will update the timestamp
          </Text>
        </View>

        {editCategories.map((cat) => {
          const catEntries = myTodaySubmission.entries.filter((e) => {
            const item = inventory.find((i) => i.id === e.itemId);
            return (item?.category || 'Other') === cat;
          });
          return (
            <Card key={cat} style={{ marginBottom: Spacing.md }}>
              <CardHeader title={cat} />
              {catEntries.map((entry) => {
                const item = inventory.find((i) => i.id === entry.itemId);
                return (
                  <View key={entry.itemId} style={styles.itemRow}>
                    <View style={styles.itemInfo}>
                      <Text style={styles.itemName}>{entry.itemName}</Text>
                      <Text style={styles.itemUnit}>
                        Expected: {item?.currentStock ?? '?'} {entry.unit}
                      </Text>
                    </View>
                    <View style={styles.inputGroup}>
                      <TextInput
                        style={styles.countInput}
                        keyboardType="decimal-pad"
                        value={editCounts[entry.itemId] ?? String(entry.actualRemaining)}
                        onChangeText={(v) =>
                          setEditCounts((prev) => ({ ...prev, [entry.itemId]: v }))
                        }
                      />
                      <Text style={styles.unitLabel}>{entry.unit}</Text>
                    </View>
                    <TextInput
                      style={styles.noteInput}
                      placeholder="Note..."
                      placeholderTextColor={Colors.textTertiary}
                      value={editNotes[entry.itemId] ?? entry.notes}
                      onChangeText={(v) =>
                        setEditNotes((prev) => ({ ...prev, [entry.itemId]: v }))
                      }
                    />
                  </View>
                );
              })}
            </Card>
          );
        })}

        <View style={styles.submitRow}>
          <TouchableOpacity
            style={styles.draftBtn}
            onPress={() => {
              setIsEditing(false);
              setEditCounts({});
              setEditNotes({});
            }}
          >
            <Text style={styles.draftBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.submitBtn} onPress={handleUpdate}>
            <Text style={styles.submitBtnText}>Save changes</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </WebScrollView>
    );
  }

  // ── New count view ──────────────────────────────────────
  return (
    <WebScrollView id="eod-count-scroll" contentContainerStyle={styles.content}>
      {/* Attribution notice */}
      <View style={styles.notice}>
        <View style={[styles.noticeAvatar, { backgroundColor: (currentUser?.color || Colors.info) + '33' }]}>
          <Text style={[styles.noticeAvatarText, { color: currentUser?.color || Colors.info }]}>
            {currentUser?.initials}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.noticeTitle}>Submitting as {currentUser?.name}</Text>
          <Text style={styles.noticeSub}>
            All entries are timestamped and visible to admins ·{' '}
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </Text>
        </View>
      </View>

      {/* Search bar */}
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={16} color={Colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search items..."
          placeholderTextColor={Colors.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Category filter pills */}
      <View style={styles.pillWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
          <TouchableOpacity
            style={[styles.pill, !selectedCategory && styles.pillActive]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.pillText, !selectedCategory && styles.pillTextActive]}>
              All ({storeInventory.length})
            </Text>
          </TouchableOpacity>
          {categories.map((cat) => {
            const count = inventory.filter((i) => i.category === cat).length;
            const isActive = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.pill, isActive && styles.pillActive]}
                onPress={() => setSelectedCategory(isActive ? null : cat)}
              >
                <Text style={[styles.pillText, isActive && styles.pillTextActive]}>
                  {cat} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Vendor filter pills */}
      {vendorNames.length > 0 && (
        <View style={styles.pillWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
            <TouchableOpacity
              style={[styles.pill, !vendorFilter && styles.pillActive]}
              onPress={() => setVendorFilter('')}
            >
              <Text style={[styles.pillText, !vendorFilter && styles.pillTextActive]}>
                All vendors
              </Text>
            </TouchableOpacity>
            {vendorNames.map((v) => {
              const isActive = vendorFilter === v;
              return (
                <TouchableOpacity
                  key={v}
                  style={[styles.pill, isActive && styles.pillActive]}
                  onPress={() => setVendorFilter(isActive ? '' : v)}
                >
                  <Text style={[styles.pillText, isActive && styles.pillTextActive]}>
                    {v} ({vendorCounts[v]})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Progress indicator */}
      <View style={styles.progressRow}>
        <Text style={styles.progressText}>
          {filledCount} of {storeInventory.length} items counted
        </Text>
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              { width: `${storeInventory.length > 0 ? (filledCount / storeInventory.length) * 100 : 0}%` },
            ]}
          />
        </View>
      </View>

      {/* Items grouped by category */}
      {filteredCategories.map((cat) => {
        const catItems = filteredItems.filter((i) => i.category === cat);
        return (
          <Card key={cat} style={{ marginBottom: Spacing.md }}>
            <CardHeader title={cat} rightContent={<Text style={styles.catCount}>{catItems.length} items</Text>} />
            {catItems.map((item) => (
              <View key={item.id} style={styles.itemRow}>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName}>{item.name}</Text>
                  <Text style={styles.itemUnit}>Expected: {item.currentStock} {item.unit}</Text>
                </View>
                <View style={styles.inputGroup}>
                  <TextInput
                    style={[
                      styles.countInput,
                      counts[item.id] ? styles.countInputFilled : null,
                    ]}
                    placeholder="0"
                    placeholderTextColor={Colors.textTertiary}
                    keyboardType="decimal-pad"
                    value={counts[item.id] || ''}
                    onChangeText={(v) => updateCount(item.id, v)}
                  />
                  <Text style={styles.unitLabel}>{item.unit}</Text>
                </View>
                <TextInput
                  style={styles.noteInput}
                  placeholder="Note..."
                  placeholderTextColor={Colors.textTertiary}
                  value={notes[item.id] || ''}
                  onChangeText={(v) => setNotes((prev) => ({ ...prev, [item.id]: v }))}
                />
              </View>
            ))}
          </Card>
        );
      })}

      {/* Submit row */}
      <View style={styles.submitRow}>
        <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
          <Text style={styles.submitBtnText}>
            Submit count ({filledCount} item{filledCount !== 1 ? 's' : ''})
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </WebScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },

  // Notice
  notice: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.infoBg, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.md },
  noticeAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  noticeAvatarText: { fontSize: FontSize.sm, fontWeight: '600' },
  noticeTitle: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.info },
  noticeSub: { fontSize: FontSize.xs, color: Colors.info, opacity: 0.75, marginTop: 2 },

  // Search
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.bgPrimary, borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 8, marginBottom: Spacing.sm, borderWidth: 0.5, borderColor: Colors.borderLight },
  searchInput: { flex: 1, fontSize: FontSize.sm, color: Colors.textPrimary, padding: 0 },

  // Category pills
  pillWrapper: { marginBottom: Spacing.md },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingRight: Spacing.md },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.round, backgroundColor: Colors.bgPrimary, borderWidth: 0.5, borderColor: Colors.borderLight },
  pillActive: { backgroundColor: Colors.textPrimary, borderColor: Colors.textPrimary },
  pillText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '500' },
  pillTextActive: { color: Colors.white },

  // Progress
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.md },
  progressText: { fontSize: FontSize.xs, color: Colors.textSecondary },
  progressBar: { flex: 1, height: 4, backgroundColor: Colors.borderLight, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: Colors.success, borderRadius: 2 },

  // Items
  catCount: { fontSize: FontSize.xs, color: Colors.textTertiary },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  itemInfo: { flex: 1.5 },
  itemName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  itemUnit: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  inputGroup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  countInput: { width: 64, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: FontSize.sm, color: Colors.textPrimary, textAlign: 'center', backgroundColor: Colors.bgSecondary },
  countInputFilled: { borderColor: Colors.success, backgroundColor: Colors.successBg },
  unitLabel: { fontSize: FontSize.xs, color: Colors.textSecondary, width: 36 },
  noteInput: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderLight, borderRadius: Radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: 10, color: Colors.textSecondary, backgroundColor: Colors.bgSecondary },

  // Submit
  submitRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  draftBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  draftBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '500' },
  submitBtn: { flex: 2, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  submitBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '600' },

  // Submitted view
  submittedHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, backgroundColor: Colors.successBg, borderRadius: Radius.lg, padding: Spacing.lg, marginBottom: Spacing.md },
  doneIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.bgPrimary, alignItems: 'center', justifyContent: 'center' },
  submittedTitle: { fontSize: FontSize.base, fontWeight: '600', color: Colors.success },
  submittedMeta: { fontSize: FontSize.xs, color: Colors.textSecondary, marginTop: 2 },
  submittedRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  submittedValue: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary },
  entryNote: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2, fontStyle: 'italic' },
  editBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.infoBg, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md, borderWidth: 0.5, borderColor: Colors.info + '33' },
  editBtnText: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '500' },

  // Editing banner
  editingBanner: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.warningBg, borderRadius: Radius.lg, padding: Spacing.md, marginBottom: Spacing.md },
  editingBannerText: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '500' },
});
