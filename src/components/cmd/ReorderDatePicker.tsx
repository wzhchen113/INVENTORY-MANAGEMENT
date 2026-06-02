// src/components/cmd/ReorderDatePicker.tsx
//
// Spec 087 — Cmd-native month-grid calendar for the Reorder section.
//
// Structurally mirrors src/components/DatePicker.tsx (RN Modal +
// TouchableOpacity, fully cross-platform for web + native) but:
//   - themed via `useCmdColors()` (NOT `useColors()`) so it matches the
//     Cmd shell — DatePicker is consumed by the Light/Dark reports
//     surface and is left untouched (architect decision C).
//   - `value` is never empty: a date is ALWAYS selected. There is no
//     Clear affordance; the footer has a single "Today" action.
//   - future-disable: cells whose ISO date > `maxDate` are de-emphasized
//     and non-pressable. `maxDate` is today (latest selectable date).
//   - active-day highlight: a selectable cell whose weekday is in
//     `activeWeekdays` gets an accent dot — kept visually distinct from
//     the today ring and the selected fill (three distinguishable
//     states).

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { weekdayName } from '../../utils/reorderDayFilter';
import type { DayName } from '../../utils/enumLabels';

interface ReorderDatePickerProps {
  /** Selected date, 'YYYY-MM-DD'. Never ''. */
  value: string;
  onChange: (isoDate: string) => void;
  /** 'YYYY-MM-DD' — latest selectable date (today). Cells > maxDate are disabled. */
  maxDate: string;
  /** Weekdays to highlight (the focal store's order-out days). */
  activeWeekdays: ReadonlySet<DayName>;
  testIdPrefix?: string;
}

// Spec 091 A4 — kept single-letter (option a). The T/T and S/S pairs are
// ambiguous, but: (1) the grid cell is 1/7 of a ≤320px-wide modal at 9.5px,
// where the i18n 3-letter short labels (`WED`, etc.) risk truncation; and
// (2) wiring `dayOfWeekShortLabel` would add a `useT` dependency this
// component otherwise has none of (it mirrors DatePicker.tsx, which is also
// i18n-free). The unambiguous long weekday name is surfaced elsewhere (the
// trigger pill + the cell accessibilityLabel), so the header glyphs stay
// minimal. See spec 091 for the (a)-vs-(b) trade-off.
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

export default function ReorderDatePicker({
  value,
  onChange,
  maxDate,
  activeWeekdays,
  testIdPrefix = 'reorder-datepicker',
}: ReorderDatePickerProps) {
  const C = useCmdColors();
  const [open, setOpen] = useState(false);

  // Parse a YYYY-MM-DD value at LOCAL midnight (never UTC — avoids an
  // off-by-one when the runtime TZ is behind UTC). `value` is always present.
  const parseLocalDate = (v?: string): Date => (v ? new Date(`${v}T00:00:00`) : new Date());
  // Lazy initial view = the selected month (the parse runs once, on mount).
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
    // Defensive: never let a future date through, even if a press lands.
    if (dateStr > maxDate) return;
    onChange(dateStr);
    setOpen(false);
  };

  const goToday = () => {
    const t = new Date(`${maxDate}T00:00:00`);
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
    onChange(maxDate);
    setOpen(false);
  };

  // Build the calendar grid (leading blanks + days + trailing blanks).
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const openModal = () => {
    // Sync the grid to the CURRENT selected value each time we open.
    const d = parseLocalDate(value);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setOpen(true);
  };

  return (
    <View>
      {/* Closed-state trigger — bordered-pill matching the CSV/PDF/REFRESH
          buttons in ReorderSection (mono, borderStrong). */}
      <TouchableOpacity
        testID={`${testIdPrefix}-trigger`}
        accessibilityRole="button"
        accessibilityLabel="Select reorder date"
        onPress={openModal}
        style={[styles.trigger, { borderColor: C.borderStrong, borderRadius: CmdRadius.sm }]}
      >
        <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>
          {value ? formatDisplay(value) : 'DATE'}
        </Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity
          style={styles.overlay}
          activeOpacity={1}
          onPress={() => setOpen(false)}
        >
          {/* Inner pressable swallows taps so they don't close the modal. */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => { /* swallow */ }}
            style={[
              styles.calendar,
              { backgroundColor: C.panel, borderColor: C.border, borderRadius: CmdRadius.lg },
            ]}
          >
            {/* Header */}
            <View style={styles.header}>
              <TouchableOpacity
                testID={`${testIdPrefix}-prev-month`}
                onPress={prevMonth}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                style={styles.navBtn}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 16, color: C.fg }}>‹</Text>
              </TouchableOpacity>
              <Text style={{ fontFamily: mono(600), fontSize: 13, color: C.fg }}>
                {MONTHS[viewMonth]} {viewYear}
              </Text>
              <TouchableOpacity
                testID={`${testIdPrefix}-next-month`}
                onPress={nextMonth}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                style={styles.navBtn}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 16, color: C.fg }}>›</Text>
              </TouchableOpacity>
            </View>

            {/* Day-of-week labels */}
            <View style={styles.dayRow}>
              {DAY_LABELS.map((d, i) => (
                <Text
                  key={i}
                  style={[styles.dayLabel, { fontFamily: mono(600), color: C.fg3 }]}
                >
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
                  <TouchableOpacity
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
                        isToday && !isSelected && { borderWidth: 1.5, borderColor: C.info },
                        isSelected && { backgroundColor: C.accent },
                      ]}
                    >
                      <Text
                        style={[
                          { fontFamily: mono(isSelected ? 700 : 400), fontSize: 12 },
                          { color: isFuture ? C.fg3 : C.fg },
                          isFuture && { opacity: 0.45 },
                          isToday && !isSelected && { color: C.info, fontFamily: mono(700) },
                          isSelected && { color: C.accentFg },
                        ]}
                      >
                        {day}
                      </Text>
                    </View>
                    {/* Active-day marker — separate glyph, renders regardless of
                        today/selected so the three states don't collide. */}
                    {isActive ? (
                      <View
                        testID={`${testIdPrefix}-active-${day}`}
                        style={[
                          styles.activeDot,
                          { backgroundColor: isSelected ? C.accentFg : C.accent },
                        ]}
                      />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Footer — single "Today" action (no Clear). */}
            <View style={[styles.footer, { borderTopColor: C.border }]}>
              <TouchableOpacity
                testID={`${testIdPrefix}-today`}
                onPress={goToday}
                accessibilityRole="button"
                accessibilityLabel="Jump to today"
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accent, letterSpacing: 0.3 }}>
                  TODAY
                </Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  calendar: {
    width: '100%',
    maxWidth: 320,
    borderWidth: 1,
    padding: 16,
    ...(Platform.OS === 'web' ? ({ boxShadow: '0 12px 32px rgba(0,0,0,0.28)' } as object) : {}),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  navBtn: { paddingHorizontal: 8, paddingVertical: 2 },
  dayRow: { flexDirection: 'row', marginBottom: 6 },
  dayLabel: { flex: 1, textAlign: 'center', fontSize: 9.5, letterSpacing: 0.3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellInner: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    bottom: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
  },
});
