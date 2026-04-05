// src/components/index.tsx
import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, ViewStyle, TextStyle,
} from 'react-native';
import { Colors, Spacing, Radius, FontSize, Shadow } from '../theme/colors';
import { ItemStatus } from '../types';

// ─── Card ────────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
}
export const Card: React.FC<CardProps> = ({ children, style, padding = Spacing.md }) => (
  <View style={[styles.card, { padding }, style]}>{children}</View>
);

// ─── CardHeader ──────────────────────────────────────────
interface CardHeaderProps {
  title: string;
  right?: React.ReactNode;
}
export const CardHeader: React.FC<CardHeaderProps> = ({ title, right }) => (
  <View style={styles.cardHeader}>
    <Text style={styles.cardTitle}>{title}</Text>
    {right}
  </View>
);

// ─── KPI Card ─────────────────────────────────────────────
interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}
export const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, variant = 'default' }) => {
  const valueColor = {
    default: Colors.textPrimary,
    success: Colors.success,
    warning: Colors.warning,
    danger: Colors.danger,
  }[variant];
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color: valueColor }]}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
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
  const conf: Record<BadgeVariant, { bg: string; text: string }> = {
    ok:       { bg: Colors.successBg, text: Colors.success },
    low:      { bg: Colors.warningBg, text: Colors.warning },
    out:      { bg: Colors.dangerBg, text: Colors.danger },
    admin:    { bg: Colors.infoBg, text: Colors.info },
    user:     { bg: Colors.successBg, text: Colors.success },
    draft:    { bg: '#F1EFE8', text: '#444441' },
    sent:     { bg: Colors.infoBg, text: Colors.info },
    received: { bg: Colors.successBg, text: Colors.success },
    partial:  { bg: Colors.warningBg, text: Colors.warning },
    match:    { bg: Colors.successBg, text: Colors.success },
    mismatch: { bg: Colors.dangerBg, text: Colors.danger },
    review:   { bg: Colors.warningBg, text: Colors.warning },
    pending:  { bg: Colors.warningBg, text: Colors.warning },
    expired:  { bg: Colors.dangerBg, text: Colors.danger },
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
export const WhoChip: React.FC<WhoChipProps> = ({ name, color, time }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
    <View style={[styles.whoChip, { borderColor: Colors.borderLight }]}>
      <View style={[styles.whoDot, { backgroundColor: color }]} />
      <Text style={styles.whoText}>{name}</Text>
    </View>
    {time ? <Text style={styles.timeText}>{time}</Text> : null}
  </View>
);

// ─── Progress Bar ─────────────────────────────────────────
interface ProgressBarProps {
  value: number; // 0–100
  status: ItemStatus;
}
export const ProgressBar: React.FC<ProgressBarProps> = ({ value, status }) => {
  const color = { ok: Colors.success, low: Colors.warning, out: Colors.danger }[status];
  return (
    <View style={styles.progressBg}>
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
  const bg = { primary: Colors.textPrimary, secondary: Colors.bgPrimary, danger: Colors.dangerBg }[variant];
  const textColor = { primary: Colors.white, secondary: Colors.textPrimary, danger: Colors.danger }[variant];
  const pad = { sm: { paddingVertical: 5, paddingHorizontal: 10 }, md: { paddingVertical: 8, paddingHorizontal: 14 }, lg: { paddingVertical: 11, paddingHorizontal: 18 } }[size];
  const fontSize = { sm: FontSize.xs, md: FontSize.sm, lg: FontSize.base }[size];
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      style={[styles.button, { backgroundColor: bg, ...pad, opacity: disabled ? 0.5 : 1 }, style]}
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
export const SectionHeader: React.FC<{ title: string; style?: ViewStyle }> = ({ title, style }) => (
  <Text style={[styles.sectionHeader, style]}>{title.toUpperCase()}</Text>
);

// ─── Empty State ──────────────────────────────────────────
export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <View style={styles.emptyState}>
    <Text style={styles.emptyText}>{message}</Text>
  </View>
);

// ─── Row ──────────────────────────────────────────────────
export const Row: React.FC<{ children: React.ReactNode; style?: ViewStyle }> = ({ children, style }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>
);

// ─── Divider ─────────────────────────────────────────────
export const Divider: React.FC = () => (
  <View style={{ height: 0.5, backgroundColor: Colors.borderLight, marginVertical: Spacing.xs }} />
);

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
