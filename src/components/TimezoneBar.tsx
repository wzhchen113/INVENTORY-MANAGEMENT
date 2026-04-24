// src/components/TimezoneBar.tsx
//
// Shared header strip showing the store's active time zone + the current
// local date/time. Rendered at the top of every page so the operator
// always sees what "now" the app is using to compute the business day,
// today's-EOD lookup, the suggested-orders date roll-over, etc.
//
// Tap behavior:
//   - admin / master → opens the timezone picker modal (writes to useStore)
//   - everyone else  → no-op (the store's TZ is store-wide config)

import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { TIMEZONES, getNowInTZ } from '../utils/timezone';

export const TimezoneBar: React.FC = () => {
  const C = useColors();
  const timezone = useStore((s) => s.timezone);
  const setTimezone = useStore((s) => s.setTimezone);
  const currentUser = useStore((s) => s.currentUser);
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';

  const [showModal, setShowModal] = useState(false);
  // Force a re-render every minute so the displayed time stays current
  // while the user sits on a page.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const currentLabel = TIMEZONES.find((t) => t.value === timezone)?.label || timezone;
  const now = getNowInTZ(timezone);

  return (
    <>
      <TouchableOpacity
        style={[styles.bar, { backgroundColor: C.bgPrimary, borderBottomColor: C.borderLight }]}
        onPress={() => isAdmin && setShowModal(true)}
        activeOpacity={isAdmin ? 0.6 : 1}
      >
        <Ionicons name="time-outline" size={14} color={C.textTertiary} />
        <Text style={[styles.label, { color: C.textSecondary }]}>{currentLabel}</Text>
        <Text style={[styles.date, { color: C.textTertiary }]}>
          {now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          {' \u00B7 '}
          {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </Text>
        {isAdmin && <Ionicons name="chevron-forward" size={12} color={C.textTertiary} />}
      </TouchableOpacity>

      <Modal visible={showModal} animationType="fade" transparent>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setShowModal(false)}>
          <View style={[styles.dropdown, { backgroundColor: C.bgPrimary }]}>
            <Text style={[styles.dropdownTitle, { color: C.textTertiary }]}>Time zone</Text>
            {TIMEZONES.map((tz) => {
              const active = tz.value === timezone;
              return (
                <TouchableOpacity
                  key={tz.value}
                  style={[styles.option, active && { backgroundColor: C.successBg }]}
                  onPress={() => { setTimezone(tz.value); setShowModal(false); }}
                >
                  <Text style={[styles.optionText, { color: C.textPrimary }, active && { fontWeight: '600' }]}>{tz.label}</Text>
                  {active && <Ionicons name="checkmark" size={16} color={C.success} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.bgPrimary,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  label: { fontSize: FontSize.xs, fontWeight: '500', color: Colors.textSecondary },
  date:  { flex: 1, fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'right', marginRight: 4 },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    paddingTop: 60,
    paddingLeft: Spacing.lg,
  },
  dropdown: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    minWidth: 220,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  dropdownTitle: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md,
    marginBottom: 2,
  },
  optionText: { fontSize: FontSize.sm, color: Colors.textPrimary },
});
