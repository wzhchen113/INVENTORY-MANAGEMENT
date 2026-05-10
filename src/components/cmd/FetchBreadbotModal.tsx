import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import DatePicker from '../DatePicker';
import {
  BACKFILL_MAX_DAYS,
  BACKFILL_THROTTLE_MS,
  BackfillResult,
  enumerateDates,
  todayISO,
} from '../../lib/posBreadbot';
import {
  fetchBreadbotSales,
  hasPOSImportForDate,
  savePOSImport,
} from '../../lib/db';
import { matchRecipe } from '../../utils/recipeMatch';

// ParsedRow shape mirrors the section-local preview state. Single-fetch
// hands these rows back to the section, which renders the in-section
// preview (recipe pills + confirm) — matching the legacy preview flow at
// POSImportScreen.tsx:652-770.
export type ParsedRow = {
  menuItem: string;
  qtySold: number;
  revenue: number;
  /** Breadbot's canonicalized name. Display-only — does NOT participate in
   *  matchRecipe (matchRecipe is fed `menuItem`, the raw POS string). */
  canonical?: string;
};

interface FetchBreadbotModalProps {
  visible: boolean;
  onClose: () => void;
  storeId: string;
  storeName: string;
  /** Single-fetch returned ≥1 row. Section consumes the rows, switches
   *  to its local preview surface, and runs the in-section confirm flow
   *  (which calls importPOS + savePOSImport itself). */
  onSingleFetched: (filename: string, rows: ParsedRow[], importDate: string) => void;
  /** Range-backfill complete. Section stores results and renders the
   *  inline summary Card above the imports table. */
  onBackfillComplete: (results: BackfillResult[]) => void;
}

// Cmd-styled fetch modal. Mirrors UploadCsvModal's centered-overlay
// layout (header / body / footer) and Escape-to-close on web. Two tabs:
// SINGLE (one-day fetch) and RANGE (multi-day backfill).
export const FetchBreadbotModal: React.FC<FetchBreadbotModalProps> = ({
  visible,
  onClose,
  storeId,
  storeName,
  onSingleFetched,
  onBackfillComplete,
}) => {
  const C = useCmdColors();
  const recipes = useStore((s) => s.recipes);
  const importPOS = useStore((s) => s.importPOS);
  const posRecipeAliases = useStore((s) => s.posRecipeAliases);
  const currentUser = useStore((s) => s.currentUser);

  const [mode, setMode] = React.useState<'single' | 'range'>('single');
  const [singleDate, setSingleDate] = React.useState<string>(todayISO());
  // Defaults: last 7 days ending yesterday — today is usually incomplete
  // until Breadbot's 4 AM rollover (legacy comment at POSImportScreen.tsx:145).
  const [rangeStart, setRangeStart] = React.useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [rangeEnd, setRangeEnd] = React.useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  });

  const [fetching, setFetching] = React.useState(false);
  const [backfillRunning, setBackfillRunning] = React.useState(false);
  const [backfillProgress, setBackfillProgress] = React.useState<{
    current: number;
    total: number;
    status: string;
  }>({ current: 0, total: 0, status: '' });

  // Reset transient state when the modal closes.
  React.useEffect(() => {
    if (!visible) {
      setMode('single');
      setSingleDate(todayISO());
      const d1 = new Date();
      d1.setDate(d1.getDate() - 7);
      setRangeStart(d1.toISOString().split('T')[0]);
      const d2 = new Date();
      d2.setDate(d2.getDate() - 1);
      setRangeEnd(d2.toISOString().split('T')[0]);
      setFetching(false);
      // backfillRunning/backfillProgress stay as-is — the close happens
      // once the loop calls onBackfillComplete, which itself triggers
      // the modal's onClose. The next visible=true effect resets them.
      setBackfillRunning(false);
      setBackfillProgress({ current: 0, total: 0, status: '' });
    }
  }, [visible]);

  // Escape-to-close (web). Disabled while a fetch / backfill is in
  // flight so the user can't escape mid-loop and orphan a partial
  // backfill state.
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !fetching && !backfillRunning) {
        onClose();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, fetching, backfillRunning, onClose]);

  const rangeDayCount = React.useMemo(
    () => enumerateDates(rangeStart, rangeEnd).length,
    [rangeStart, rangeEnd],
  );
  const rangeInverted = rangeStart > rangeEnd;
  const rangeTooLarge = rangeDayCount > BACKFILL_MAX_DAYS;

  // ── Single-day fetch ──────────────────────────────────────────────
  // Hands the parsed rows back to the section, which switches to its
  // local preview state. Spec design "Single-fetch flow — contract
  // correction": Breadbot rows do NOT flow through computeDiff /
  // RunImportModal; they go through the legacy-parity in-section
  // preview → importPOS path.
  const handleSingleFetch = async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const { rows: fetched } = await fetchBreadbotSales(storeName, singleDate);
      if (fetched.length === 0) {
        Toast.show({
          type: 'info',
          text1: 'No sales returned',
          text2: `Breadbot had nothing for ${storeName} on ${singleDate}.`,
          position: 'bottom',
        });
        setFetching(false);
        return;
      }
      const parsed: ParsedRow[] = fetched.map((r) => ({
        menuItem: r.rawItemName,
        qtySold: r.qtySold,
        revenue: r.revenue ?? 0,
        canonical: r.canonical || undefined,
      }));
      const filename = `Breadbot · ${storeName} · ${singleDate}`;
      onSingleFetched(filename, parsed, singleDate);
      // Section closes the modal once it commits to preview state.
      // Section calls `onClose()` which resets the modal's transient
      // state; we keep `setFetching(false)` here as a safety net.
      setFetching(false);
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: 'Breadbot fetch failed',
        text2: e?.message || 'Check API key and network',
        position: 'bottom',
      });
      setFetching(false);
    }
  };

  // ── Range backfill ────────────────────────────────────────────────
  // Per-day flow exactly mirrors legacy POSImportScreen.tsx:380-463:
  //  1. hasPOSImportForDate → skip if already imported
  //  2. fetchBreadbotSales → skip if zero rows
  //  3. matchRecipe(rawItemName, ...) — match and write the raw POS string
  //  4. savePOSImport(..., date)  — explicit date so dedup persists
  //  5. importPOS({...})          — in-memory state + inventory deduct
  //  6. throttle BACKFILL_THROTTLE_MS between days
  //  7. on thrown error: push 'failed' and continue (don't abort loop)
  const handleRangeBackfill = async () => {
    if (backfillRunning) return;
    if (rangeInverted) {
      Toast.show({
        type: 'error',
        text1: 'Invalid range',
        text2: 'Start date must be on or before end date.',
        position: 'bottom',
      });
      return;
    }
    const days = enumerateDates(rangeStart, rangeEnd);
    if (days.length === 0) return;
    if (days.length > BACKFILL_MAX_DAYS) {
      Toast.show({
        type: 'error',
        text1: `Range too large (${days.length} days)`,
        text2: `Max ${BACKFILL_MAX_DAYS} days per backfill.`,
        position: 'bottom',
      });
      return;
    }

    setBackfillRunning(true);
    setBackfillProgress({ current: 0, total: days.length, status: 'Starting…' });

    const results: BackfillResult[] = [];
    for (let i = 0; i < days.length; i++) {
      const date = days[i];
      setBackfillProgress({ current: i + 1, total: days.length, status: `Checking ${date}…` });
      try {
        const already = await hasPOSImportForDate(storeId, date);
        if (already) {
          results.push({ date, outcome: 'skipped', reason: 'already imported' });
          continue;
        }

        setBackfillProgress({ current: i + 1, total: days.length, status: `Fetching ${date}…` });
        const { rows: fetched } = await fetchBreadbotSales(storeName, date);
        if (fetched.length === 0) {
          results.push({ date, outcome: 'skipped', reason: 'no data' });
          continue;
        }

        setBackfillProgress({
          current: i + 1,
          total: days.length,
          status: `Importing ${date} (${fetched.length} items)…`,
        });
        const dayFilename = `Breadbot · ${storeName} · ${date}`;
        // Match-against-raw, write-raw — pos_recipe_aliases is keyed on
        // the raw POS string (legacy parity at POSImportScreen.tsx:426-435).
        const items = fetched.map((row) => {
          const m = matchRecipe(row.rawItemName, recipes, posRecipeAliases);
          return {
            menuItem: row.rawItemName,
            qtySold: row.qtySold,
            revenue: row.revenue,
            recipeId: m.recipeId ?? undefined,
            recipeMapped: !!m.recipeId,
          };
        });
        // 1. Persist to pos_imports with explicit business date so future
        //    hasPOSImportForDate() calls dedup correctly across reloads.
        await savePOSImport(storeId, dayFilename, currentUser?.id || '', items, date);
        // 2. In-memory state + fire-and-forget inventory deduction.
        importPOS({
          filename: dayFilename,
          importedAt: new Date().toISOString(),
          importedBy: currentUser?.name || '',
          date,
          storeId,
          items,
        });
        results.push({ date, outcome: 'imported', itemCount: items.length });
      } catch (e: any) {
        results.push({ date, outcome: 'failed', reason: e?.message || 'Unknown error' });
      }
      if (i < days.length - 1) {
        await new Promise((r) => setTimeout(r, BACKFILL_THROTTLE_MS));
      }
    }

    setBackfillRunning(false);
    onBackfillComplete(results);
  };

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={fetching || backfillRunning ? () => {} : onClose}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={fetching || backfillRunning ? () => {} : onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.40)',
          alignItems: 'center',
          paddingTop: '7%',
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={{
            width: 560,
            maxWidth: '92%',
            backgroundColor: C.bg,
            borderWidth: 1,
            borderColor: C.borderStrong,
            borderRadius: 8,
            overflow: 'hidden',
            ...(Platform.OS === 'web'
              ? ({ boxShadow: '0 16px 48px rgba(0,0,0,0.30)' } as any)
              : {}),
          }}
        >
          {/* Header */}
          <View
            style={{
              height: 44,
              paddingHorizontal: 18,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: C.panel,
            }}
          >
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.fg }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.bg }}>FETCH</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>
              breadbot · {storeName.toLowerCase()}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {fetching || backfillRunning ? 'busy' : 'esc to close'}
            </Text>
          </View>

          {/* Tab strip */}
          <View
            style={{
              flexDirection: 'row',
              borderBottomWidth: 1,
              borderBottomColor: C.border,
              backgroundColor: C.panel,
            }}
          >
            {(['single', 'range'] as const).map((m) => {
              const active = mode === m;
              return (
                <TouchableOpacity
                  key={m}
                  testID={`breadbot-cmd-tab-${m}`}
                  disabled={fetching || backfillRunning}
                  onPress={() => setMode(m)}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    alignItems: 'center',
                    borderBottomWidth: 2,
                    borderBottomColor: active ? C.accent : 'transparent',
                    opacity: fetching || backfillRunning ? 0.5 : 1,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono(active ? 700 : 500),
                      fontSize: 11.5,
                      color: active ? C.fg : C.fg3,
                      letterSpacing: 0.4,
                      textTransform: 'uppercase',
                    }}
                  >
                    {m === 'single' ? 'single day' : 'date range'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Body */}
          {!backfillRunning ? (
            <ScrollView
              style={{ maxHeight: 360 }}
              contentContainerStyle={{ padding: 22, gap: 14 }}
            >
              {mode === 'single' ? (
                <>
                  <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2, lineHeight: 18 }}>
                    Pull POS, delivery and kiosk channels for one day, summed per item.
                    Today is usually incomplete until Breadbot's 4 AM rollover.
                  </Text>
                  <View>
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 9.5,
                        color: C.fg3,
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      sales date
                    </Text>
                    <DatePicker
                      value={singleDate}
                      onChange={(d) => setSingleDate(d || todayISO())}
                      placeholder="Select date"
                      testIdPrefix="breadbot-cmd-single-date"
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2, lineHeight: 18 }}>
                    Backfill several days at once. Each day is fetched, imported, and
                    deduped independently — already-imported days are skipped.
                  </Text>
                  <View>
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 9.5,
                        color: C.fg3,
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      start date
                    </Text>
                    <DatePicker
                      value={rangeStart}
                      onChange={(d) => d && setRangeStart(d)}
                      placeholder="Select date"
                      testIdPrefix="breadbot-cmd-range-start"
                    />
                  </View>
                  <View>
                    <Text
                      style={{
                        fontFamily: mono(700),
                        fontSize: 9.5,
                        color: C.fg3,
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        marginBottom: 6,
                      }}
                    >
                      end date
                    </Text>
                    <DatePicker
                      value={rangeEnd}
                      onChange={(d) => d && setRangeEnd(d)}
                      placeholder="Select date"
                      testIdPrefix="breadbot-cmd-range-end"
                    />
                  </View>
                  <Text
                    style={{
                      fontFamily: mono(400),
                      fontSize: 11,
                      color: rangeInverted || rangeTooLarge ? C.warn : C.fg3,
                    }}
                  >
                    {rangeInverted
                      ? '● invalid range — start must be on or before end'
                      : rangeTooLarge
                        ? `● range too large (${rangeDayCount} days) · max ${BACKFILL_MAX_DAYS} days`
                        : `${rangeDayCount} day${rangeDayCount === 1 ? '' : 's'} · each imported independently, already-imported days skipped`}
                  </Text>
                </>
              )}
            </ScrollView>
          ) : (
            // ── Backfill in-progress overlay (Cmd palette) ────────────
            <View style={{ padding: 30, alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 4,
                  backgroundColor: C.accentBg,
                }}
              >
                <Text
                  style={{
                    fontFamily: mono(700),
                    fontSize: 10,
                    color: C.accent,
                    letterSpacing: 0.5,
                  }}
                >
                  BACKFILLING…
                </Text>
              </View>
              <Text style={{ fontFamily: sans(600), fontSize: 14, color: C.fg }}>
                day {backfillProgress.current} of {backfillProgress.total}
              </Text>
              <Text
                style={{
                  fontFamily: mono(400),
                  fontSize: 11.5,
                  color: C.fg3,
                  textAlign: 'center',
                }}
              >
                {backfillProgress.status}
              </Text>
              {/* Skinny progress bar */}
              <View
                style={{
                  width: '80%',
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: C.panel2,
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    height: '100%',
                    width: `${backfillProgress.total > 0 ? Math.round((backfillProgress.current / backfillProgress.total) * 100) : 0}%`,
                    backgroundColor: C.accent,
                  }}
                />
              </View>
            </View>
          )}

          {/* Footer */}
          {!backfillRunning && (
            <View
              style={{
                height: 54,
                paddingHorizontal: 18,
                borderTopWidth: 1,
                borderTopColor: C.border,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: C.panel,
              }}
            >
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                testID="breadbot-cmd-cancel"
                disabled={fetching}
                onPress={onClose}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: CmdRadius.sm,
                  borderWidth: 1,
                  borderColor: C.border,
                  opacity: fetching ? 0.5 : 1,
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
              </TouchableOpacity>
              {mode === 'single' ? (
                <TouchableOpacity
                  testID="breadbot-cmd-submit-single"
                  disabled={fetching}
                  onPress={handleSingleFetch}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    borderRadius: CmdRadius.sm,
                    backgroundColor: C.accent,
                    opacity: fetching ? 0.6 : 1,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accentFg }}>
                    {fetching ? 'FETCHING…' : 'FETCH  →'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  testID="breadbot-cmd-submit-range"
                  disabled={rangeInverted || rangeTooLarge || rangeDayCount === 0}
                  onPress={handleRangeBackfill}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 12,
                    borderRadius: CmdRadius.sm,
                    backgroundColor: rangeInverted || rangeTooLarge || rangeDayCount === 0 ? C.panel2 : C.accent,
                    opacity: rangeInverted || rangeTooLarge || rangeDayCount === 0 ? 0.6 : 1,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 11,
                      color: rangeInverted || rangeTooLarge || rangeDayCount === 0 ? C.fg3 : C.accentFg,
                    }}
                  >
                    BACKFILL {rangeDayCount} DAY{rangeDayCount === 1 ? '' : 'S'}  →
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
