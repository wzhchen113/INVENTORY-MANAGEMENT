// src/components/index.tsx
import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ViewStyle, TextStyle,
} from 'react-native';
import { Colors, useColors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { ItemStatus } from '../types';

// ─── Card ────────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}
export const Card: React.FC<CardProps> = ({ children, style, padding = Spacing.md }) => {
  const C = useColors();
  return (
    <View style={[styles.card, { padding, backgroundColor: C.bgPrimary, borderColor: C.borderLight }, style]}>{children}</View>
  );
};

// ─── CardHeader ──────────────────────────────────────────
interface CardHeaderProps {
  title: string;
  right?: React.ReactNode;
}
export const CardHeader: React.FC<CardHeaderProps> = ({ title, right }) => {
  const C = useColors();
  return (
    <View style={styles.cardHeader}>
      <Text style={[styles.cardTitle, { color: C.textPrimary }]}>{title}</Text>
      {right}
    </View>
  );
};

// ─── KPI Card ─────────────────────────────────────────────
interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}
export const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, variant = 'default' }) => {
  const C = useColors();
  const valueColor = {
    default: C.textPrimary,
    success: C.success,
    warning: C.warning,
    danger: C.danger,
  }[variant];
  return (
    <View style={[styles.kpi, { backgroundColor: C.bgSecondary }]}>
      <Text style={[styles.kpiLabel, { color: C.textSecondary }]}>{label}</Text>
      <Text style={[styles.kpiValue, { color: valueColor }]}>{value}</Text>
      {sub ? <Text style={[styles.kpiSub, { color: C.textTertiary }]}>{sub}</Text> : null}
    </View>
  );
};

// ─── Badge ───────────────────────────────────────────────
type BadgeVariant = 'ok' | 'low' | 'out' | 'admin' | 'user' | 'draft' | 'sent' | 'received' | 'partial' | 'match' | 'mismatch' | 'review' | 'pending' | 'expired';

interface BadgeProps {
  label: string;
  variant: BadgeVariant;
}
export const Badge: React.FC<BadgeProps> = ({ label, variant }) => {
  const C = useColors();
  const conf: Record<BadgeVariant, { bg: string; text: string }> = {
    ok:       { bg: C.successBg, text: C.success },
    low:      { bg: C.warningBg, text: C.warning },
    out:      { bg: C.dangerBg, text: C.danger },
    admin:    { bg: C.infoBg, text: C.info },
    user:     { bg: C.successBg, text: C.success },
    draft:    { bg: '#F1EFE8', text: '#444441' },
    sent:     { bg: C.infoBg, text: C.info },
    received: { bg: C.successBg, text: C.success },
    partial:  { bg: C.warningBg, text: C.warning },
    match:    { bg: C.successBg, text: C.success },
    mismatch: { bg: C.dangerBg, text: C.danger },
    review:   { bg: C.warningBg, text: C.warning },
    pending:  { bg: C.warningBg, text: C.warning },
    expired:  { bg: C.dangerBg, text: C.danger },
  };
  const { bg, text } = conf[variant] || conf.ok;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: text }]}>{label}</Text>
    </View>
  );
};

// ─── Status Badge ────────────────────────────────────────
export const StatusBadge: React.FC<{ status: ItemStatus }> = ({ status }) => {
  const C = useColors();
  const map: Record<ItemStatus, { label: string; variant: BadgeVariant }> = {
    ok: { label: 'OK', variant: 'ok' },
    low: { label: 'Low', variant: 'low' },
    out: { label: 'Out', variant: 'out' },
  };
  const { label, variant } = map[status];
  return <Badge label={label} variant={variant} />;
};

// ─── Who Chip (user attribution) ─────────────────────────
interface WhoChipProps {
  name: string;
  color: string;
  time?: string;
}
export const WhoChip: React.FC<WhoChipProps> = ({ name, color, time }) => {
  const C = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={[styles.whoChip, { borderColor: C.borderLight, backgroundColor: C.bgSecondary }]}>
        <View style={[styles.whoDot, { backgroundColor: color }]} />
        <Text style={[styles.whoText, { color: C.textSecondary }]}>{name}</Text>
      </View>
      {time ? <Text style={[styles.timeText, { color: C.textTertiary }]}>{time}</Text> : null}
    </View>
  );
};

// ─── Progress Bar ─────────────────────────────────────────
interface ProgressBarProps {
  value: number; // 0–100
  status: ItemStatus;
}
export const ProgressBar: React.FC<ProgressBarProps> = ({ value, status }) => {
  const C = useColors();
  const color = { ok: C.success, low: C.warning, out: C.danger }[status];
  return (
    <View style={[styles.progressBg, { backgroundColor: C.borderLight }]}>
      <View style={[styles.progressFill, { width: `${Math.min(100, value)}%`, backgroundColor: color }]} />
    </View>
  );
};

// ─── Button ──────────────────────────────────────────────
interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}
export const Button: React.FC<ButtonProps> = ({
  title, onPress, variant = 'secondary', size = 'md', loading, disabled, style,
}) => {
  const C = useColors();
  const bg = { primary: C.textPrimary, secondary: C.bgPrimary, danger: C.dangerBg }[variant];
  const textColor = { primary: C.white, secondary: C.textPrimary, danger: C.danger }[variant];
  const pad = { sm: { paddingVertical: 5, paddingHorizontal: 10 }, md: { paddingVertical: 8, paddingHorizontal: 14 }, lg: { paddingVertical: 11, paddingHorizontal: 18 } }[size];
  const fontSize = { sm: FontSize.xs, md: FontSize.sm, lg: FontSize.base }[size];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={[styles.button, { backgroundColor: bg, borderColor: C.borderMedium, ...pad, opacity: disabled ? 0.5 : 1 }, style]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <Text style={[styles.buttonText, { color: textColor, fontSize }]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
};

// ─── Section Header ───────────────────────────────────────
export const SectionHeader: React.FC<{ title: string; style?: ViewStyle }> = ({ title, style }) => {
  const C = useColors();
  return (
    <Text style={[styles.sectionHeader, { color: C.textTertiary }, style]}>{title.toUpperCase()}</Text>
  );
};

// ─── Empty State ──────────────────────────────────────────
export const EmptyState: React.FC<{ message: string }> = ({ message }) => {
  const C = useColors();
  return (
    <View style={styles.emptyState}>
      <Text style={[styles.emptyText, { color: C.textTertiary }]}>{message}</Text>
    </View>
  );
};

// ─── Row ──────────────────────────────────────────────────
export const Row: React.FC<{ children: React.ReactNode; style?: ViewStyle }> = ({ children, style }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>
);

// ─── Divider ─────────────────────────────────────────────
export const Divider: React.FC = () => {
  const C = useColors();
  return (
    <View style={{ height: 0.5, backgroundColor: C.borderLight, marginVertical: Spacing.xs }} />
  );
};

// ─── Styles ──────────────────────────────────────────────
const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.lg,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
    marginBottom: Spacing.md,
    ...Shadow.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  cardTitle: {
    fontSize: FontSize.base,
    fontWeight: '500',
    color: Colors.textPrimary,
  },
  kpi: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    flex: 1,
  },
  kpiLabel: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginBottom: 3,
  },
  kpiValue: {
    fontSize: 20,
    fontWeight: '500',
  },
  kpiSub: {
    fontSize: 9,
    color: Colors.textTertiary,
    marginTop: 2,
  },
  badge: {
    borderRadius: Radius.round,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '500',
  },
  whoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.round,
    borderWidth: 0.5,
  },
  whoDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  whoText: {
    fontSize: 10,
    color: Colors.textSecondary,
  },
  timeText: {
    fontSize: 9,
    color: Colors.textTertiary,
  },
  progressBg: {
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.borderLight,
    marginTop: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
  },
  button: {
    borderRadius: Radius.md,
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  buttonText: {
    fontWeight: '500',
  },
  sectionHeader: {
    fontSize: 9,
    fontWeight: '600',
    color: Colors.textTertiary,
    letterSpacing: 0.6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.xxxl,
  },
  emptyText: {
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
  },
});
