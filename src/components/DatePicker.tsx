// src/components/DatePicker.tsx
import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';

interface DatePickerProps {
  value: string; // YYYY-MM-DD or ''
  onChange: (date: string) => void;
  label?: string;
  placeholder?: string;
}

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

export default function DatePicker({ value, onChange, label, placeholder = 'Select date' }: DatePickerProps) {
  const C = useColors();
  const [open, setOpen] = useState(false);

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Parse current value or default to current month
  const selected = value ? new Date(value + 'T00:00:00') : null;
  const [viewYear, setViewYear] = useState(selected?.getFullYear() || today.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected?.getMonth() ?? today.getMonth());

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  const selectDay = (day: number) => {
    const m = String(viewMonth + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  };

  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    onChange(todayStr);
    setOpen(false);
  };

  const clear = () => {
    onChange('');
    setOpen(false);
  };

  // Build calendar grid
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedStr = value || '';

  return (
    <View>
      {label && <Text style={[styles.label, { color: C.textTertiary }]}>{label}</Text>}
      <TouchableOpacity
        style={[styles.trigger, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
        onPress={() => {
          if (selected) { setViewYear(selected.getFullYear()); setViewMonth(selected.getMonth()); }
          setOpen(true);
        }}
      >
        <Ionicons name="calendar-outline" size={16} color={C.textSecondary} />
        <Text style={[styles.triggerText, { color: value ? C.textPrimary : C.textTertiary }]}>
          {value ? formatDisplay(value) : placeholder}
        </Text>
        {value ? (
          <TouchableOpacity onPress={(e) => { e.stopPropagation(); onChange(''); }}>
            <Ionicons name="close-circle" size={16} color={C.textTertiary} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="chevron-down" size={14} color={C.textTertiary} />
        )}
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade">
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={[styles.calendar, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
            {/* Header */}
            <View style={styles.header}>
              <TouchableOpacity onPress={prevMonth} style={styles.navBtn}>
                <Ionicons name="chevron-back" size={20} color={C.textPrimary} />
              </TouchableOpacity>
              <Text style={[styles.monthYear, { color: C.textPrimary }]}>
                {MONTHS[viewMonth]} {viewYear}
              </Text>
              <TouchableOpacity onPress={nextMonth} style={styles.navBtn}>
                <Ionicons name="chevron-forward" size={20} color={C.textPrimary} />
              </TouchableOpacity>
            </View>

            {/* Day labels */}
            <View style={styles.dayRow}>
              {DAYS.map((d, i) => (
                <Text key={i} style={[styles.dayLabel, { color: C.textTertiary }]}>{d}</Text>
              ))}
            </View>

            {/* Date grid */}
            <View style={styles.grid}>
              {cells.map((day, i) => {
                if (day === null) return <View key={i} style={styles.cell} />;
                const m = String(viewMonth + 1).padStart(2, '0');
                const d = String(day).padStart(2, '0');
                const dateStr = `${viewYear}-${m}-${d}`;
                const isSelected = dateStr === selectedStr;
                const isToday = dateStr === todayStr;
                return (
                  <TouchableOpacity
                    key={i}
                    style={[
                      styles.cell,
                      isToday && !isSelected && [styles.todayCell, { borderColor: C.info }],
                      isSelected && [styles.selectedCell, { backgroundColor: C.textPrimary }],
                    ]}
                    onPress={() => selectDay(day)}
                  >
                    <Text style={[
                      styles.cellText,
                      { color: C.textPrimary },
                      isToday && !isSelected && { color: C.info, fontWeight: '600' },
                      isSelected && { color: C.bgPrimary, fontWeight: '700' },
                    ]}>
                      {day}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Footer */}
            <View style={styles.footer}>
              <TouchableOpacity onPress={clear}>
                <Text style={[styles.footerBtn, { color: C.danger }]}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={goToday}>
                <Text style={[styles.footerBtn, { color: C.info }]}>Today</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: FontSize.xs, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 },
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.md, borderWidth: 0.5,
  },
  triggerText: { flex: 1, fontSize: FontSize.sm, fontWeight: '500' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: Spacing.xl },
  calendar: {
    width: '100%', maxWidth: 340, borderRadius: Radius.xl, borderWidth: 0.5,
    padding: Spacing.lg,
    ...({ boxShadow: '0 12px 32px rgba(0,0,0,0.2)' } as any),
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.md },
  navBtn: { padding: 4 },
  monthYear: { fontSize: FontSize.base, fontWeight: '600' },
  dayRow: { flexDirection: 'row', marginBottom: Spacing.xs },
  dayLabel: { flex: 1, textAlign: 'center', fontSize: FontSize.xs, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '14.28%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  cellText: { fontSize: FontSize.sm },
  todayCell: { borderWidth: 1.5, borderRadius: 20 },
  selectedCell: { borderRadius: 20 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.md, paddingTop: Spacing.sm },
  footerBtn: { fontSize: FontSize.sm, fontWeight: '600' },
});
