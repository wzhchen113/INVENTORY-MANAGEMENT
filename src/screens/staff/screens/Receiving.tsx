// src/screens/staff/screens/Receiving.tsx — the staff Receiving screen.
//
// Spec 113 (frontend slice). A staff-facing equivalent of the admin
// ReceivingSection PO-driven mode, reflowed for a portrait phone in the staff
// theme, MINUS the price column (R-1: staff record delivered quantities → stock,
// never prices):
//   - lists the active store's OPEN POs (status ∈ {sent, partial}), newest-first,
//     each with a short id, a status pill, the vendor name, and the date; a clear
//     empty state when there are none (AC-7).
//   - picking a PO loads its real po_items lines and renders, per line: item name,
//     ordered qty, already-received qty, outstanding remainder, and a numeric
//     "received now" input PREFILLED to the outstanding remainder max(0, ordered −
//     received). NO case-price input, NO cost display of any kind (AC-8).
//   - a Commit builds the this-receive ADDITIVE deltas (skipping zero rows),
//     confirms (receiving mutates stock — mirrors the admin commit confirm), and
//     calls the receive RPC with a client uuid minted once per commit (AC-9/10).
//   - online-only (R-2): the commit is disabled + an offline banner shows when
//     useConnectionStatus reports offline; a receive cannot be submitted offline
//     (AC-11). No offline queue.
//   - success → toast + list refresh (a now-fully-received PO leaves the list); a
//     conflict:true replay is treated as success-no-reapply; an error surfaces via
//     notifyStaffBackendError and leaves the inputs intact (AC-12).
//   - no realtime (AC-14): refresh on focus (useFocusEffect) + after a commit + a
//     manual Refresh affordance.
//
// Scope: the manager's `activeStore` (shared with EOD / Reorder / Weekly). Data
// via the staff carve-out (receiving.ts), screen-local `useState` (no
// useStaffStore slice — the Reorder/Weekly decision-B pattern).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { ListRow } from '../components/ListRow';
import { SettingsGear } from '../components/SettingsGear';
import { AppReloadButton } from '../components/AppReloadButton';
import { NotificationReminderBanner } from '../components/NotificationReminderBanner';
import { confirmAction } from '../../../utils/confirmAction';
import { notifyBackendError } from '../lib/notifyBackendError';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { uuidv4 } from '../lib/uuid';
import {
  buildReceiveDeltas,
  fetchStaffOpenPos,
  fetchStaffPoLines,
  outstandingRemainder,
  submitStaffReceive,
  type StaffOpenPo,
  type StaffPoLine,
} from '../lib/receiving';
import { useStaffStore } from '../store/useStaffStore';
import { getLocalizedName } from '../../../i18n/localizedName';
import { t, useI18n } from '../i18n';
import {
  useStaffColors,
  useStaffElevation,
  useStaffTokens,
  type StaffTokens,
} from '../theme';

// A short, human-scannable id for the PO list + detail header. UUIDs are long;
// the last 6 chars (uppercased) are enough to disambiguate a store's open POs
// at a glance (mirrors the admin PO list's short-id treatment). Pure — no i18n.
function shortPoId(id: string): string {
  const tail = id.replace(/-/g, '').slice(-6);
  return tail ? `#${tail.toUpperCase()}` : '#';
}

// ── status pill ─────────────────────────────────────────────────────
function StatusPill({ status }: { status: 'sent' | 'partial' }) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const { t } = useI18n();
  // sent → info (teal); partial → warning (amber). Both read on the dark theme.
  const tone = status === 'partial' ? c.warning : c.info;
  const bg = status === 'partial' ? c.warningBg : c.infoBg;
  const label = status === 'partial' ? t('receiving.list.statusPartial') : t('receiving.list.statusSent');
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: tone }]}>{label}</Text>
    </View>
  );
}

// ── empty / loading / error state card ──────────────────────────────
function StateCard({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const c = useStaffColors();
  const e = useStaffElevation();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  return (
    <View
      testID={testID}
      style={[styles.stateCard, { backgroundColor: c.surface, borderColor: c.border }, e.card]}
    >
      <Text style={[styles.stateTitle, { color: c.textSecondary }]}>{title}</Text>
      <Text style={[styles.stateBody, { color: c.textTertiary }]}>{body}</Text>
    </View>
  );
}

export function Receiving() {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  // Reactive `t` (spec 099) — render-path strings re-translate on locale change.
  const { t } = useI18n();
  // Reactive locale slice — item names resolve via getLocalizedName(line, locale),
  // so reading it directly re-renders the list labels on a locale switch.
  const locale = useStaffStore((s) => s.locale);
  const activeStore = useStaffStore((s) => s.activeStore);
  const stores = useStaffStore((s) =>
    s.authState.kind === 'signed-in' ? s.authState.stores : [],
  );
  const setActiveStore = useStaffStore((s) => s.setActiveStore);

  // Online-only gate (R-2). Disables the commit + shows an offline banner.
  const isOnline = useConnectionStatus();

  const [pos, setPos] = useState<StaffOpenPo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Selected PO detail — its lines + the per-line "received now" input map (keyed
  // by poItemId), seeded to the outstanding remainder on load.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<StaffPoLine[]>([]);
  const [linesLoading, setLinesLoading] = useState<boolean>(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);

  const canSwitchStore = stores.length > 1;

  // ─── load the open POs for the active store ────────────────────────
  const loadPos = useCallback(
    (storeId: string) => {
      setLoading(true);
      setError(null);
      fetchStaffOpenPos(storeId)
        .then((next) => setPos(next))
        .catch((err) => {
          notifyBackendError('fetchStaffOpenPos', err);
          setPos([]);
          setError(err instanceof Error ? err.message : String(err ?? t('receiving.error.title')));
        })
        .finally(() => setLoading(false));
    },
    [t],
  );

  // Initial + store-switch load. Clears any in-progress selection so a stale PO
  // from the previous store can't linger.
  useEffect(() => {
    if (!activeStore?.id) return;
    setSelectedId(null);
    setLines([]);
    setInputs({});
    loadPos(activeStore.id);
  }, [activeStore?.id, loadPos]);

  // Refresh on focus (OQ-5 / AC-14) — the staff app has no realtime, so re-fetch
  // the open-PO list when the tab regains focus. Skips the very first focus (the
  // mount effect above already loaded) by keying on a ref, so we don't double-load
  // on the initial render.
  const didInitialFocusRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!activeStore?.id) return;
      if (!didInitialFocusRef.current) {
        didInitialFocusRef.current = true;
        return;
      }
      loadPos(activeStore.id);
    }, [activeStore?.id, loadPos]),
  );

  // ─── load the selected PO's lines + seed the inputs ────────────────
  const loadLines = useCallback((poId: string) => {
    setLinesLoading(true);
    fetchStaffPoLines(poId)
      .then((loaded) => {
        setLines(loaded);
        const seed: Record<string, string> = {};
        for (const ln of loaded) {
          seed[ln.poItemId] = String(outstandingRemainder(ln));
        }
        setInputs(seed);
      })
      .catch((err) => {
        notifyBackendError('fetchStaffPoLines', err);
        setLines([]);
        setInputs({});
      })
      .finally(() => setLinesLoading(false));
  }, []);

  const onPickPo = useCallback(
    (poId: string) => {
      setSelectedId(poId);
      setLines([]);
      setInputs({});
      loadLines(poId);
    },
    [loadLines],
  );

  const onBackToList = useCallback(() => {
    setSelectedId(null);
    setLines([]);
    setInputs({});
  }, []);

  const selectedPo = useMemo(
    () => pos.find((p) => p.id === selectedId) ?? null,
    [pos, selectedId],
  );

  // If the selected PO drops out of the list on a refresh (e.g. it was fully
  // received), fall back to the list view so the detail pane can't dangle.
  useEffect(() => {
    if (selectedId && !pos.some((p) => p.id === selectedId)) {
      setSelectedId(null);
      setLines([]);
      setInputs({});
    }
  }, [pos, selectedId]);

  const refresh = useCallback(() => {
    if (!activeStore?.id) return;
    loadPos(activeStore.id);
    if (selectedId) loadLines(selectedId);
  }, [activeStore?.id, selectedId, loadPos, loadLines]);

  // ─── commit — confirm-gated, additive, online-only ─────────────────
  const runReceive = useCallback(
    (poId: string, deltas: ReturnType<typeof buildReceiveDeltas>) => {
      // Mint the client uuid ONCE per commit (idempotency — AC-10). A double-tap
      // / in-flight retry dedupes server-side.
      const clientUuid = uuidv4();
      setSubmitting(true);
      submitStaffReceive(poId, deltas, clientUuid)
        .then((result) => {
          // A conflict:true envelope is an idempotent REPLAY (server already
          // deduped) — treat it as SUCCESS-no-reapply, not an error (AC-4/12).
          const statusLabel =
            result.status === 'received'
              ? t('receiving.success.received')
              : t('receiving.success.partial');
          Toast.show({
            type: 'success',
            text1: t('receiving.success.message'),
            text2: statusLabel,
            position: 'bottom',
          });
          // Refresh the list (a now-fully-received PO leaves it) and return to the
          // list view. The re-fetch is the refresh trigger (no realtime — AC-14).
          onBackToList();
          if (activeStore?.id) loadPos(activeStore.id);
        })
        .catch((err) => {
          // A backend error (incl. the AC-2 42501 should staff ever reach it)
          // surfaces via notifyBackendError and leaves the inputs intact — no
          // phantom success, no list refresh.
          notifyBackendError('submitStaffReceive', err);
        })
        .finally(() => setSubmitting(false));
    },
    [activeStore?.id, loadPos, onBackToList, t],
  );

  const onCommit = useCallback(() => {
    if (!selectedPo || submitting) return;
    // Online-only (R-2) — block a commit while offline. The button is also
    // disabled; this early-return is the belt (mirrors the WeeklyCount idiom).
    if (!isOnline) {
      Toast.show({ type: 'error', text1: t('receiving.offline.message'), position: 'bottom' });
      return;
    }
    const deltas = buildReceiveDeltas(lines, inputs);
    if (deltas.length === 0) {
      Toast.show({ type: 'error', text1: t('receiving.nothingToReceive.message'), position: 'bottom' });
      return;
    }
    const total = deltas.reduce((sum, d) => sum + d.receivedQty, 0);
    // Commit mutates stock, so it is confirm-gated like the admin commit
    // (ReceivingSection.tsx:242) — via the shared cross-platform confirm util.
    confirmAction(
      t('receiving.commit.confirmTitle'),
      t('receiving.commit.confirmMessage', { count: deltas.length, total }),
      () => runReceive(selectedPo.id, deltas),
      t('receiving.commit.confirmCta'),
    );
  }, [selectedPo, submitting, isOnline, lines, inputs, runReceive, t]);

  // Defensive guard — placed AFTER all hooks so the hook count stays stable
  // across renders (same discipline as Reorder/WeeklyCount). The tab bar only
  // mounts with an active store, so this is defense-in-depth.
  if (!activeStore) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: c.bgAlt }]} edges={['top', 'bottom']}>
        <View style={styles.centerPane}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const onSwitchStore = () => {
    if (!canSwitchStore) return;
    setActiveStore(null);
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: c.bgAlt }]}
      edges={['top', 'bottom']}
      testID="staff-receiving-root"
    >
      {/* Header — store name (tap to switch) + sign out */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={onSwitchStore}
            disabled={!canSwitchStore}
            accessibilityRole={canSwitchStore ? 'button' : 'none'}
            accessibilityLabel={canSwitchStore ? t('chrome.switchStore') : undefined}
            testID="staff-receiving-store-name"
            style={({ pressed }) => [
              styles.storePressable,
              pressed && canSwitchStore ? { backgroundColor: c.surfaceAlt } : null,
            ]}
          >
            <Text
              style={[styles.storeName, { color: canSwitchStore ? c.primary : c.text }]}
              numberOfLines={1}
            >
              {activeStore.name}
            </Text>
            <Text style={[styles.headerSub, { color: c.textSecondary }]}>{t('receiving.title')}</Text>
          </Pressable>
          <AppReloadButton />
          <SettingsGear />
        </View>

        {/* Controls — refresh (list view) or back (detail view) */}
        <View style={styles.controlsRow}>
          {selectedPo ? (
            <Pressable
              testID="staff-receiving-back"
              onPress={onBackToList}
              accessibilityRole="button"
              accessibilityLabel={t('receiving.back')}
              style={({ pressed }) => [
                styles.controlBtn,
                { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
              ]}
            >
              <Text style={[styles.controlText, { color: c.text }]}>{t('receiving.back')}</Text>
            </Pressable>
          ) : null}
          <Pressable
            testID="staff-receiving-refresh"
            onPress={refresh}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={t('receiving.refresh')}
            style={({ pressed }) => [
              styles.controlBtn,
              { borderColor: c.borderStrong, backgroundColor: pressed ? c.surfaceAlt : c.surface },
              loading ? { opacity: 0.5 } : null,
            ]}
          >
            <Text style={[styles.controlText, { color: c.text }]}>
              {loading ? t('receiving.loading') : t('receiving.refresh')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Persistent "turn on notifications" nudge — RED, non-dismissible,
          disappears once notifications are on. */}
      <NotificationReminderBanner />

      {/* Offline banner (R-2 / AC-11) — receiving needs a live connection. */}
      {!isOnline ? (
        <Banner tone="warning" text={t('receiving.offline.message')} testID="staff-receiving-offline" />
      ) : null}

      {/* Error pane (retry-able) */}
      {error ? (
        <View
          testID="staff-receiving-error"
          style={[styles.errorPane, { backgroundColor: c.errorBg, borderColor: c.error }]}
        >
          <Text style={[styles.errorText, { color: c.error }]}>{t('receiving.error.title')}</Text>
          <Text style={[styles.errorDetail, { color: c.error }]}>{error}</Text>
          <Pressable
            testID="staff-receiving-retry"
            onPress={refresh}
            accessibilityRole="button"
            accessibilityLabel={t('receiving.error.retry')}
            style={[styles.retryBtn, { borderColor: c.error }]}
          >
            <Text style={[styles.retryText, { color: c.error }]}>{t('receiving.error.retry')}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Initial loading state — no POs yet, no error */}
      {loading && !error ? (
        <View style={styles.centerPane} testID="staff-receiving-loading">
          <ActivityIndicator size="large" color={c.primary} />
          <Text style={[styles.loadingText, { color: c.textSecondary }]}>{t('receiving.loadingBody')}</Text>
        </View>
      ) : null}

      {/* Empty state — no open POs for this store */}
      {!loading && !error && pos.length === 0 ? (
        <View style={styles.scrollBody}>
          <StateCard
            testID="staff-receiving-empty"
            title={t('receiving.list.emptyTitle')}
            body={t('receiving.list.empty')}
          />
        </View>
      ) : null}

      {/* List view — open POs (no selection) */}
      {!loading && !error && pos.length > 0 && !selectedPo ? (
        <ScrollView contentContainerStyle={styles.scrollBody} testID="staff-receiving-list">
          {pos.map((po) => (
            <ListRow
              key={po.id}
              testID={`staff-receiving-po-${po.id}`}
              onPress={() => onPickPo(po.id)}
              accessibilityLabel={po.vendorName || shortPoId(po.id)}
              leading={
                <View>
                  <View style={styles.poTitleRow}>
                    <Text style={[styles.poVendor, { color: c.text }]} numberOfLines={2}>
                      {po.vendorName || t('receiving.list.unnamedVendor')}
                    </Text>
                    <StatusPill status={po.status} />
                  </View>
                  <Text style={[styles.poMeta, { color: c.textSecondary }]}>
                    {t('receiving.list.poMeta', {
                      id: shortPoId(po.id),
                      date: po.referenceDate || (po.createdAt ? po.createdAt.slice(0, 10) : '—'),
                    })}
                  </Text>
                </View>
              }
              trailing={<Text style={[styles.chevron, { color: c.textTertiary }]}>›</Text>}
            />
          ))}
        </ScrollView>
      ) : null}

      {/* Detail view — the picked PO's lines with prefilled "received now" inputs */}
      {!loading && !error && selectedPo ? (
        <>
          <ScrollView contentContainerStyle={styles.scrollBody} testID="staff-receiving-detail">
            {/* PO summary header (short id + status + vendor + date) */}
            <View style={[styles.detailHeader, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.poTitleRow}>
                <Text style={[styles.poVendor, { color: c.text }]} numberOfLines={2}>
                  {selectedPo.vendorName || t('receiving.list.unnamedVendor')}
                </Text>
                <StatusPill status={selectedPo.status} />
              </View>
              <Text style={[styles.poMeta, { color: c.textSecondary }]}>
                {t('receiving.list.poMeta', {
                  id: shortPoId(selectedPo.id),
                  date:
                    selectedPo.referenceDate ||
                    (selectedPo.createdAt ? selectedPo.createdAt.slice(0, 10) : '—'),
                })}
              </Text>
            </View>

            {linesLoading ? (
              <View style={styles.centerPane} testID="staff-receiving-lines-loading">
                <ActivityIndicator color={c.primary} />
              </View>
            ) : lines.length === 0 ? (
              <StateCard
                testID="staff-receiving-no-lines"
                title={t('receiving.noLineItems')}
                body={t('receiving.noLineItemsBody')}
              />
            ) : (
              lines.map((ln) => {
                const outstanding = outstandingRemainder(ln);
                const displayName = getLocalizedName(
                  { name: ln.itemName, i18nNames: ln.i18nNames },
                  locale,
                );
                const unit = ln.unit ? ` ${ln.unit}` : '';
                return (
                  <ListRow
                    key={ln.poItemId}
                    testID={`staff-receiving-line-${ln.poItemId}`}
                    leading={
                      <View>
                        <Text style={[styles.lineName, { color: c.text }]} numberOfLines={2}>
                          {displayName}
                        </Text>
                        <Text style={[styles.lineMeta, { color: c.textSecondary }]}>
                          {t('receiving.line.orderedReceived', {
                            ordered: `${ln.orderedQty}${unit}`,
                            received: `${ln.receivedQty}${unit}`,
                          })}
                        </Text>
                        <Text style={[styles.lineOutstanding, { color: c.primary }]}>
                          {t('receiving.line.outstanding', { qty: `${outstanding}${unit}` })}
                        </Text>
                      </View>
                    }
                    trailing={
                      <View style={styles.receiveCol}>
                        <Text style={[styles.receiveColLabel, { color: c.textSecondary }]}>
                          {t('receiving.col.receiveNow')}
                        </Text>
                        <Input
                          value={inputs[ln.poItemId] ?? ''}
                          onChangeText={(txt) =>
                            setInputs((prev) => ({ ...prev, [ln.poItemId]: txt }))
                          }
                          keyboardType="decimal-pad"
                          {...(Platform.OS === 'web' ? { inputMode: 'decimal' as const } : {})}
                          placeholder="0"
                          testID={`staff-receiving-input-${ln.poItemId}`}
                          style={styles.receiveInput}
                          accessibilityLabel={t('receiving.col.receiveNowAria', { item: displayName })}
                        />
                      </View>
                    }
                  />
                );
              })
            )}
          </ScrollView>

          {/* Footer — commit (primary). Disabled offline (R-2), while loading the
              lines, when there are no lines, or while a receive is in flight. */}
          <View style={[styles.footer, { backgroundColor: c.surface, borderTopColor: c.border }]}>
            <Button
              label={submitting ? t('receiving.commit.committing') : t('receiving.commit.label')}
              onPress={onCommit}
              disabled={!isOnline || linesLoading || lines.length === 0 || submitting}
              loading={submitting}
              testID="staff-receiving-commit"
            />
          </View>
        </>
      ) : null}
    </SafeAreaView>
  );
}

const makeStyles = (T: StaffTokens) => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
  },
  centerPane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.xxl,
  },
  loadingText: {
    fontSize: T.typography.body,
  },
  header: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderBottomWidth: 1,
    gap: T.spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.md,
  },
  storePressable: {
    flex: 1,
    minWidth: 0,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.sm,
  },
  storeName: {
    fontSize: T.typography.title,
    fontWeight: T.typography.bold,
  },
  headerSub: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  controlBtn: {
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderRadius: T.radius.md,
  },
  controlText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.medium,
  },
  scrollBody: {
    padding: T.spacing.lg,
    paddingBottom: T.spacing.xxxl,
    gap: T.spacing.md,
  },
  // PO list / detail header
  poTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  poVendor: {
    flex: 1,
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.bold,
  },
  poMeta: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  chevron: {
    fontSize: T.typography.headline,
    fontWeight: T.typography.regular,
  },
  pill: {
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 3,
    borderRadius: T.radius.sm,
  },
  pillText: {
    fontSize: T.typography.caption,
    fontWeight: T.typography.bold,
    letterSpacing: 0.3,
  },
  detailHeader: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    gap: T.spacing.xs,
  },
  // PO line rows
  lineName: {
    fontSize: T.typography.bodyLarge,
    fontWeight: T.typography.semibold,
  },
  lineMeta: {
    fontSize: T.typography.caption,
    marginTop: 2,
  },
  lineOutstanding: {
    fontSize: T.typography.caption,
    marginTop: 2,
    fontWeight: T.typography.semibold,
  },
  receiveCol: {
    width: 96,
  },
  receiveColLabel: {
    fontSize: T.typography.caption,
    marginBottom: T.spacing.xs,
    textAlign: 'center',
    fontWeight: T.typography.medium,
  },
  receiveInput: {
    width: 96,
    textAlign: 'center',
  },
  // State cards
  stateCard: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    paddingVertical: T.spacing.xl,
    paddingHorizontal: T.spacing.lg,
    alignItems: 'center',
    gap: T.spacing.sm,
  },
  stateTitle: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  stateBody: {
    fontSize: T.typography.caption,
    textAlign: 'center',
    lineHeight: T.typography.lineHeightBody,
  },
  // Error pane
  errorPane: {
    borderWidth: 1,
    borderRadius: T.radius.lg,
    marginHorizontal: T.spacing.lg,
    marginBottom: T.spacing.sm,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.lg,
    gap: T.spacing.xs,
  },
  errorText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
  },
  errorDetail: {
    fontSize: T.typography.caption,
  },
  retryBtn: {
    marginTop: T.spacing.sm,
    alignSelf: 'flex-start',
    minHeight: T.touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: T.spacing.lg,
    borderWidth: 1,
    borderRadius: T.radius.md,
  },
  retryText: {
    fontSize: T.typography.body,
    fontWeight: T.typography.bold,
  },
  footer: {
    paddingHorizontal: T.spacing.lg,
    paddingTop: T.spacing.md,
    paddingBottom: T.spacing.md,
    borderTopWidth: 1,
  },
});
