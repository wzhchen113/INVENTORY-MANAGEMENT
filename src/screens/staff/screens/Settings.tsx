// src/screens/staff/screens/Settings.tsx — consolidated staff settings.
//
// Spec 126. A single destination reachable from the gear (⚙) in every
// in-store header. Mounts, in order: the per-device notification toggle
// (`NotificationSwitcher` — whose only prior home, StorePicker, is
// unreachable in-store), the language switcher (`LocaleSwitcher`), the
// zoom/scale switcher (`ScaleSwitcher`), a Report-an-issue form, and a Sign
// out action.
//
// The sign-out block is replicated verbatim from the four in-store screens
// (Reorder.tsx:485) — extracting a shared `useStaffSignOut()` hook is a
// reasonable cleanup but is OUT OF SCOPE here (spec 126 §Frontend surface):
// replicate, do not refactor.

import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { LocaleSwitcher } from '../components/LocaleSwitcher';
import { NotificationSwitcher } from '../components/NotificationSwitcher';
import { ScaleSwitcher } from '../components/ScaleSwitcher';
import { confirmAction } from '../../../utils/confirmAction';
import { supabase } from '../../../lib/supabase';
import { unsubscribeFromPush } from '../../../lib/webPush';
import { notifyBackendError } from '../lib/notifyBackendError';
import { submitStaffReport, type StaffReportCategory } from '../lib/reports';
import { useStaffStore } from '../store/useStaffStore';
import { useI18n } from '../i18n';
import { useStaffColors, useStaffElevation, useStaffTokens, type StaffTokens } from '../theme';

const CATEGORIES: StaffReportCategory[] = ['equipment', 'inventory', 'app_tech', 'other'];

type SubmitState = 'idle' | 'success' | 'error';

export function Settings() {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  const navigation = useNavigation<{ goBack: () => void }>();

  const activeStore = useStaffStore((s) => s.activeStore);
  const setAuthState = useStaffStore((s) => s.setAuthState);
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  // ─── Report-an-issue form (local component state — not a store slice) ──
  const [category, setCategory] = useState<StaffReportCategory>('equipment');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');

  const canSubmit = message.trim().length > 0 && !submitting && !!activeStore;

  const onSubmit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || submitting || !activeStore) return;
    setSubmitting(true);
    setSubmitState('idle');
    try {
      await submitStaffReport(activeStore.id, category, trimmed);
      setMessage('');
      setSubmitState('success');
    } catch (err) {
      notifyBackendError('submitStaffReport', err);
      setSubmitState('error');
    } finally {
      setSubmitting(false);
    }
  }, [activeStore, category, message, submitting]);

  // ─── Sign out — replicated from the in-store screens (spec 126 §Frontend) ──
  const onSignOut = useCallback(() => {
    confirmAction(
      t('chrome.signOut.confirmTitle'),
      t('chrome.signOut.confirmMessage'),
      async () => {
        // Tear down THIS device's web-push subscription BEFORE signOut() so the
        // push_subscriptions delete runs under the authenticated session (RLS
        // owner-scopes it). Best-effort — unsubscribeFromPush swallows its own
        // errors.
        await unsubscribeFromPush();
        try {
          await supabase.auth.signOut();
        } catch (err) {
          notifyBackendError('signOut', err);
        }
        setActiveStore(null);
        Toast.show({ type: 'success', text1: t('chrome.signedOut'), position: 'bottom' });
        setAuthState({ kind: 'signed-out' });
      },
      t('chrome.signOut.label'),
    );
  }, [setAuthState, setActiveStore, t]);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
      testID="staff-settings-root"
    >
      {/* Header — back affordance + title */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          testID="staff-settings-back"
          accessibilityRole="button"
          accessibilityLabel={t('chrome.settings.back')}
          style={({ pressed }) => [
            styles.backBtn,
            pressed ? { backgroundColor: c.surfaceAlt } : null,
          ]}
        >
          <Text style={[styles.backText, { color: c.primary }]}>‹ {t('chrome.settings.back')}</Text>
        </Pressable>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>
          {t('chrome.settings.title')}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollBody}>
        {/* Notifications */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
            {t('chrome.notifications.label')}
          </Text>
          <NotificationSwitcher />
        </View>

        {/* Language */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
            {t('chrome.localeSwitcher.aria')}
          </Text>
          <LocaleSwitcher />
        </View>

        {/* Text size */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
            {t('chrome.scaleSwitcher.aria')}
          </Text>
          <ScaleSwitcher />
        </View>

        {/* Report an issue */}
        <View
          style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
          testID="staff-report-form"
        >
          <Text style={[styles.cardTitle, { color: c.text }]}>{t('chrome.reportIssue.title')}</Text>

          {/* Category segmented picker (LocaleSwitcher three-pill shape, wrapped) */}
          <Text style={[styles.fieldLabel, { color: c.textSecondary }]}>
            {t('chrome.reportIssue.categoryLabel')}
          </Text>
          <View
            style={styles.categoryRow}
            accessibilityRole="radiogroup"
            accessibilityLabel={t('chrome.reportIssue.categoryLabel')}
          >
            {CATEGORIES.map((cat) => {
              const active = cat === category;
              return (
                <Pressable
                  key={cat}
                  onPress={() => setCategory(cat)}
                  testID={`staff-report-category-${cat}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={t(`chrome.reportIssue.category.${cat}`)}
                  style={({ pressed }) => [
                    styles.categoryPill,
                    {
                      backgroundColor: active
                        ? c.primary
                        : pressed
                          ? c.surfaceAlt
                          : 'transparent',
                      borderColor: active ? c.primary : c.borderStrong,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.categoryText,
                      {
                        color: active ? c.textOnPrimary : c.textSecondary,
                        fontWeight: active ? T.typography.semibold : T.typography.medium,
                      },
                    ]}
                  >
                    {t(`chrome.reportIssue.category.${cat}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Free-text message */}
          <View style={styles.messageWrap}>
            <Input
              testID="staff-report-message"
              label={t('chrome.reportIssue.messageLabel')}
              placeholder={t('chrome.reportIssue.messagePlaceholder')}
              value={message}
              onChangeText={(text) => {
                setMessage(text);
                if (submitState !== 'idle') setSubmitState('idle');
              }}
              multiline
              numberOfLines={4}
              // Match the server-side length bound (submit_staff_report CHECK,
              // ≤ 2000) so a long message is capped at input time rather than
              // failing the RPC blind.
              maxLength={2000}
              style={styles.messageInput}
              accessibilityLabel={t('chrome.reportIssue.messageLabel')}
            />
          </View>

          {submitState === 'success' ? (
            <Banner tone="success" testID="staff-report-success" text={t('chrome.reportIssue.success')} />
          ) : null}
          {submitState === 'error' ? (
            <Banner tone="error" testID="staff-report-error" text={t('chrome.reportIssue.error')} />
          ) : null}

          <Button
            label={submitting ? t('chrome.reportIssue.submitting') : t('chrome.reportIssue.submit')}
            onPress={() => void onSubmit()}
            disabled={!canSubmit}
            loading={submitting}
            testID="staff-report-submit"
          />
        </View>

        {/* Sign out */}
        <View style={styles.signOutWrap}>
          <Button
            label={t('chrome.signOut.label')}
            onPress={onSignOut}
            variant="secondary"
            testID="staff-settings-sign-out"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderBottomWidth: 1,
    gap: T.spacing.xs,
  },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingRight: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  backText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.semibold,
  },
  title: {
    fontSize: T.typography.headline,
    fontWeight: T.typography.bold,
  },
  scrollBody: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.xxxl,
    gap: T.spacing.xl,
  },
  section: {
    gap: T.spacing.sm,
  },
  sectionLabel: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  card: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    padding: T.spacing.lg,
    gap: T.spacing.md,
  },
  cardTitle: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.bold,
  },
  fieldLabel: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.medium,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: T.spacing.sm,
  },
  categoryPill: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.lg,
    borderWidth: 1,
    borderRadius: T.radius.pill,
  },
  categoryText: {
    fontSize: T.typography.caption,
  },
  messageWrap: {
    gap: T.spacing.xs,
  },
  messageInput: {
    minHeight: 96,
    paddingTop: T.spacing.sm,
    textAlignVertical: 'top',
  },
  signOutWrap: {
    marginTop: T.spacing.sm,
  },
});
