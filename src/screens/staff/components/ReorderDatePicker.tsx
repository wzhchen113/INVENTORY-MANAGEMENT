// src/screens/staff/components/ReorderDatePicker.tsx
//
// Spec 089 (D) — staff-themed month-grid calendar for the staff Reorder
// screen. A structural port of `src/components/cmd/ReorderDatePicker.tsx`
// (RN Modal + Pressable, cross-platform web + native) but:
//   - themed via `useStaffColors()` (NOT `useCmdColors()` / `mono()`) so it
//     matches the OS-light/dark staff theme. The Cmd picker is hard-wired to
//     the Cmd palette + mono font on every cell, so a focused staff copy is
//     cleaner than threading a theme prop through it (architect (D)).
//   - sized for touch (≥44pt trigger + cells per `touchTarget.min`).
//   - imports the SHARED `weekdayName` from `reorderDayFilter.ts` (the
//     locale-invariant parser — do NOT re-implement; its two traps are
//     load-bearing) and takes the same props as the Cmd one.
//
// `value` is never empty (a date is ALWAYS selected); future-disable on
// cells > `maxDate`; active-day highlight (the store's order-out weekdays)
// as a dot kept distinct from the today ring + selected fill.

import { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { weekdayName } from '../../../utils/reorderDayFilter';
import type { DayName } from '../../../utils/enumLabels';
import { radius, spacing, touchTarget, typography, useStaffColors, useStaffElevation } from '../theme';

interface ReorderDatePickerProps {
  /** Selected date, 'YYYY-MM-DD'. Never ''. */
  value: string;
  onChange: (isoDate: string) => void;
  /** 'YYYY-MM-DD' — latest selectable date (today). Cells > maxDate are disabled. */
  maxDate: string;
  /** Weekdays to highlight (the active store's order-out days). */
  activeWeekdays: ReadonlySet<DayName>;
  testIdPrefix?: string;
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function formatDisplay(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]?.slice(0, 3)} ${d}, ${y}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function ReorderDatePicker({
  value,
  onChange,
  maxDate,
  activeWeekdays,
  testIdPrefix = 'staff-reorder-datepicker',
}: ReorderDatePickerProps) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const [open, setOpen] = useState(false);

  // Parse a YYYY-MM-DD value at LOCAL midnight (never UTC — avoids an
  // off-by-one when the runtime TZ is behind UTC). `value` is always present.
  const parseLocalDate = (v?: string): Date => (v ? new Date(`${v}T00:00:00`) : new Date());
  const [viewYear, setViewYear] = useState(() => parseLocalDate(value).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => parseLocalDate(value).getMonth());

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const selectDay = (dateStr: string) => {
    if (dateStr > maxDate) return; // defensive — never let a future date through
    onChange(dateStr);
    setOpen(false);
  };

  const goToday = () => {
    const today = new Date(`${maxDate}T00:00:00`);
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    onChange(maxDate);
    setOpen(false);
  };

  const openModal = () => {
    // Sync the grid to the CURRENT selected value each time we open.
    const d = parseLocalDate(value);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setOpen(true);
  };

  // Build the calendar grid (leading blanks + days + trailing blanks).
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <View>
      {/* Closed-state trigger — a pill matching the staff Refresh control. */}
      <Pressable
        testID={`${testIdPrefix}-trigger`}
        accessibilityRole="button"
        accessibilityLabel="Select reorder date"
        onPress={openModal}
        style={({ pressed }) => [
          styles.trigger,
          { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
        ]}
      >
        <Text style={[styles.triggerText, { color: c.text }]}>
          {value ? formatDisplay(value) : 'Date'}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade">
        <Pressable style={[styles.overlay, { backgroundColor: c.overlay }]} onPress={() => setOpen(false)}>
          {/* Inner pressable swallows taps so they don't close the modal. */}
          <Pressable
            onPress={() => {
              /* swallow */
            }}
            style={[styles.calendar, { backgroundColor: c.surface, borderColor: c.border }, e.modal]}
          >
            {/* Header */}
            <View style={styles.header}>
              <Pressable
                testID={`${testIdPrefix}-prev-month`}
                onPress={prevMonth}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                style={styles.navBtn}
              >
                <Text style={[styles.navGlyph, { color: c.text }]}>‹</Text>
              </Pressable>
              <Text style={[styles.monthLabel, { color: c.text }]}>
                {MONTHS[viewMonth]} {viewYear}
              </Text>
              <Pressable
                testID={`${testIdPrefix}-next-month`}
                onPress={nextMonth}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                style={styles.navBtn}
              >
                <Text style={[styles.navGlyph, { color: c.text }]}>›</Text>
              </Pressable>
            </View>

            {/* Day-of-week labels */}
            <View style={styles.dayRow}>
              {DAY_LABELS.map((d, i) => (
                <Text key={i} style={[styles.dayLabel, { color: c.textSecondary }]}>
                  {d}
                </Text>
              ))}
            </View>

            {/* Date grid */}
            <View style={styles.grid}>
              {cells.map((day, i) => {
                if (day === null) return <View key={i} style={styles.cell} />;
                const dateStr = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
                const isSelected = dateStr === value;
                const isToday = dateStr === maxDate;
                const isFuture = dateStr > maxDate;
                const dayWeekday = weekdayName(dateStr);
                const isActive = !isFuture && dayWeekday !== null && activeWeekdays.has(dayWeekday);

                return (
                  <Pressable
                    key={i}
                    testID={`${testIdPrefix}-day-${day}`}
                    disabled={isFuture}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: isFuture, selected: isSelected }}
                    accessibilityLabel={`${MONTHS[viewMonth]} ${day}, ${viewYear}${isActive ? ' — order-out day' : ''}`}
                    onPress={() => selectDay(dateStr)}
                    style={styles.cell}
                  >
                    <View
                      style={[
                        styles.cellInner,
                        isToday && !isSelected ? { borderWidth: 1.5, borderColor: c.info } : null,
                        isSelected ? { backgroundColor: c.primary } : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.cellText,
                          { color: isFuture ? c.textTertiary : c.text },
                          isFuture ? { opacity: 0.5 } : null,
                          isToday && !isSelected ? { color: c.info, fontWeight: typography.bold } : null,
                          isSelected ? { color: c.textOnPrimary, fontWeight: typography.bold } : null,
                        ]}
                      >
                        {day}
                      </Text>
                    </View>
                    {/* Active-day marker — separate glyph so the three states
                        (today / selected / active) don't collide. */}
                    {isActive ? (
                      <View
                        testID={`${testIdPrefix}-active-${day}`}
                        style={[styles.activeDot, { backgroundColor: isSelected ? c.textOnPrimary : c.primary }]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            {/* Footer — single "Today" action (no Clear). */}
            <View style={[styles.footer, { borderTopColor: c.border }]}>
              <Pressable
                testID={`${testIdPrefix}-today`}
                onPress={goToday}
                accessibilityRole="button"
                accessibilityLabel="Jump to today"
                style={styles.todayBtn}
              >
                <Text style={[styles.todayText, { color: c.primary }]}>Today</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  triggerText: {
    fontSize: typography.body,
    fontWeight: typography.medium,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  calendar: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  navBtn: {
    minWidth: touchTarget.min,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navGlyph: {
    fontSize: 24,
    fontWeight: typography.bold,
  },
  monthLabel: {
    fontSize: typography.bodyLarge,
    fontWeight: typography.semibold,
  },
  dayRow: { flexDirection: 'row', marginBottom: spacing.xs },
  dayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: typography.caption,
    fontWeight: typography.semibold,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: {
    fontSize: typography.body,
    fontWeight: typography.regular,
  },
  activeDot: {
    position: 'absolute',
    bottom: 2,
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
  },
  todayBtn: {
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  todayText: {
    fontSize: typography.body,
    fontWeight: typography.bold,
    ...(Platform.OS === 'web' ? { letterSpacing: 0.3 } : {}),
  },
});
