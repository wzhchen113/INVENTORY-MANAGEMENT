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
import { TimezoneBar } from '../components/TimezoneBar';
import { Colors, Spacing, Radius, FontSize, useColors } from '../theme/colors';
import { EODEntry } from '../types';
import { getPushPermission, requestPermissionAndSubscribe } from '../lib/webPush';
import { getBusinessTodayParts } from '../utils/businessDay';

export default function EODCountScreen() {
  const { currentUser, currentStore, inventory, eodSubmissions, submitEOD, addNotification, vendors, orderSchedule, timezone } = useStore();
  const C = useColors();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [casesCount, setCasesCount] = useState<Record<string, string>>({});
  const [eachCount, setEachCount] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState('');
  const [showAllItems, setShowAllItems] = useState(false);

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // Business day rolls over at 3 AM local — so "today" stays on yesterday's
  // calendar date until the late-night closing shift is well done.
  const businessToday = useMemo(
    () => getBusinessTodayParts(timezone || 'America/New_York'),
    [timezone],
  );
  const actualToday = businessToday.weekday;

  // For each weekday, compute the date of its NEXT occurrence in store-local
  // business-day time. Example (if business-today is Thu 23rd):
  //   Mon → Mon 27th, Tue → Tue 28th, Wed → Wed 29th,
  //   Thu → Thu 23rd, Fri → Fri 24th, Sat → Sat 25th, Sun → Sun 26th
  const dayLabels = useMemo(() => {
    const base = new Date(Date.UTC(businessToday.year, businessToday.month - 1, businessToday.day));
    const baseWeekday = base.getUTCDay(); // 0 = Sunday … 6 = Saturday

    const weekdayIndex: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
    };

    const ordinal = (n: number): string => {
      if (n % 100 >= 11 && n % 100 <= 13) return 'th';
      switch (n % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
      }
    };

    const labels: Record<string, string> = {};
    for (const [name, idx] of Object.entries(weekdayIndex)) {
      let daysAhead = idx - baseWeekday;
      if (daysAhead < 0) daysAhead += 7; // already passed this week → next week
      const target = new Date(base);
      target.setUTCDate(target.getUTCDate() + daysAhead);
      const d = target.getUTCDate();
      labels[name] = `${name.slice(0, 3)} ${d}${ordinal(d)}`;
    }
    return labels;
  }, [businessToday]);
  const [selectedDay, setSelectedDay] = useState(actualToday);

  // Business-day ISO, so at 1 AM Friday the "today's EOD" lookup still matches
  // a submission that was saved during the Thursday shift (date=2026-04-23).
  const todayISO = businessToday.dateISO;

  // Find today's submission for this store. Scope is (store, date) only —
  // not (store, date, user) — so admins viewing the store see + can edit
  // the same count a regular user submitted, instead of getting an empty
  // count form and creating a parallel row.
  const myTodaySubmission = eodSubmissions.find(
    (s) => s.storeId === currentStore.id && s.date === todayISO
  );

  const [saving, setSaving] = useState(false);
  const [saveCountdown, setSaveCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, []);

  const [isEditing, setIsEditing] = useState(false);
  const [editCounts, setEditCounts] = useState<Record<string, string>>({});
  const [editCasesCount, setEditCasesCount] = useState<Record<string, string>>({});
  const [editEachCount, setEditEachCount] = useState<Record<string, string>>({});
  const [editNotes, setEditNotes] = useState<Record<string, string>>({});

  // Web-push reminder banner state
  const [pushPermission, setPushPermission] = useState<'granted' | 'denied' | 'default' | 'unsupported'>(() => getPushPermission());
  const [enablingPush, setEnablingPush] = useState(false);

  // "Next reminder in X min" chip + edit-lock check — ticks every minute.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Past-deadline lock: once the clock crosses the relevant EOD deadline,
  // nobody can submit or edit today's count anymore. Fresh business-day
  // unlocks automatically when we cross 3 AM.
  //
  // Per-vendor: each vendor can override the store-wide deadline via
  // vendor.eodDeadlineTime. When the user has a vendor pill selected, the
  // lock follows that vendor's effective deadline. With no vendor selected
  // (e.g. "show all items" mode), we fall back to the store-wide deadline.
  const effectiveDeadlineFor = (vendorName: string | null): string | undefined => {
    if (vendorName) {
      const v = vendors.find((x) => x.name === vendorName);
      if (v?.eodDeadlineTime) return v.eodDeadlineTime;
    }
    return currentStore.eodDeadlineTime;
  };

  const isPastDeadline = (deadline: string | undefined): boolean => {
    if (!deadline || !/^\d{1,2}:\d{2}$/.test(deadline)) return false;
    const [dh, dm] = deadline.split(':').map(Number);
    const tz = timezone || 'America/New_York';
    const wall = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const calendarToday = `${wall.year}-${wall.month}-${wall.day}`;
    const businessDate = businessToday.dateISO;
    // Overnight grace (00:00–02:59): business-today carries yesterday's date,
    // so any same-day deadline is already past.
    if (calendarToday !== businessDate) return true;
    const nowMin = Number(wall.hour) * 60 + Number(wall.minute);
    const deadlineMin = dh * 60 + dm;
    return nowMin > deadlineMin;
  };

  const lockedForCurrentVendor = useMemo(() => {
    void nowTick; // retrigger every minute
    return isPastDeadline(effectiveDeadlineFor(vendorFilter || null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorFilter, vendors, currentStore.eodDeadlineTime, timezone, businessToday.dateISO, nowTick]);

  const effectiveDeadlineLabel = effectiveDeadlineFor(vendorFilter || null) || '22:00';

  // Where does the displayed deadline come from? Drives the "(vendor
  // override)" / "(store-wide)" suffix in the locked banner so the user
  // can tell at a glance whether they're seeing a custom override or the
  // inherited store-wide value (without this, two different sources can
  // render identical text and look like a bug).
  const effectiveDeadlineSource: 'override' | 'store' | 'default' = (() => {
    if (vendorFilter) {
      const v = vendors.find((x) => x.name === vendorFilter);
      if (v?.eodDeadlineTime) return 'override';
    }
    if (currentStore.eodDeadlineTime) return 'store';
    return 'default'; // hardcoded 22:00 fallback in the label
  })();

  const nextReminderLabel = useMemo(() => {
    void nowTick; // dependency trigger
    // Active vendor's effective deadline — falls back to store-wide. Critical
    // because the user looks at this chip to know how much time is left, and
    // they're working on the currently-selected vendor.
    const deadline = effectiveDeadlineFor(vendorFilter || null);
    if (!deadline || !/^\d{1,2}:\d{2}$/.test(deadline)) return null;
    // Business-day-aware past check. Without this, the 00:00–02:59 overnight
    // grace period reads "minutes until today's 22:00" (positive, future)
    // even though the BUSINESS day's 22:00 already passed and the count is
    // locked. Defer to lockedForCurrentVendor (uses isPastDeadline) so chip
    // and banner agree.
    if (lockedForCurrentVendor) {
      return { text: `Past ${deadline} deadline`, ok: false };
    }
    if (!!myTodaySubmission) return { text: '✓ Submitted for today', ok: true };
    const [dh, dm] = deadline.split(':').map(Number);
    // Current wall-clock in the app's timezone (same as store's local time).
    const tz = useStore.getState().timezone || 'America/New_York';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const localMin = Number(parts.hour) * 60 + Number(parts.minute);
    const cutoffMin = dh * 60 + dm;
    const minutesUntilCutoff = cutoffMin - localMin;
    // Find the next upcoming reminder bucket (60/30/10 min before cutoff).
    const buckets = [60, 30, 10];
    const next = buckets
      .map((b) => ({ b, triggersIn: minutesUntilCutoff - b }))
      .filter((x) => x.triggersIn >= 0)
      .sort((a, b) => a.triggersIn - b.triggersIn)[0];
    if (!next) {
      // Past all three buckets but before cutoff
      return { text: `Cutoff at ${deadline} in ${minutesUntilCutoff} min`, ok: false };
    }
    if (next.triggersIn === 0) return { text: `${deadline} cutoff · reminder now (${next.b} min before)`, ok: false };
    return { text: `${deadline} cutoff · next reminder in ${next.triggersIn} min`, ok: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorFilter, vendors, currentStore.eodDeadlineTime, nowTick, myTodaySubmission, lockedForCurrentVendor]);

  const handleEnableReminders = async () => {
    if (!currentUser?.id) return;
    setEnablingPush(true);
    const result = await requestPermissionAndSubscribe(currentUser.id);
    setEnablingPush(false);
    setPushPermission(getPushPermission());
    if (result.ok) {
      Toast.show({ type: 'success', text1: 'Reminders on', text2: `You'll be notified 60 / 30 / 10 min before the EOD deadline.`, visibilityTime: 3500 });
      return;
    }
    // Map each failure code to a user-readable cause so we can diagnose without dev tools.
    const messages: Record<string, { text1: string; text2: string; type: 'error' | 'info' }> = {
      'unsupported': { type: 'info', text1: 'Not supported', text2: 'This browser does not support web push.' },
      'no-vapid': { type: 'error', text1: 'Config missing', text2: 'Server is missing the VAPID public key.' },
      'no-user': { type: 'error', text1: 'Not logged in', text2: 'Re-login and try again.' },
      'permission-denied': { type: 'info', text1: 'Reminders blocked', text2: 'Allow notifications in your OS/browser settings.' },
      'permission-default': { type: 'info', text1: 'Permission needed', text2: 'Permission prompt dismissed — tap Enable again.' },
      'sw-register-failed': { type: 'error', text1: 'Service worker error', text2: 'Could not register /sw.js.' },
      'subscribe-failed': { type: 'error', text1: 'Subscribe failed', text2: 'iOS? Add to Home Screen and open from there.' },
      'subscription-incomplete': { type: 'error', text1: 'Invalid subscription', text2: 'Missing endpoint or keys from the browser.' },
      'save-failed': { type: 'error', text1: 'Server save failed', text2: 'Check push_subscriptions table permissions.' },
    };
    const info = messages[result.code] || { type: 'error' as const, text1: 'Unknown error', text2: result.code };
    const detail = result.detail ? `${info.text2}\n(${result.code}: ${result.detail.slice(0, 80)})` : `${info.text2}\n(${result.code})`;
    Toast.show({ type: info.type, text1: info.text1, text2: detail, visibilityTime: 6000 });
    // Also log full error to console for Safari Web Inspector debugging.
    console.error('[EOD reminders] enable failed', result);
  };
  const showReminderBanner =
    Platform.OS === 'web' &&
    pushPermission !== 'granted' &&
    pushPermission !== 'unsupported' &&
    !!currentStore.eodDeadlineTime;

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

  // Pre-compute which vendor pills are past their effective deadline so each
  // pill can render its own 🔒 + dimmed styling without recomputing on every
  // render. Recomputed when the minute-tick fires.
  const lockedVendors = useMemo(() => {
    void nowTick; // retrigger every minute
    const set = new Set<string>();
    for (const v of vendorNames) {
      if (isPastDeadline(effectiveDeadlineFor(v))) set.add(v);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorNames, vendors, currentStore.eodDeadlineTime, timezone, businessToday.dateISO, nowTick]);

  // Items scoped to the current vendor filter. Everything else (category pills,
  // counts, progress bar, filledCount) derives from this so the whole screen
  // reflects the vendor you're working on.
  const vendorScopedItems = useMemo(() => {
    if (!vendorFilter) return baseItems;
    return baseItems.filter((i) => i.vendorName === vendorFilter);
  }, [baseItems, vendorFilter]);

  // Categories present within the current vendor, with per-category counts.
  const categories = useMemo(
    () => [...new Set(vendorScopedItems.map((i) => i.category))].sort(),
    [vendorScopedItems]
  );
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    vendorScopedItems.forEach((i) => {
      counts[i.category] = (counts[i.category] || 0) + 1;
    });
    return counts;
  }, [vendorScopedItems]);

  // Keep vendorFilter valid: if the currently-selected vendor isn't in the
  // day's list (e.g., the user changed day), snap to the first available one.
  // If there are no vendors at all, clear the filter.
  useEffect(() => {
    if (vendorNames.length === 0) {
      if (vendorFilter) setVendorFilter('');
      return;
    }
    if (!vendorFilter || !vendorNames.includes(vendorFilter)) {
      setVendorFilter(vendorNames[0]);
    }
  }, [vendorNames, vendorFilter]);

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

  // Completion maps — checkmark on each pill when every inventory item in that
  // group has an entry in today's submission. Derived from myTodaySubmission so
  // it reflects the persisted state, not in-progress typing.
  const { completedVendors, completedCategories } = useMemo(() => {
    const vendors = new Set<string>();
    const categories = new Set<string>();
    if (!myTodaySubmission) return { completedVendors: vendors, completedCategories: categories };
    const countedItemIds = new Set(myTodaySubmission.entries.map((e) => e.itemId));

    // Vendors: complete when every base item with that vendor name has an entry.
    for (const vendor of vendorNames) {
      const items = baseItems.filter((i) => i.vendorName === vendor);
      if (items.length > 0 && items.every((i) => countedItemIds.has(i.id))) {
        vendors.add(vendor);
      }
    }
    // Categories: complete when every item in that category WITHIN THE CURRENT
    // VENDOR is counted. Scoped to vendor so switching vendors recomputes.
    const allCats = [...new Set(vendorScopedItems.map((i) => i.category))];
    for (const cat of allCats) {
      const items = vendorScopedItems.filter((i) => i.category === cat);
      if (items.length > 0 && items.every((i) => countedItemIds.has(i.id))) {
        categories.add(cat);
      }
    }
    return { completedVendors: vendors, completedCategories: categories };
  }, [myTodaySubmission, baseItems, vendorNames, vendorScopedItems]);

  // Pre-fill counts from previous submission so user can see what's been counted
  useEffect(() => {
    if (myTodaySubmission && Object.keys(counts).length === 0) {
      const prefilled: Record<string, string> = {};
      const prefilledCases: Record<string, string> = {};
      const prefilledEach: Record<string, string> = {};
      const prefilledNotes: Record<string, string> = {};
      myTodaySubmission.entries.forEach((e: any) => {
        prefilled[e.itemId] = String(e.actualRemaining);
        const item = inventory.find((i) => i.id === e.itemId);
        const caseQty = item?.caseQty || 1;
        const hasCaseInfo = (item?.casePrice || 0) > 0 && caseQty > 1;
        if (hasCaseInfo) {
          if (e.actualRemainingCases !== undefined && e.actualRemainingCases !== null) {
            prefilledCases[e.itemId] = String(e.actualRemainingCases);
            prefilledEach[e.itemId] = String(e.actualRemainingEach ?? 0);
          } else {
            // Legacy entry — back-derive from actualRemaining
            const total = e.actualRemaining || 0;
            const cases = Math.floor(total / caseQty);
            const each = total - cases * caseQty;
            prefilledCases[e.itemId] = String(cases);
            prefilledEach[e.itemId] = String(each);
          }
        }
        if (e.notes) prefilledNotes[e.itemId] = e.notes;
      });
      if (Object.keys(prefilled).length > 0) {
        setCounts(prefilled);
        setCasesCount(prefilledCases);
        setEachCount(prefilledEach);
        setNotes((prev) => ({ ...prev, ...prefilledNotes }));
      }
    }
  }, [myTodaySubmission, inventory]);

  const updateCount = (id: string, value: string) => {
    setCounts((prev) => ({ ...prev, [id]: value }));
  };

  // Count filled items within the current vendor scope (progress bar + submit
  // button reflect just the vendor the user is working on).
  const filledCount = vendorScopedItems.filter((item) => {
    const caseQty = item.caseQty || 1;
    const hasCaseInfo = (item.casePrice || 0) > 0 && caseQty > 1;
    if (hasCaseInfo) {
      return (casesCount[item.id] !== undefined && casesCount[item.id] !== '')
        || (eachCount[item.id] !== undefined && eachCount[item.id] !== '');
    }
    return counts[item.id] !== undefined && counts[item.id] !== '';
  }).length;

  // Shared cloud-save flow for both fresh submits and edits. Drives the 3 s
  // "Saving to cloud... Xs" banner and returns whether the write made it to
  // the server so callers can toast success vs local-only. Both handleSubmit
  // and handleUpdate build the same Omit<EODSubmission,'id'> payload and hand
  // it to submitEODCount, which upserts on (store_id, date) — one row per
  // store per day, anyone with access edits the same row.
  const persistToCloud = async (submission: Parameters<typeof submitEODCount>[0]): Promise<boolean> => {
    setSaving(true);
    setSaveCountdown(3);
    const cloudSave = submitEODCount(submission).catch((err) => {
      // Log loudly — before this, silent failures meant the user saw "saved
      // locally" and we had no way to tell if it was network, RLS, or a code
      // bug.
      console.warn('[EOD] cloud save failed:', err?.message || err, err);
      return null;
    });
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
    return cloudResult !== null;
  };

  const handleSubmit = () => {
    const entries: EODEntry[] = storeInventory
      .filter((item) => {
        const caseQty = item.caseQty || 1;
        const hasCaseInfo = (item.casePrice || 0) > 0 && caseQty > 1;
        if (hasCaseInfo) {
          return (casesCount[item.id] !== undefined && casesCount[item.id] !== '')
            || (eachCount[item.id] !== undefined && eachCount[item.id] !== '');
        }
        return counts[item.id] !== undefined && counts[item.id] !== '';
      })
      .map((item) => {
        const caseQty = item.caseQty || 1;
        const hasCaseInfo = (item.casePrice || 0) > 0 && caseQty > 1;
        const cases = parseFloat(casesCount[item.id]) || 0;
        const each = parseFloat(eachCount[item.id]) || 0;
        const legacy = parseFloat(counts[item.id]) || 0;
        const total = hasCaseInfo ? (cases * caseQty) + each : legacy;
        return {
          id: `eod-${item.id}-${Date.now()}`,
          itemId: item.id,
          itemName: item.name,
          actualRemaining: total,
          actualRemainingCases: hasCaseInfo ? cases : undefined,
          actualRemainingEach: hasCaseInfo ? each : undefined,
          unit: item.unit,
          submittedBy: currentUser?.name || '',
          submittedByUserId: currentUser?.id || '',
          timestamp: new Date().toISOString(),
          date: todayISO,
          storeId: currentStore.id,
          notes: notes[item.id] || '',
        };
      });

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
      setCasesCount({});
      setEachCount({});
      setNotes({});
      setSearch('');
      setSelectedCategory(null);

      // Save to cloud + 3s minimum delay
      const ok = await persistToCloud(submission);
      addNotification(`${currentStore.name} by ${currentUser?.name || 'Unknown'} — EOD Count is submitted`);
      Toast.show(
        ok
          ? {
              type: 'success',
              text1: 'EOD Count saved',
              text2: 'Your count has been saved to the cloud.',
              visibilityTime: 4000,
            }
          : {
              type: 'info',
              text1: 'EOD Count saved locally',
              text2: 'Cloud sync unavailable — saved locally.',
              visibilityTime: 4000,
            }
      );
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
    const ecCases: Record<string, string> = {};
    const ecEach: Record<string, string> = {};
    const en: Record<string, string> = {};
    myTodaySubmission.entries.forEach((entry: any) => {
      ec[entry.itemId] = String(entry.actualRemaining);
      en[entry.itemId] = entry.notes || '';
      const item = inventory.find((i) => i.id === entry.itemId);
      const caseQty = item?.caseQty || 1;
      const hasCaseInfo = (item?.casePrice || 0) > 0 && caseQty > 1;
      if (hasCaseInfo) {
        if (entry.actualRemainingCases !== undefined && entry.actualRemainingCases !== null) {
          ecCases[entry.itemId] = String(entry.actualRemainingCases);
          ecEach[entry.itemId] = String(entry.actualRemainingEach ?? 0);
        } else {
          const total = entry.actualRemaining || 0;
          const cases = Math.floor(total / caseQty);
          const each = total - cases * caseQty;
          ecCases[entry.itemId] = String(cases);
          ecEach[entry.itemId] = String(each);
        }
      }
    });
    setEditCounts(ec);
    setEditCasesCount(ecCases);
    setEditEachCount(ecEach);
    setEditNotes(en);
    setIsEditing(true);
  };

  const handleUpdate = async () => {
    if (!myTodaySubmission) return;

    const updatedEntries: EODEntry[] = myTodaySubmission.entries.map((entry) => {
      const item = inventory.find((i) => i.id === entry.itemId);
      const caseQty = item?.caseQty || 1;
      const hasCaseInfo = (item?.casePrice || 0) > 0 && caseQty > 1;
      if (hasCaseInfo) {
        const cases = editCasesCount[entry.itemId] !== undefined
          ? parseFloat(editCasesCount[entry.itemId]) || 0
          : (entry.actualRemainingCases ?? 0);
        const each = editEachCount[entry.itemId] !== undefined
          ? parseFloat(editEachCount[entry.itemId]) || 0
          : (entry.actualRemainingEach ?? 0);
        return {
          ...entry,
          actualRemaining: (cases * caseQty) + each,
          actualRemainingCases: cases,
          actualRemainingEach: each,
          notes: editNotes[entry.itemId] ?? entry.notes,
          timestamp: new Date().toISOString(),
        };
      }
      return {
        ...entry,
        actualRemaining:
          editCounts[entry.itemId] !== undefined
            ? parseFloat(editCounts[entry.itemId]) || 0
            : entry.actualRemaining,
        notes: editNotes[entry.itemId] ?? entry.notes,
        timestamp: new Date().toISOString(),
      };
    });

    const now = new Date().toISOString();

    // Update the submission in the store (local cache — fast UI feedback)
    submitEOD({
      ...myTodaySubmission,
      entries: updatedEntries,
      timestamp: now,
    });

    // Exit edit mode + clear the edit state. We do this BEFORE the cloud save
    // so the read-only "Submitted" view snaps back immediately; the 3 s
    // "Saving to cloud..." banner covers the round-trip.
    setIsEditing(false);
    setEditCounts({});
    setEditCasesCount({});
    setEditEachCount({});
    setEditNotes({});

    // Persist to Supabase so the edits survive refresh — before this was wired
    // up, handleUpdate only touched local state and the DB kept the stale
    // pre-edit row. The upsert on submitEODCount updates the same parent row
    // (keyed on store_id + date) and replaces eod_entries wholesale.
    if (!currentStore || !currentUser) return;
    const submission = {
      date: myTodaySubmission.date,
      storeId: currentStore.id,
      storeName: currentStore.name,
      submittedBy: currentUser.name || '',
      submittedByUserId: currentUser.id || '',
      timestamp: now,
      itemCount: updatedEntries.length,
      status: 'submitted' as const,
      entries: updatedEntries,
    };

    const ok = await persistToCloud(submission);
    addNotification(`${currentStore.name} by ${currentUser.name || 'Unknown'} — EOD Count updated`);
    Toast.show(
      ok
        ? {
            type: 'success',
            text1: 'EOD Count updated',
            text2: 'Your edits have been saved to the cloud.',
            visibilityTime: 4000,
          }
        : {
            type: 'info',
            text1: 'EOD Count saved locally',
            text2: 'Cloud sync unavailable — saved locally.',
            visibilityTime: 4000,
          }
    );
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
      <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
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
              {myTodaySubmission.entries.length} item(s) counted by {myTodaySubmission.submittedBy || 'Unknown'}
            </Text>
          </View>
        </View>

        {/* Edit button — disabled past the EOD deadline */}
        {lockedForCurrentVendor ? (
          <View style={[styles.editBtn, { backgroundColor: C.dangerBg, borderColor: C.danger + '33' }]}>
            <Ionicons name="lock-closed-outline" size={16} color={C.danger} />
            <Text style={[styles.editBtnText, { color: C.danger }]}>
              Locked — past {effectiveDeadlineLabel} deadline{vendorFilter ? ` for ${vendorFilter}` : ''}
            </Text>
          </View>
        ) : (
          <TouchableOpacity style={[styles.editBtn, { backgroundColor: C.infoBg, borderColor: C.info + '33' }]} onPress={startEditing}>
            <Ionicons name="create-outline" size={16} color={C.info} />
            <Text style={[styles.editBtnText, { color: C.info }]}>Edit today's count</Text>
          </TouchableOpacity>
        )}

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
      </View>
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
      <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
      <TimezoneBar />
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
                const caseQty = item?.caseQty || 1;
                const hasCaseInfo = (item?.casePrice || 0) > 0 && caseQty > 1;
                return (
                  <View key={entry.itemId} style={[styles.itemRow, { borderBottomColor: C.borderLight }]}>
                    <View style={styles.itemInfo}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <Text style={[styles.itemName, { color: C.textPrimary }]}>{entry.itemName}</Text>
                        {!hasCaseInfo && (
                          <View style={{ backgroundColor: C.warningBg, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                            <Text style={{ fontSize: 8, color: C.warning, fontWeight: '600' }}>⚠ No case info</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[styles.itemUnit, { color: C.textTertiary }]}>
                        {hasCaseInfo ? `1 case = ${caseQty} ${entry.unit}` : `Expected: ${item?.currentStock ?? '?'} ${entry.unit}`}
                      </Text>
                    </View>
                    {hasCaseInfo ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ alignItems: 'center' }}>
                          <TextInput
                            style={[styles.countInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, width: 50 }]}
                            keyboardType="decimal-pad"
                            value={editCasesCount[entry.itemId] ?? ''}
                            onChangeText={(v) => setEditCasesCount((prev) => ({ ...prev, [entry.itemId]: numericFilter(v) }))}
                          />
                          <Text style={{ fontSize: 9, color: C.textTertiary, marginTop: 1 }}>cases</Text>
                        </View>
                        <Text style={{ color: C.textTertiary, fontSize: 12 }}>+</Text>
                        <View style={{ alignItems: 'center' }}>
                          <TextInput
                            style={[styles.countInput, { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, width: 50 }]}
                            keyboardType="decimal-pad"
                            value={editEachCount[entry.itemId] ?? ''}
                            onChangeText={(v) => setEditEachCount((prev) => ({ ...prev, [entry.itemId]: numericFilter(v) }))}
                          />
                          <Text style={{ fontSize: 9, color: C.textTertiary, marginTop: 1 }}>each</Text>
                        </View>
                      </View>
                    ) : (
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
                    )}
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
              setEditCasesCount({});
              setEditEachCount({});
              setEditNotes({});
            }}
          >
            <Text style={[styles.draftBtnText, { color: C.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.submitBtn, { backgroundColor: C.textPrimary }, (saving || lockedForCurrentVendor) && { opacity: 0.4 }]}
            onPress={handleUpdate}
            disabled={saving || lockedForCurrentVendor}
          >
            <Text style={[styles.submitBtnText, { color: C.bgPrimary }]}>
              {saving
                ? `Saving... ${saveCountdown}s`
                : lockedForCurrentVendor
                ? 'Locked — past deadline'
                : 'Save changes'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </WebScrollView>
      </View>
    );
  }

  // ── New count view ──────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
    <TimezoneBar />
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

      {/* Reminder-enable banner (web only, when permission isn't yet granted) */}
      {showReminderBanner && (
        <View style={[styles.notice, { backgroundColor: C.warningBg, marginTop: 0, alignItems: 'center' }]}>
          <Ionicons name="notifications-outline" size={18} color={C.warning} />
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: C.warning }}>
              Turn on EOD reminders
            </Text>
            <Text style={{ fontSize: 11, color: C.warning, marginTop: 2 }}>
              Get a push at 60 / 30 / 10 min before the {currentStore.eodDeadlineTime} cutoff, even when the app is closed.
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleEnableReminders}
            disabled={enablingPush || pushPermission === 'denied'}
            style={{ backgroundColor: C.warning, paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.sm, opacity: enablingPush ? 0.6 : 1 }}
          >
            <Text style={{ color: C.bgPrimary, fontSize: FontSize.xs, fontWeight: '600' }}>
              {pushPermission === 'denied' ? 'Blocked' : enablingPush ? 'Enabling…' : 'Enable'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* "Next reminder in X min" chip — visible once reminders are enabled and a deadline is set */}
      {nextReminderLabel && !showReminderBanner && (
        <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm, flexDirection: 'row' }}>
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 6,
            backgroundColor: nextReminderLabel.ok === true ? C.successBg : nextReminderLabel.ok === false ? C.warningBg : C.bgSecondary,
            paddingHorizontal: 10, paddingVertical: 5, borderRadius: Radius.round,
          }}>
            <Ionicons
              name={nextReminderLabel.ok === true ? 'checkmark-circle-outline' : 'time-outline'}
              size={13}
              color={nextReminderLabel.ok === true ? C.success : nextReminderLabel.ok === false ? C.warning : C.textSecondary}
            />
            <Text style={{
              fontSize: 11, fontWeight: '500',
              color: nextReminderLabel.ok === true ? C.success : nextReminderLabel.ok === false ? C.warning : C.textSecondary,
            }}>
              {nextReminderLabel.text}
            </Text>
          </View>
        </View>
      )}

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
                {dayLabels[day] || day.slice(0, 3)}
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
              All ({vendorScopedItems.length})
            </Text>
          </TouchableOpacity>
          {categories.map((cat) => {
            const count = categoryCounts[cat] || 0;
            const isActive = selectedCategory === cat;
            const done = completedCategories.has(cat);
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.pill, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }, isActive && styles.pillActive, isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary }, done && !isActive && { backgroundColor: C.successBg, borderColor: C.success }]}
                onPress={() => setSelectedCategory(isActive ? null : cat)}
              >
                {done && (
                  <Ionicons name="checkmark-circle" size={12} color={isActive ? C.bgPrimary : C.success} style={{ marginRight: 4 }} />
                )}
                <Text style={[styles.pillText, { color: C.textSecondary }, isActive && { color: C.bgPrimary }, done && !isActive && { color: C.success, fontWeight: '600' }]}>
                  {cat} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Vendor filter pills — always one vendor selected, no "All vendors" */}
      {vendorNames.length > 0 && (
        <View style={styles.pillWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pillRow}>
            {vendorNames.map((v) => {
              const isActive = vendorFilter === v;
              const done = completedVendors.has(v);
              const locked = lockedVendors.has(v);
              // Show every vendor's effective deadline so staff don't have
              // to remember which vendors got overrides. Falls back to the
              // store-wide value or the hardcoded '22:00' so each pill
              // always carries a time and the row stays visually uniform.
              const cutoffLabel = effectiveDeadlineFor(v) || '22:00';
              return (
                <TouchableOpacity
                  key={v}
                  style={[
                    styles.pill,
                    { backgroundColor: C.bgPrimary, borderColor: C.borderLight },
                    isActive && styles.pillActive,
                    isActive && { backgroundColor: C.textPrimary, borderColor: C.textPrimary },
                    done && !isActive && { backgroundColor: C.successBg, borderColor: C.success },
                    // Locked styling beats both default and "done" — but stays
                    // beneath isActive so the active pill always pops.
                    locked && !isActive && { backgroundColor: C.dangerBg, borderColor: C.danger, opacity: 0.7 },
                  ]}
                  onPress={() => setVendorFilter(v)}
                >
                  {locked ? (
                    // Lock takes precedence over the checkmark — if the
                    // deadline passed without a count, "done" stops mattering
                    // (you can't change it now anyway).
                    <Ionicons name="lock-closed" size={11} color={isActive ? C.bgPrimary : C.danger} style={{ marginRight: 4 }} />
                  ) : done ? (
                    <Ionicons name="checkmark-circle" size={12} color={isActive ? C.bgPrimary : C.success} style={{ marginRight: 4 }} />
                  ) : null}
                  <Text style={[
                    styles.pillText,
                    { color: C.textSecondary },
                    isActive && { color: C.bgPrimary },
                    done && !isActive && !locked && { color: C.success, fontWeight: '600' },
                    locked && !isActive && { color: C.danger, fontWeight: '600' },
                  ]}>
                    {v} ({vendorCounts[v]}) · {cutoffLabel}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Progress indicator — scoped to the current vendor */}
      <View style={styles.progressRow}>
        <Text style={[styles.progressText, { color: C.textSecondary }]}>
          {filledCount} of {vendorScopedItems.length} items counted
          {vendorFilter ? ` · ${vendorFilter}` : ''}
        </Text>
        <View style={[styles.progressBar, { backgroundColor: C.borderLight }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${vendorScopedItems.length > 0 ? (filledCount / vendorScopedItems.length) * 100 : 0}%`, backgroundColor: C.success },
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
            {catItems.map((item) => {
              const caseQty = item.caseQty || 1;
              const hasCaseInfo = (item.casePrice || 0) > 0 && caseQty > 1;
              return (
                <View key={item.id} style={[styles.itemRow, { borderBottomColor: C.borderLight }]}>
                  <View style={styles.itemInfo}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <Text style={[styles.itemName, { color: C.textPrimary }]}>{item.name}</Text>
                      {!hasCaseInfo && (
                        <View style={{ backgroundColor: C.warningBg, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                          <Text style={{ fontSize: 8, color: C.warning, fontWeight: '600' }}>⚠ No case info</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.itemUnit, { color: C.textTertiary }]}>
                      {hasCaseInfo ? `1 case = ${caseQty} ${item.unit}` : `Expected: ${item.currentStock} ${item.unit}`}
                    </Text>
                  </View>
                  {hasCaseInfo ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ alignItems: 'center' }}>
                        <TextInput
                          style={[
                            styles.countInput,
                            { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, width: 50 },
                            casesCount[item.id] ? [styles.countInputFilled, { borderColor: C.success, backgroundColor: C.successBg }] : null,
                          ]}
                          placeholder="0"
                          placeholderTextColor={C.textTertiary}
                          keyboardType="decimal-pad"
                          value={casesCount[item.id] || ''}
                          onChangeText={(v) => setCasesCount((prev) => ({ ...prev, [item.id]: numericFilter(v) }))}
                        />
                        <Text style={{ fontSize: 9, color: C.textTertiary, marginTop: 1 }}>cases</Text>
                      </View>
                      <Text style={{ color: C.textTertiary, fontSize: 12 }}>+</Text>
                      <View style={{ alignItems: 'center' }}>
                        <TextInput
                          style={[
                            styles.countInput,
                            { color: C.textPrimary, backgroundColor: C.bgSecondary, borderColor: C.borderMedium, width: 50 },
                            eachCount[item.id] ? [styles.countInputFilled, { borderColor: C.success, backgroundColor: C.successBg }] : null,
                          ]}
                          placeholder="0"
                          placeholderTextColor={C.textTertiary}
                          keyboardType="decimal-pad"
                          value={eachCount[item.id] || ''}
                          onChangeText={(v) => setEachCount((prev) => ({ ...prev, [item.id]: numericFilter(v) }))}
                        />
                        <Text style={{ fontSize: 9, color: C.textTertiary, marginTop: 1 }}>each</Text>
                      </View>
                    </View>
                  ) : (
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
                  )}
                  <TextInput
                    style={[styles.noteInput, { color: C.textSecondary, backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
                    placeholder="Note..."
                    placeholderTextColor={C.textTertiary}
                    value={notes[item.id] || ''}
                    onChangeText={(v) => setNotes((prev) => ({ ...prev, [item.id]: v }))}
                  />
                </View>
              );
            })}
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

      {/* Locked banner (past the EOD deadline for this business day) */}
      {lockedForCurrentVendor && (
        <View style={{ marginHorizontal: Spacing.lg, marginTop: Spacing.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: Radius.sm, backgroundColor: C.dangerBg, borderWidth: 1, borderColor: C.danger, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="lock-closed-outline" size={18} color={C.danger} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: FontSize.xs, fontWeight: '600', color: C.danger }}>
              {vendorFilter ? `${vendorFilter} count is locked` : "Today's count is locked"}
            </Text>
            <Text style={{ fontSize: 11, color: C.danger, marginTop: 2 }}>
              Past the {effectiveDeadlineLabel} deadline{
                effectiveDeadlineSource === 'override'
                  ? ' (vendor override)'
                  : effectiveDeadlineSource === 'store'
                    ? ' (store-wide)'
                    : ''
              }{vendorFilter ? ` for ${vendorFilter}` : ''}. You can't submit or edit {vendorFilter ? "this vendor's" : "today's"} count anymore.
              {myTodaySubmission ? ' Your earlier submission is preserved.' : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Submit row */}
      <View style={styles.submitRow}>
        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: C.textPrimary }, (saving || lockedForCurrentVendor) && { opacity: 0.4 }]}
          onPress={handleSubmit}
          disabled={saving || lockedForCurrentVendor}
        >
          <Text style={[styles.submitBtnText, { color: C.bgPrimary }]}>
            {saving
              ? 'Saving...'
              : lockedForCurrentVendor
                ? 'Locked — past deadline'
                : myTodaySubmission
                  ? `Update count (${filledCount} item${filledCount !== 1 ? 's' : ''})`
                  : `Submit count (${filledCount} item${filledCount !== 1 ? 's' : ''})`}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </WebScrollView>
    </View>
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
  pill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.round, backgroundColor: Colors.bgPrimary, borderWidth: 0.5, borderColor: Colors.borderLight },
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
