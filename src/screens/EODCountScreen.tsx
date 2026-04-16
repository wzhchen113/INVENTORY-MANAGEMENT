// src/screens/EODCountScreen.tsx
import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TextInput,
  TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useStore } from '../store/useStore';
import { submitEODCount } from '../lib/db';
import { numericFilter } from '../utils';
import { Card, CardHeader } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize, useColors } from '../theme/colors';
import { EODEntry } from '../types';

export default function EODCountScreen() {
  const { currentUser, currentStore, inventory, eodSubmissions, submitEOD, addNotification, vendors, orderSchedule } = useStore();
  const C = useColors();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState('');
  const [showAllItems, setShowAllItems] = useState(false);

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const actualToday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const [selectedDay, setSelectedDay] = useState(actualToday);

  const todayISO = new Date().toISOString().split('T')[0];

  // Find if current user already submitted today
  const myTodaySubmission = eodSubmissions.find(
    (s) =>
      s.submittedByUserId === currentUser?.id &&
      s.storeId === currentStore.id &&
      s.date === todayISO
  );

  const [saving, setSaving] = useState(false);
  const [saveCountdown, setSaveCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, []);

  const [isEditing, setIsEditing] = useState(false);
  const [editCounts, setEditCounts] = useState<Record<string, string>>({});
  const [editNotes, setEditNotes] = useState<Record<string, string>>({});

  const storeInventory = useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id]
  );

  // Selected day's scheduled vendors from order schedule
  const scheduledVendors = useMemo(() => {
    const scheduled = orderSchedule[selectedDay] || [];
    return scheduled.map((sv) => sv.vendorName.toLowerCase()).filter(Boolean);
  }, [orderSchedule, selectedDay]);

  const scheduledVendorNames = useMemo(() => {
    const scheduled = orderSchedule[selectedDay] || [];
    return scheduled.map((sv) => sv.vendorName).filter(Boolean);
  }, [orderSchedule, selectedDay]);

  // Auto-filter to selected day's vendor items (unless showAllItems toggled)
  const baseItems = useMemo(() => {
    if (showAllItems || scheduledVendors.length === 0) return storeInventory;
    return storeInventory.filter((item) =>
      scheduledVendors.includes((item.vendorName || '').toLowerCase())
    );
  }, [storeInventory, scheduledVendors, showAllItems]);

  const categories = useMemo(
    () => [...new Set(baseItems.map((i) => i.category))].sort(),
    [baseItems]
  );

  const vendorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    baseItems.forEach((i) => {
      if (i.vendorName) counts[i.vendorName] = (counts[i.vendorName] || 0) + 1;
    });
    return counts;
  }, [baseItems]);

  const vendorNames = useMemo(
    () => Object.keys(vendorCounts).sort(),
    [vendorCounts]
  );

  const filteredItems = useMemo(() => {
    let items = baseItems;
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
  }, [baseItems, selectedCategory, vendorFilter, search]);

  const filteredCategories = useMemo(() => {
    const cats = [...new Set(filteredItems.map((i) => i.category))];
    return cats.sort();
  }, [filteredItems]);

  // Pre-fill counts from previous submission so user can see what's been counted
  useEffect(() => {
    if (myTodaySubmission && Object.keys(counts).length === 0) {
      const prefilled: Record<string, string> = {};
      const prefilledNotes: Record<string, string> = {};
      myTodaySubmission.entries.forEach((e: any) => {
        prefilled[e.itemId] = String(e.actualRemaining);
        if (e.notes) prefilledNotes[e.itemId] = e.notes;
      });
      if (Object.keys(prefilled).length > 0) {
        setCounts(prefilled);
        setNotes((prev) => ({ ...prev, ...prefilledNotes }));
      }
    }
  }, [myTodaySubmission]);

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

    const confirmSubmit = async () => {
      const submission = {
        date: todayISO,
        storeId: currentStore.id,
        storeName: currentStore.name,
        submittedBy: currentUser?.name || '',
        submittedByUserId: currentUser?.id || '',
        timestamp: new Date().toISOString(),
        itemCount: entries.length,
        status: 'submitted' as const,
        entries,
      };

      // Save to local state immediately
      submitEOD(submission);
      setCounts({});
      setNotes({});
      setSearch('');
      setSelectedCategory(null);

      // Save to cloud + 3s minimum delay
      setSaving(true);
      setSaveCountdown(3);
      const cloudSave = submitEODCount(submission).catch(() => null);
      const countdown = new Promise<void>((resolve) => {
        countdownRef.current = setInterval(() => {
          setSaveCountdown((prev) => {
            if (prev <= 1) {
              if (countdownRef.current) clearInterval(countdownRef.current);
              resolve();
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      });

      const [cloudResult] = await Promise.all([cloudSave, countdown]);
      setSaving(false);

      if (cloudResult !== null) {
        addNotification(`${currentStore.name} by ${currentUser?.name || 'Unknown'} — EOD Count is submitted`);
        Toast.show({
          type: 'success',
          text1: 'EOD Count saved',
          text2: 'Your count has been saved to the cloud.',
          visibilityTime: 4000,
        });
      } else {
        addNotification(`${currentStore.name} by ${currentUser?.name || 'Unknown'} — EOD Count is submitted`);
        Toast.show({
          type: 'info',
          text1: 'EOD Count saved locally',
          text2: 'Cloud sync unavailable — saved locally.',
          visibilityTime: 4000,
        });
      }
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

  // Track which items have been submitted today
  const submittedItemMap = useMemo(() => {
    const map: Record<string, number> = {};
    (myTodaySubmission?.entries || []).forEach((e: any) => { map[e.itemId] = e.actualRemaining; });
    return map;
  }, [myTodaySubmission]);
  const submittedCount = Object.keys(submittedItemMap).length;

  // ── Already submitted view (user can always tap Edit to re-enter) ──
  if (myTodaySubmission && !isEditing && submittedCount >= baseItems.length && baseItems.length > 0) {
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
      <WebScrollView id="eod-submitted-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
        {/* Summary header */}
        <View style={[styles.submittedHeader, { backgroundColor: C.successBg }]}>
          <View style={[styles.doneIcon, { backgroundColor: C.bgPrimary }]}>
            <Ionicons name="checkmark-circle" size={28} color={C.success} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.submittedTitle, { color: C.success }]}>EOD count submitted</Text>
            <Text style={[styles.submittedMeta, { color: C.textSecondary }]}>
              Submitted {submittedAt}
              {wasEdited ? `  ·  Last edited ${lastEdited}` : ''}
            </Text>
            <Text style={[styles.submittedMeta, { color: C.textSecondary }]}>
              {myTodaySubmission.entries.length} item(s) counted by {currentUser?.name}
            </Text>
          </View>
        </View>

        {/* Edit button */}
        <TouchableOpacity style={[styles.editBtn, { backgroundColor: C.infoBg, borderColor: C.info + '33' }]} onPress={startEditing}>
          <Ionicons name="create-outline" size={16} color={C.info} />
          <Text style={[styles.editBtnText, { color: C.info }]}>Edit today's count</Text>
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
                <View key={entry.itemId} style={[styles.submittedRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.itemName, { color: C.textPrimary }]}>{entry.itemName}</Text>
                    {entry.notes ? (
                      <Text style={[styles.entryNote, { color: C.textTertiary }]}>{entry.notes}</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.submittedValue, { color: C.textPrimary }]}>
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
      <WebScrollView id="eod-edit-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
        <View style={[styles.editingBanner, { backgroundColor: C.warningBg }]}>
          <Ionicons name="create-outline" size={16} color={C.warning} />
          <Text style={[styles.editingBannerText, { color: C.warning }]}>
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
                  <View key={entry.itemId} style={[styles.itemRow, { borderBottomColor: C.borderLight }]}>
                    <View style={styles.itemInfo}>
                      <Text style={[styles.itemName, { color: C.textPrimary }]}>{entry.itemName}</Text>
                      <Text style={[styles.itemUnit, { color: C.textTertiary }]}>
                        Expected: {item?.currentStock ?? '?'} {entry.unit}
                      </Text>
                    </View>
                    <View style={styles.inputGroup}>
                      <TextInput
                        style={[styles.countInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium }]}
                        keyboardType="decimal-pad"
                        value={editCounts[entry.itemId] ?? String(entry.actualRemaining)}
                        onChangeText={(v) =>
                          setEditCounts((prev) => ({ ...prev, [entry.itemId]: numericFilter(v) }))
                        }
                      />
                      <Text style={[styles.unitLabel, { color: C.textSecondary }]}>{entry.unit}</Text>
                    </View>
                    <TextInput
                      style={[styles.noteInput, { color: C.textSecondary, backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
                      placeholder="Note..."
                      placeholderTextColor={C.textTertiary}
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
            style={[styles.draftBtn, { borderColor: C.borderMedium }]}
            onPress={() => {
              setIsEditing(false);
              setEditCounts({});
              setEditNotes({});
            }}
          >
            <Text style={[styles.draftBtnText, { color: C.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.submitBtn, { backgroundColor: C.textPrimary }]} onPress={handleUpdate}>
            <Text style={[styles.submitBtnText, { color: C.bgPrimary }]}>Save changes</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </WebScrollView>
    );
  }

  // ── New count view ──────────────────────────────────────
  return (
    <WebScrollView id="eod-count-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
      {/* Attribution notice */}
      <View style={[styles.notice, { backgroundColor: C.infoBg }]}>
        <View style={[styles.noticeAvatar, { backgroundColor: (currentUser?.color || C.info) + '33' }]}>
          <Text style={[styles.noticeAvatarText, { color: currentUser?.color || C.info }]}>
            {currentUser?.initials}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.noticeTitle, { color: C.info }]}>Submitting as {currentUser?.name}</Text>
          <Text style={[styles.noticeSub, { color: C.info }]}>
            All entries are timestamped and visible to admins ·{' '}
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </Text>
        </View>
      </View>

      {/* Day selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }} contentContainerStyle={{ paddingHorizontal: Spacing.lg, gap: 6 }}>
        {DAYS.map((day) => {
          const isActive = selectedDay === day;
          const hasVendors = (orderSchedule[day] || []).length > 0;
          return (
            <TouchableOpacity
              key={day}
              style={[{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.sm, borderWidth: 1, borderColor: C.borderLight, backgroundColor: C.bgSecondary },
                isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
              onPress={() => { setSelectedDay(day); setVendorFilter(''); setSelectedCategory(null); }}
            >
              <Text style={[{ fontSize: FontSize.xs, color: C.textSecondary }, isActive && { color: C.bgPrimary, fontWeight: '600' }]}>
                {day.slice(0, 3)}{hasVendors ? '' : ''}
              </Text>
              {hasVendors && <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: isActive ? C.bgPrimary : C.success, alignSelf: 'center', marginTop: 2 }} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Vendor info bar */}
      <View style={[styles.notice, { backgroundColor: scheduledVendors.length > 0 ? C.successBg : C.warningBg, marginTop: 0 }]}>
        <Ionicons name={scheduledVendors.length > 0 ? 'cart-outline' : 'information-circle-outline'} size={18} color={scheduledVendors.length > 0 ? C.success : C.warning} />
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={{ fontSize: FontSize.xs, fontWeight: '500', color: scheduledVendors.length > 0 ? C.success : C.warning }}>
            {scheduledVendors.length > 0
              ? `${selectedDay}: ${scheduledVendorNames.join(', ')} (${baseItems.length} items)${submittedCount > 0 ? ` · ${submittedCount} counted` : ''}`
              : `No orders scheduled for ${selectedDay} — showing all items`}
          </Text>
        </View>
        {scheduledVendors.length > 0 && (
          <TouchableOpacity onPress={() => setShowAllItems(!showAllItems)}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: C.info }}>
              {showAllItems ? 'Scheduled only' : 'Show all'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Search bar */}
      <View style={[styles.searchBar, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
        <Ionicons name="search-outline" size={16} color={C.textTertiary} />
        <TextInput
          style={[styles.searchInput, { color: C.textPrimary }]}
          placeholder="Search items..."
          placeholderTextColor={C.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={16} color={C.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Category filter pills */}
      <View style={styles.pillWrapper}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
          <TouchableOpacity
            style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !selectedCategory && styles.pillActive, !selectedCategory && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.pillText, { color: C.textSecondary }, !selectedCategory && { color: C.bgPrimary }]}>
              All ({storeInventory.length})
            </Text>
          </TouchableOpacity>
          {categories.map((cat) => {
            const count = inventory.filter((i) => i.category === cat).length;
            const isActive = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && styles.pillActive, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                onPress={() => setSelectedCategory(isActive ? null : cat)}
              >
                <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
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
              style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, !vendorFilter && styles.pillActive, !vendorFilter && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
              onPress={() => setVendorFilter('')}
            >
              <Text style={[styles.pillText, { color: C.textSecondary }, !vendorFilter && { color: C.bgPrimary }]}>
                All vendors
              </Text>
            </TouchableOpacity>
            {vendorNames.map((v) => {
              const isActive = vendorFilter === v;
              return (
                <TouchableOpacity
                  key={v}
                  style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && styles.pillActive, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }]}
                  onPress={() => setVendorFilter(isActive ? '' : v)}
                >
                  <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }]}>
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
        <Text style={[styles.progressText, { color: C.textSecondary }]}>
          {filledCount} of {storeInventory.length} items counted
        </Text>
        <View style={[styles.progressBar, { backgroundColor: C.borderLight }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${storeInventory.length > 0 ? (filledCount / storeInventory.length) * 100 : 0}%`, backgroundColor: C.success },
            ]}
          />
        </View>
      </View>

      {/* Items grouped by category */}
      {filteredCategories.map((cat) => {
        const catItems = filteredItems.filter((i) => i.category === cat);
        return (
          <Card key={cat} style={{ marginBottom: Spacing.md }}>
            <CardHeader title={cat} rightContent={<Text style={[styles.catCount, { color: C.textTertiary }]}>{catItems.length} items</Text>} />
            {catItems.map((item) => (
              <View key={item.id} style={[styles.itemRow, { borderBottomColor: C.borderLight }]}>
                <View style={styles.itemInfo}>
                  <Text style={[styles.itemName, { color: C.textPrimary }]}>{item.name}</Text>
                  <Text style={[styles.itemUnit, { color: C.textTertiary }]}>Expected: {item.currentStock} {item.unit}</Text>
                </View>
                <View style={styles.inputGroup}>
                  <TextInput
                    style={[
                      styles.countInput,
                      { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium },
                      counts[item.id] ? [styles.countInputFilled, { borderColor: C.success, backgroundColor: C.successBg }] : null,
                    ]}
                    placeholder="0"
                    placeholderTextColor={C.textTertiary}
                    keyboardType="decimal-pad"
                    value={counts[item.id] || ''}
                    onChangeText={(v) => updateCount(item.id, numericFilter(v))}
                  />
                  <Text style={[styles.unitLabel, { color: C.textSecondary }]}>{item.unit}</Text>
                </View>
                <TextInput
                  style={[styles.noteInput, { color: C.textSecondary, backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
                  placeholder="Note..."
                  placeholderTextColor={C.textTertiary}
                  value={notes[item.id] || ''}
                  onChangeText={(v) => setNotes((prev) => ({ ...prev, [item.id]: v }))}
                />
              </View>
            ))}
          </Card>
        );
      })}

      {/* Saving to cloud indicator */}
      {saving && (
        <View style={[styles.savingBanner, { backgroundColor: C.infoBg, borderColor: C.info }]}>
          <ActivityIndicator size="small" color={C.info} />
          <Text style={[styles.savingText, { color: C.info }]}>
            Saving to cloud... {saveCountdown}s
          </Text>
        </View>
      )}

      {/* Submit row */}
      <View style={styles.submitRow}>
        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: C.textPrimary }, saving && { opacity: 0.4 }]}
          onPress={handleSubmit}
          disabled={saving}
        >
          <Text style={[styles.submitBtnText, { color: C.bgPrimary }]}>
            {saving ? 'Saving...' : `Submit count (${filledCount} item${filledCount !== 1 ? 's' : ''})`}
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
  pillTextActive: { color: Colors.bgPrimary },

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
  submitBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '600' },
  savingBanner: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.md },
  savingText: { fontSize: FontSize.sm, fontWeight: '500' },

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
