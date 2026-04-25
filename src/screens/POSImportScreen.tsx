// src/screens/POSImportScreen.tsx
import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, TextInput,
  Modal, ActivityIndicator, ScrollView,
} from 'react-native';
import Toast from 'react-native-toast-message';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import DatePicker from '../components/DatePicker';
import { TimezoneBar } from '../components/TimezoneBar';
import { fetchBreadbotSales, hasPOSImportForDate, savePOSImport, fetchUnmappedPosImports } from '../lib/db';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';
import { matchRecipe, MatchResult } from '../utils/recipeMatch';

const isWeb = Platform.OS === 'web';

// Stores whose sales live in the breadbot public API. Must match STORE_MAP
// in supabase/functions/fetch-breadbot-sales/index.ts — the client-side set
// is just the UI guard; the edge function is the source of truth.
const BREADBOT_STORES = new Set(['Frederick', 'Charles', 'Towson']);

interface ParsedRow {
  menuItem: string;
  qtySold: number;
  revenue: number;
}

// Per-day outcome from a breadbot range backfill. Rendered in the summary card.
type BackfillResult = {
  date: string;
  outcome: 'imported' | 'skipped' | 'failed';
  reason?: string;
  itemCount?: number;
};

const BACKFILL_MAX_DAYS = 30;
const BACKFILL_THROTTLE_MS = 200; // ~5 req/s — well under breadbot's 60/min cap

// Enumerate YYYY-MM-DD strings inclusive of both ends, using UTC math so
// DST transitions don't drop or duplicate a day at the boundary.
function enumerateDates(start: string, end: string): string[] {
  if (start > end) return [];
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    const [y, m, d] = cur.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    cur = next.toISOString().split('T')[0];
  }
  return out;
}

// ── Proper CSV parser — handles quoted fields containing commas ──
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDisplayDate(iso: string) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function POSImportScreen() {
  const {
    recipes, importPOS, currentUser, currentStore,
    posRecipeAliases, upsertPosRecipeAliases, applyAliasToPastImports,
  } = useStore();
  const C = useColors();
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [importDate, setImportDate] = useState(todayISO);
  const [fileType, setFileType] = useState<'items' | 'modifiers'>('items');

  // Per-row match state — initialized from the matchRecipe waterfall when rows
  // load, then user can override via the recipe picker. The user's choice (or
  // accepted fuzzy guess) is what gets imported AND saved as a persistent alias.
  type RowMatch = { recipeId: string | null; matchType: MatchResult['matchType'] };
  const [rowMatches, setRowMatches] = useState<RowMatch[]>([]);
  // pickerForIdx is the row index the picker is editing; -1 means we're
  // mapping an "unmapped past" entry (pickerUnmappedName carries the POS string).
  const [pickerForIdx, setPickerForIdx] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerUnmappedName, setPickerUnmappedName] = useState('');

  // Past unmapped POS items (last 30 days, this store) — surfaced in a review
  // section above the upload UI so admins can map names that the cron missed.
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'master';
  const [unmapped, setUnmapped] = useState<{ menu_item: string; count: number }[]>([]);
  const [unmappedRefresh, setUnmappedRefresh] = useState(0);
  useEffect(() => {
    if (!currentStore?.id || !isAdmin) { setUnmapped([]); return; }
    let cancelled = false;
    fetchUnmappedPosImports(currentStore.id).then((rows) => {
      if (!cancelled) setUnmapped(rows);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentStore?.id, isAdmin, unmappedRefresh]);

  // Breadbot fetch modal state
  const [showBreadbotModal, setShowBreadbotModal] = useState(false);
  const [breadbotMode, setBreadbotMode] = useState<'single' | 'range'>('single');
  const [breadbotDate, setBreadbotDate] = useState(todayISO);
  const [fetchingBreadbot, setFetchingBreadbot] = useState(false);
  const storeHasBreadbot = !!currentStore && BREADBOT_STORES.has(currentStore.name);

  // Backfill (date-range) state. Defaults: last 7 days ending yesterday —
  // today is usually incomplete until breadbot's 4am rollover.
  const [backfillStart, setBackfillStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [backfillEnd, setBackfillEnd] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  });
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ current: number; total: number; status: string }>({
    current: 0, total: 0, status: '',
  });
  const [backfillResults, setBackfillResults] = useState<BackfillResult[] | null>(null);

  const backfillDayCount = useMemo(
    () => enumerateDates(backfillStart, backfillEnd).length,
    [backfillStart, backfillEnd],
  );

  const pickFile = async () => {
    if (isWeb) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setFilename(file.name);
        const text = await file.text();
        parseCSV(text);
      };
      input.click();
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'text/comma-separated-values' });
      if (result.canceled) return;
      const asset = result.assets[0];
      setFilename(asset.name);
      const text = await FileSystem.readAsStringAsync(asset.uri);
      parseCSV(text);
    } catch {
      Alert.alert('Error', 'Could not read file. Make sure it is a .csv file.');
    }
  };

  // Fetch sales directly from breadbot via the edge function proxy. The
  // returned rows match the ParsedRow shape the CSV parser emits, so we can
  // drop them straight into the existing preview → confirm → importPOS flow.
  const handleFetchBreadbot = async () => {
    if (!currentStore || !storeHasBreadbot) return;
    setFetchingBreadbot(true);
    try {
      const { rows: fetched } = await fetchBreadbotSales(currentStore.name, breadbotDate);
      if (fetched.length === 0) {
        Toast.show({
          type: 'info',
          text1: 'No sales returned',
          text2: `Breadbot had nothing for ${currentStore.name} on ${breadbotDate}.`,
          position: 'bottom',
        });
        setFetchingBreadbot(false);
        return;
      }
      setFilename(`Breadbot · ${currentStore.name} · ${breadbotDate}`);
      setFileType('items');
      setRows(fetched);
      setImportDate(breadbotDate);
      setShowBreadbotModal(false);
      setStep('preview');
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: 'Breadbot fetch failed',
        text2: e?.message || 'Check API key and network',
        position: 'bottom',
      });
    } finally {
      setFetchingBreadbot(false);
    }
  };

  const parseCSV = (text: string) => {
    const rawLines = text.trim().split(/\r?\n/);
    const lines = rawLines.map(parseCSVLine);
    if (lines.length < 2) {
      Alert.alert('Error', 'CSV needs at least a header + one data row');
      return;
    }
    const hdrs = lines[0];

    // Detect file type by headers
    const isModifierReport = hdrs.some((h) => /^modifier$/i.test(h));
    setFileType(isModifierReport ? 'modifiers' : 'items');

    if (isModifierReport) {
      // Modifier report: Location, Modifier, Item, Source, Count, Date per order
      const modCol = hdrs.findIndex((h) => /^modifier$/i.test(h));
      const countCol = hdrs.findIndex((h) => /^count$/i.test(h));
      const dateCol = hdrs.findIndex((h) => /date/i.test(h));

      const parsed: ParsedRow[] = lines
        .slice(1)
        .filter((row) => row.length > Math.max(modCol, countCol))
        .map((row) => ({
          menuItem: row[modCol] || '',
          qtySold: parseInt(row[countCol], 10) || 0,
          revenue: 0,
        }))
        .filter((row) => row.qtySold > 0);

      // Extract first date from dates column
      if (dateCol >= 0 && lines[1]?.[dateCol]) {
        const firstDate = lines[1][dateCol].split(',')[0]?.trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(firstDate)) setImportDate(firstDate);
      }

      setRows(parsed);
    } else {
      // Item report: Source, Item, Item price per order, Sold, Count, Location
      let itemCol = hdrs.findIndex((h) => /^item$/i.test(h));
      if (itemCol < 0) itemCol = hdrs.findIndex((h) => /item|name|product|menu|desc/i.test(h));

      // Prefer "Count" for quantity — "Sold" column has revenue ($xxx.xx)
      let qtyCol = hdrs.findIndex((h) => /^count$/i.test(h));
      if (qtyCol < 0) qtyCol = hdrs.findIndex((h) => /qty|quantity|amount/i.test(h));

      // Revenue: "Sold" column (has $xxx.xx values)
      let revCol = hdrs.findIndex((h) => /^sold$/i.test(h));
      if (revCol < 0) revCol = hdrs.findIndex((h) => /revenue|total|sales/i.test(h));

      const ic = itemCol >= 0 ? itemCol : 0;
      const qc = qtyCol >= 0 ? qtyCol : 1;
      const rc = revCol >= 0 ? revCol : 2;

      const parsed: ParsedRow[] = lines
        .slice(1)
        .filter((row) => row.length > ic && row[ic])
        .map((row) => ({
          menuItem: row[ic] || '',
          qtySold: parseInt(row[qc], 10) || 0,
          revenue: parseFloat((row[rc] || '0').replace(/[$,]/g, '')) || 0,
        }))
        .filter((row) => row.qtySold > 0);

      setRows(parsed);
    }
    setStep('preview');
  };

  // Re-run the waterfall whenever rows / recipes / aliases change. The user
  // can still override per-row via the picker; their override survives a
  // re-run because we only reset rowMatches when `rows` itself changes
  // (uploaded a new file / fetched new breadbot data).
  useEffect(() => {
    setRowMatches(rows.map((r) => {
      const m = matchRecipe(r.menuItem, recipes, posRecipeAliases);
      return { recipeId: m.recipeId, matchType: m.matchType };
    }));
  }, [rows, recipes, posRecipeAliases]);

  const matchedCount = useMemo(
    () => rowMatches.filter((m) => m.recipeId).length,
    [rowMatches],
  );
  const totalQty = rows.reduce((s, r) => s + r.qtySold, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);

  const setRowMatch = (idx: number, recipeId: string | null) => {
    setRowMatches((prev) => prev.map((m, i) =>
      i === idx ? { recipeId, matchType: recipeId ? 'alias' : 'none' } : m
    ));
  };

  const handleImport = async () => {
    const items = rows.map((row, idx) => {
      const m = rowMatches[idx];
      return {
        menuItem: row.menuItem,
        qtySold: row.qtySold,
        revenue: row.revenue,
        recipeId: m?.recipeId ?? undefined,
        recipeMapped: !!m?.recipeId,
      };
    });
    importPOS({
      filename,
      importedAt: new Date().toISOString(),
      importedBy: currentUser?.name || '',
      date: importDate,
      storeId: currentStore.id,
      items,
    });
    // Persist every confirmed match as an alias so the same POS string never
    // re-fuzzy-matches on subsequent imports (cron or manual).
    const aliasesToSave = rows
      .map((row, idx) => ({ posName: row.menuItem, recipeId: rowMatches[idx]?.recipeId }))
      .filter((a): a is { posName: string; recipeId: string } => !!a.recipeId);
    if (aliasesToSave.length > 0) {
      upsertPosRecipeAliases(aliasesToSave).catch(() => { /* best-effort */ });
    }
    setStep('done');
  };

  // Past unmapped review — picking a recipe upserts the alias AND retroactively
  // flips matching pos_import_items in the last 30 days to recipe_mapped=true.
  // (Inventory deduction is NOT retroactively applied; user re-imports if needed.)
  const handleMapUnmapped = async (posName: string, recipeId: string) => {
    await upsertPosRecipeAliases([{ posName, recipeId }]);
    const updated = await applyAliasToPastImports(posName, recipeId);
    Toast.show({
      type: 'success',
      text1: 'Alias saved',
      text2: updated > 0 ? `Updated ${updated} past row${updated === 1 ? '' : 's'}.` : 'Future imports will use this mapping.',
      position: 'bottom',
    });
    setUnmappedRefresh((n) => n + 1);
  };

  // Backfill a date range from breadbot, one day at a time. Each day is its
  // own independent commit: we check dedup → fetch → savePOSImport (DB row
  // for future dedup) → importPOS (in-memory state + inventory deduction via
  // adjustStock). If day N fails, days 1..N-1 stay imported and the user
  // can re-run to pick up from N (the dedup guard skips what's already done).
  const runBackfill = async () => {
    if (!currentStore || !storeHasBreadbot) return;
    if (backfillStart > backfillEnd) {
      Toast.show({ type: 'error', text1: 'Invalid range', text2: 'Start date must be on or before end date.', position: 'bottom' });
      return;
    }
    const days = enumerateDates(backfillStart, backfillEnd);
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

    setShowBreadbotModal(false);
    setBackfillResults(null);
    setBackfillRunning(true);
    setBackfillProgress({ current: 0, total: days.length, status: 'Starting…' });

    const results: BackfillResult[] = [];
    for (let i = 0; i < days.length; i++) {
      const date = days[i];
      setBackfillProgress({ current: i + 1, total: days.length, status: `Checking ${date}…` });
      try {
        const already = await hasPOSImportForDate(currentStore.id, date);
        if (already) {
          results.push({ date, outcome: 'skipped', reason: 'already imported' });
          continue;
        }

        setBackfillProgress({ current: i + 1, total: days.length, status: `Fetching ${date}…` });
        const { rows: fetched } = await fetchBreadbotSales(currentStore.name, date);
        if (fetched.length === 0) {
          results.push({ date, outcome: 'skipped', reason: 'no data' });
          continue;
        }

        setBackfillProgress({ current: i + 1, total: days.length, status: `Importing ${date} (${fetched.length} items)…` });
        const dayFilename = `Breadbot · ${currentStore.name} · ${date}`;
        const items = fetched.map((row) => {
          const m = matchRecipe(row.menuItem, recipes, posRecipeAliases);
          return {
            menuItem: row.menuItem,
            qtySold: row.qtySold,
            revenue: row.revenue,
            recipeId: m.recipeId ?? undefined,
            recipeMapped: !!m.recipeId,
          };
        });
        // 1. Persist to pos_imports with explicit business date — this row
        //    is what future hasPOSImportForDate() calls will see.
        await savePOSImport(currentStore.id, dayFilename, currentUser?.id || '', items, date);
        // 2. Update in-memory state + fire-and-forget inventory deduction.
        //    (importPOS doesn't call savePOSImport itself; we did step 1
        //    explicitly so dedup works across sessions/reloads.)
        importPOS({
          filename: dayFilename,
          importedAt: new Date().toISOString(),
          importedBy: currentUser?.name || '',
          date,
          storeId: currentStore.id,
          items,
        });
        results.push({ date, outcome: 'imported', itemCount: items.length });
      } catch (e: any) {
        results.push({ date, outcome: 'failed', reason: e?.message || 'Unknown error' });
      }

      // Throttle between days so we don't burst the breadbot rate limit.
      if (i < days.length - 1) {
        await new Promise((r) => setTimeout(r, BACKFILL_THROTTLE_MS));
      }
    }

    setBackfillRunning(false);
    setBackfillResults(results);
  };

  if (step === 'done') {
    return (
      <View style={[styles.doneContainer, { backgroundColor: C.bgTertiary }]}>
        <TimezoneBar />
        <View style={[styles.doneCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
          <View style={[styles.doneIcon, { backgroundColor: C.successBg }]}>
            <Ionicons name="checkmark" size={28} color={C.success} />
          </View>
          <Text style={[styles.doneTitle, { color: C.textPrimary }]}>Import complete</Text>
          <Text style={[styles.doneSub, { color: C.textSecondary }]}>
            {rows.length} items processed for {formatDisplayDate(importDate)}.{'\n'}
            {matchedCount} recipe-matched items will deduct inventory.{'\n'}
            Reconciliation report updated.
          </Text>
          <TouchableOpacity
            style={[styles.doneBtn, { backgroundColor: C.bgSecondary, borderColor: C.borderLight }]}
            onPress={() => {
              setStep('upload');
              setRows([]);
              setFilename('');
              setImportDate(todayISO());
            }}
          >
            <Text style={[styles.doneBtnText, { color: C.textPrimary }]}>Import another file</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bgTertiary }}>
    <TimezoneBar />
    <WebScrollView id="pos-scroll" contentContainerStyle={[styles.content, { backgroundColor: C.bgTertiary }] as any}>
      {step === 'upload' && isAdmin && unmapped.length > 0 && (
        <Card>
          <CardHeader title={`Items needing mapping (${unmapped.length})`} />
          <Text style={[styles.breadbotLead, { color: C.textSecondary }]}>
            Past 30 days, this store. Mapping a name saves an alias so future imports auto-match — and flips matching past rows to mapped.
          </Text>
          {unmapped.map((u) => (
            <View key={u.menu_item} style={[styles.previewRow, { borderBottomColor: C.borderLight }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.previewName, { color: C.textPrimary }]}>{u.menu_item}</Text>
                <Text style={[styles.previewQty, { color: C.textSecondary }]}>
                  {u.count} unmapped row{u.count === 1 ? '' : 's'}
                </Text>
              </View>
              <TouchableOpacity
                testID={`posimport-unmapped-pick-${u.menu_item}`}
                onPress={() => {
                  setPickerForIdx(-1);
                  setPickerSearch('');
                  setPickerUnmappedName(u.menu_item);
                }}
                style={[styles.matchPill, { backgroundColor: C.dangerBg, borderColor: C.danger, borderWidth: 1 }]}
              >
                <Text style={[styles.matchPillText, { color: C.danger }]}>Map…</Text>
                <Ionicons name="chevron-down" size={12} color={C.danger} />
              </TouchableOpacity>
            </View>
          ))}
        </Card>
      )}

      {step === 'upload' && storeHasBreadbot && backfillResults && (
        <Card>
          <CardHeader
            title="Backfill complete"
            right={
              <TouchableOpacity onPress={() => setBackfillResults(null)}>
                <Ionicons name="close" size={18} color={C.textSecondary} />
              </TouchableOpacity>
            }
          />
          {(() => {
            const imported = backfillResults.filter((r) => r.outcome === 'imported');
            const skipped = backfillResults.filter((r) => r.outcome === 'skipped');
            const failed = backfillResults.filter((r) => r.outcome === 'failed');
            return (
              <>
                <View style={styles.statChips}>
                  <View style={[styles.statChip, { backgroundColor: C.successBg }]}>
                    <Text style={[styles.statVal, { color: C.success }]}>{imported.length}</Text>
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>Imported</Text>
                  </View>
                  <View style={[styles.statChip, { backgroundColor: C.bgSecondary }]}>
                    <Text style={[styles.statVal, { color: C.textPrimary }]}>{skipped.length}</Text>
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>Skipped</Text>
                  </View>
                  {failed.length > 0 && (
                    <View style={[styles.statChip, { backgroundColor: C.warningBg }]}>
                      <Text style={[styles.statVal, { color: C.warning }]}>{failed.length}</Text>
                      <Text style={[styles.statLabel, { color: C.textTertiary }]}>Failed</Text>
                    </View>
                  )}
                </View>
                <View style={{ marginTop: Spacing.sm }}>
                  {backfillResults.map((r) => (
                    <View key={r.date} style={[styles.previewRow, { borderBottomColor: C.borderLight }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.previewName, { color: C.textPrimary }]}>{r.date}</Text>
                        {r.reason && (
                          <Text style={[styles.previewQty, { color: C.textSecondary }]}>{r.reason}</Text>
                        )}
                        {r.outcome === 'imported' && r.itemCount !== undefined && (
                          <Text style={[styles.previewQty, { color: C.textSecondary }]}>
                            {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
                          </Text>
                        )}
                      </View>
                      <Badge
                        label={r.outcome}
                        variant={r.outcome === 'imported' ? 'ok' : r.outcome === 'failed' ? 'mismatch' : 'pending'}
                      />
                    </View>
                  ))}
                </View>
              </>
            );
          })()}
        </Card>
      )}

      {step === 'upload' && storeHasBreadbot && (
        <Card>
          <CardHeader title="Fetch from Breadbot" />
          <Text style={[styles.breadbotLead, { color: C.textSecondary }]}>
            Pull {currentStore.name}'s sales directly from the breadbot API instead of uploading a CSV. POS, delivery, and kiosk channels are summed per item.
          </Text>
          <TouchableOpacity
            testID="breadbot-open-single"
            style={[styles.breadbotBtn, { backgroundColor: C.textPrimary }]}
            onPress={() => {
              setBreadbotMode('single');
              setBreadbotDate(todayISO());
              setShowBreadbotModal(true);
            }}
          >
            <Ionicons name="cloud-download-outline" size={18} color={C.bgPrimary} />
            <Text style={[styles.breadbotBtnText, { color: C.bgPrimary }]}>Fetch sales from Breadbot</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="breadbot-open-range"
            style={[styles.backfillLink, { borderColor: C.borderMedium }]}
            onPress={() => {
              setBreadbotMode('range');
              setShowBreadbotModal(true);
            }}
          >
            <Ionicons name="calendar-outline" size={16} color={C.textSecondary} />
            <Text style={[styles.backfillLinkText, { color: C.textSecondary }]}>Backfill a date range</Text>
          </TouchableOpacity>
        </Card>
      )}

      {step === 'upload' && (
        <Card>
          <CardHeader title="Upload POS sales CSV" />
          <View style={[styles.adminNotice, { backgroundColor: C.warningBg }]}>
            <Text style={[styles.adminNoticeText, { color: C.warning }]}>
              Admin only · {currentStore.name} · Logged to audit trail
            </Text>
          </View>
          <TouchableOpacity style={[styles.uploadZone, { borderColor: C.borderMedium }]} onPress={pickFile}>
            <View style={[styles.uploadIcon, { backgroundColor: C.bgSecondary }]}>
              <Ionicons name="cloud-upload-outline" size={28} color={C.textSecondary} />
            </View>
            <Text style={[styles.uploadTitle, { color: C.textPrimary }]}>Tap to upload CSV file</Text>
            <Text style={[styles.uploadSub, { color: C.textSecondary }]}>
              Supports item reports and modifier reports
            </Text>
            <Text style={[styles.uploadSub, { color: C.textSecondary }]}>
              From DoorDash, UberEats, GrubHub, Toast, Square, etc.
            </Text>
          </TouchableOpacity>

          <View style={[styles.sampleBox, { backgroundColor: C.bgSecondary }]}>
            <Text style={[styles.sampleTitle, { color: C.textSecondary }]}>Supported formats</Text>
            <Text style={[styles.sampleSubtitle, { color: C.textTertiary }]}>Item report</Text>
            <Text style={[styles.sampleRow, { color: C.textTertiary }]}>Source, Item, Item price per order, Sold, Count</Text>
            <Text style={[styles.sampleSubtitle, { color: C.textTertiary }]}>Modifier report</Text>
            <Text style={[styles.sampleRow, { color: C.textTertiary }]}>Location, Modifier, Item, Source, Count, Date</Text>
          </View>
        </Card>
      )}

      {step === 'preview' && (
        <>
          <Card>
            <CardHeader
              title={`Preview — ${filename}`}
              right={
                <Badge
                  label={fileType === 'modifiers' ? 'Modifier report' : 'Item report'}
                  variant="ok"
                />
              }
            />

            {/* Date picker + Summary stats */}
            <View style={styles.statsBar}>
              <View style={styles.datePicker}>
                <DatePicker value={importDate} onChange={(d) => setImportDate(d || todayISO)} label="Import date" placeholder="Select date" testIdPrefix="posimport-import-date" />
              </View>
              <View style={styles.statChips}>
                <View style={[styles.statChip, { backgroundColor: C.bgSecondary }]}>
                  <Text style={[styles.statVal, { color: C.textPrimary }]}>{rows.length}</Text>
                  <Text style={[styles.statLabel, { color: C.textTertiary }]}>Items</Text>
                </View>
                <View style={[styles.statChip, { backgroundColor: C.bgSecondary }]}>
                  <Text style={[styles.statVal, { color: C.textPrimary }]}>{totalQty}</Text>
                  <Text style={[styles.statLabel, { color: C.textTertiary }]}>Total sold</Text>
                </View>
                {totalRevenue > 0 && (
                  <View style={[styles.statChip, { backgroundColor: C.bgSecondary }]}>
                    <Text style={[styles.statVal, { color: C.textPrimary }]}>${totalRevenue.toLocaleString()}</Text>
                    <Text style={[styles.statLabel, { color: C.textTertiary }]}>Revenue</Text>
                  </View>
                )}
                <View style={[styles.statChip, { backgroundColor: C.successBg }]}>
                  <Text style={[styles.statVal, { color: C.success }]}>{matchedCount}</Text>
                  <Text style={[styles.statLabel, { color: C.textTertiary }]}>Matched</Text>
                </View>
                <View style={[styles.statChip, rows.length - matchedCount > 0 ? { backgroundColor: C.warningBg } : {}]}>
                  <Text style={[styles.statVal, rows.length - matchedCount > 0 ? { color: C.warning } : {}]}>
                    {rows.length - matchedCount}
                  </Text>
                  <Text style={[styles.statLabel, { color: C.textTertiary }]}>Unmatched</Text>
                </View>
              </View>
            </View>

            <View style={[styles.infoBar, { backgroundColor: C.infoBg }]}>
              <Text style={[styles.infoText, { color: C.info }]}>
                {fileType === 'modifiers'
                  ? 'Modifiers matched to recipes will deduct ingredient quantities. Unmatched modifiers (customizations, removals) are skipped.'
                  : 'Items matched to recipes will deduct exact ingredient quantities. Unmatched items are recorded but won\'t affect inventory.'}
              </Text>
            </View>

            {/* Preview rows — tap the recipe pill to change the match. */}
            {rows.map((row, idx) => {
              const m = rowMatches[idx];
              const recipe = m?.recipeId ? recipes.find((r) => r.id === m.recipeId) : null;
              const isFuzzy = m?.matchType === 'fuzzy';
              const isNone = m?.matchType === 'none' || !recipe;
              const pillStyle = isNone
                ? { backgroundColor: C.dangerBg, borderColor: C.danger, borderWidth: 1 }
                : isFuzzy
                  ? { backgroundColor: C.warningBg, borderColor: C.warning, borderWidth: 1 }
                  : { backgroundColor: C.successBg, borderColor: C.success, borderWidth: 0.5 };
              const pillTextColor = isNone ? C.danger : isFuzzy ? C.warning : C.success;
              const label = recipe?.menuItem ?? 'No match — tap to pick';
              return (
                <View key={idx} style={[styles.previewRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.previewName, { color: C.textPrimary }]}>{row.menuItem}</Text>
                    <Text style={[styles.previewQty, { color: C.textSecondary }]}>
                      {row.qtySold} sold{row.revenue > 0 ? ` · $${row.revenue.toFixed(2)}` : ''}
                    </Text>
                  </View>
                  <TouchableOpacity
                    testID={`posimport-row-picker-${idx}`}
                    onPress={() => { setPickerForIdx(idx); setPickerSearch(''); }}
                    style={[styles.matchPill, pillStyle]}
                  >
                    <Text
                      style={[
                        styles.matchPillText,
                        { color: pillTextColor },
                        isFuzzy && { fontStyle: 'italic' },
                      ]}
                    >
                      {label}{isFuzzy ? ' (guess)' : ''}
                    </Text>
                    <Ionicons name="chevron-down" size={12} color={pillTextColor} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </Card>

          <View style={styles.actionRow}>
            <TouchableOpacity
              testID="posimport-preview-cancel"
              style={[styles.cancelBtn, { borderColor: C.borderMedium }]}
              onPress={() => {
                setStep('upload');
                setRows([]);
              }}
            >
              <Text style={[styles.cancelBtnText, { color: C.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="posimport-confirm" style={[styles.importBtn, { backgroundColor: C.textPrimary }]} onPress={handleImport}>
              <Text style={[styles.importBtnText, { color: C.bgPrimary }]}>
                Import {rows.length} items · {formatDisplayDate(importDate)}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </WebScrollView>

    <Modal visible={showBreadbotModal} animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight }]}>
          <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Fetch from Breadbot</Text>
          <Text style={[styles.modalSub, { color: C.textSecondary }]}>
            {currentStore?.name ?? ''} · channels summed per item
          </Text>

          {/* Mode tabs */}
          <View style={[styles.tabRow, { borderBottomColor: C.borderLight }]}>
            <TouchableOpacity
              testID="breadbot-modal-tab-single"
              style={[
                styles.tab,
                breadbotMode === 'single' && { borderBottomColor: C.textPrimary, borderBottomWidth: 2 },
              ]}
              onPress={() => setBreadbotMode('single')}
              disabled={fetchingBreadbot}
            >
              <Text style={[styles.tabText, { color: breadbotMode === 'single' ? C.textPrimary : C.textSecondary }]}>
                Single day
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="breadbot-modal-tab-range"
              style={[
                styles.tab,
                breadbotMode === 'range' && { borderBottomColor: C.textPrimary, borderBottomWidth: 2 },
              ]}
              onPress={() => setBreadbotMode('range')}
              disabled={fetchingBreadbot}
            >
              <Text style={[styles.tabText, { color: breadbotMode === 'range' ? C.textPrimary : C.textSecondary }]}>
                Date range
              </Text>
            </TouchableOpacity>
          </View>

          {breadbotMode === 'single' ? (
            <View style={{ marginTop: Spacing.md }}>
              <DatePicker
                value={breadbotDate}
                onChange={(d) => setBreadbotDate(d || todayISO())}
                label="Sales date"
                placeholder="Select date"
                testIdPrefix="breadbot-date"
              />
            </View>
          ) : (
            <View style={{ marginTop: Spacing.md, gap: Spacing.sm }}>
              <DatePicker
                value={backfillStart}
                onChange={(d) => d && setBackfillStart(d)}
                label="Start date"
                placeholder="Select date"
                testIdPrefix="breadbot-range-start"
              />
              <DatePicker
                value={backfillEnd}
                onChange={(d) => d && setBackfillEnd(d)}
                label="End date"
                placeholder="Select date"
                testIdPrefix="breadbot-range-end"
              />
              <Text style={[styles.modalSub, { color: C.textSecondary, marginTop: 4 }]}>
                {backfillDayCount > BACKFILL_MAX_DAYS
                  ? `Range too large · max ${BACKFILL_MAX_DAYS} days`
                  : `${backfillDayCount} day${backfillDayCount === 1 ? '' : 's'} · each imported independently, already-imported days skipped`}
              </Text>
            </View>
          )}

          <View style={styles.modalActions}>
            <TouchableOpacity
              testID="breadbot-modal-cancel"
              style={[styles.modalCancel, { borderColor: C.borderMedium }]}
              onPress={() => setShowBreadbotModal(false)}
              disabled={fetchingBreadbot}
            >
              <Text style={[styles.modalCancelText, { color: C.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            {breadbotMode === 'single' ? (
              <TouchableOpacity
                testID="breadbot-modal-submit"
                style={[styles.modalFetch, { backgroundColor: C.textPrimary, opacity: fetchingBreadbot ? 0.6 : 1 }]}
                onPress={handleFetchBreadbot}
                disabled={fetchingBreadbot}
              >
                {fetchingBreadbot ? (
                  <ActivityIndicator size="small" color={C.bgPrimary} />
                ) : (
                  <Text style={[styles.modalFetchText, { color: C.bgPrimary }]}>Fetch sales</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="breadbot-modal-submit"
                style={[
                  styles.modalFetch,
                  { backgroundColor: C.textPrimary, opacity: backfillDayCount === 0 || backfillDayCount > BACKFILL_MAX_DAYS ? 0.5 : 1 },
                ]}
                onPress={runBackfill}
                disabled={backfillDayCount === 0 || backfillDayCount > BACKFILL_MAX_DAYS}
              >
                <Text style={[styles.modalFetchText, { color: C.bgPrimary }]}>
                  Backfill {backfillDayCount} day{backfillDayCount === 1 ? '' : 's'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>

    {/* Recipe picker modal — used for both per-row override and past unmapped review. */}
    <Modal visible={pickerForIdx !== null} animationType="fade" transparent onRequestClose={() => setPickerForIdx(null)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, maxHeight: '80%', width: '90%' }]}>
          <Text style={[styles.modalTitle, { color: C.textPrimary }]}>Pick a recipe</Text>
          {pickerForIdx !== null && pickerForIdx >= 0 && rows[pickerForIdx] && (
            <Text style={[styles.modalSub, { color: C.textSecondary, marginBottom: Spacing.sm }]}>
              POS: <Text style={{ fontWeight: '600' }}>{rows[pickerForIdx].menuItem}</Text>
            </Text>
          )}
          {pickerForIdx === -1 && (
            <Text style={[styles.modalSub, { color: C.textSecondary, marginBottom: Spacing.sm }]}>
              POS: <Text style={{ fontWeight: '600' }}>{pickerUnmappedName}</Text>
            </Text>
          )}
          <TextInput
            testID="posimport-picker-search"
            value={pickerSearch}
            onChangeText={setPickerSearch}
            placeholder="Search recipes…"
            placeholderTextColor={C.textTertiary}
            style={{
              borderWidth: 0.5, borderColor: C.borderMedium, borderRadius: Radius.md,
              padding: Spacing.sm, marginBottom: Spacing.sm,
              color: C.textPrimary, backgroundColor: C.bgSecondary,
            }}
          />
          <ScrollView style={{ maxHeight: 320 }}>
            {/* "No match" option — clears the row's recipe (preview mode only). */}
            {pickerForIdx !== null && pickerForIdx >= 0 && (
              <TouchableOpacity
                testID="posimport-picker-none"
                onPress={() => {
                  setRowMatch(pickerForIdx, null);
                  setPickerForIdx(null);
                }}
                style={{ paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: C.borderLight }}
              >
                <Text style={{ color: C.danger, fontWeight: '500' }}>— No match (skip this item) —</Text>
              </TouchableOpacity>
            )}
            {recipes
              .filter((r) => !pickerSearch || r.menuItem.toLowerCase().includes(pickerSearch.toLowerCase()))
              .sort((a, b) => a.menuItem.localeCompare(b.menuItem))
              .map((r) => (
                <TouchableOpacity
                  key={r.id}
                  testID={`posimport-picker-recipe-${r.id}`}
                  onPress={() => {
                    if (pickerForIdx !== null && pickerForIdx >= 0) {
                      setRowMatch(pickerForIdx, r.id);
                    } else if (pickerForIdx === -1 && pickerUnmappedName) {
                      handleMapUnmapped(pickerUnmappedName, r.id);
                    }
                    setPickerForIdx(null);
                    setPickerUnmappedName('');
                  }}
                  style={{ paddingVertical: Spacing.sm, borderBottomWidth: 0.5, borderBottomColor: C.borderLight }}
                >
                  <Text style={{ color: C.textPrimary, fontSize: FontSize.sm, fontWeight: '500' }}>{r.menuItem}</Text>
                  <Text style={{ color: C.textTertiary, fontSize: 10 }}>${r.sellPrice?.toFixed(2) || '0.00'}</Text>
                </TouchableOpacity>
              ))}
          </ScrollView>
          <TouchableOpacity onPress={() => { setPickerForIdx(null); setPickerUnmappedName(''); }} style={{ marginTop: Spacing.sm, alignSelf: 'flex-end' }}>
            <Text style={{ color: C.textSecondary, fontWeight: '500' }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>

    {/* Backfill in-progress overlay — blocks interaction until done. */}
    <Modal visible={backfillRunning} animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: C.bgPrimary, borderColor: C.borderLight, alignItems: 'center' }]}>
          <ActivityIndicator size="large" color={C.textPrimary} />
          <Text style={[styles.modalTitle, { color: C.textPrimary, marginTop: Spacing.md }]}>
            Backfilling from Breadbot
          </Text>
          <Text style={[styles.modalSub, { color: C.textSecondary, marginTop: 4 }]}>
            Day {backfillProgress.current} of {backfillProgress.total}
          </Text>
          <Text style={[styles.modalSub, { color: C.textTertiary, marginTop: 4, textAlign: 'center' }]}>
            {backfillProgress.status}
          </Text>
        </View>
      </View>
    </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: Spacing.lg },
  adminNotice: {
    backgroundColor: Colors.warningBg,
    borderRadius: Radius.sm,
    padding: 6,
    marginBottom: Spacing.md,
  },
  adminNoticeText: { fontSize: FontSize.xs, color: Colors.warning, textAlign: 'center' },
  uploadZone: {
    borderWidth: 1.5,
    borderColor: Colors.borderMedium,
    borderRadius: Radius.lg,
    borderStyle: 'dashed',
    padding: Spacing.xxxl,
    alignItems: 'center',
  },
  uploadIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  uploadTitle: {
    fontSize: FontSize.base,
    fontWeight: '500',
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  uploadSub: { fontSize: FontSize.xs, color: Colors.textSecondary, textAlign: 'center' },
  sampleBox: {
    marginTop: Spacing.lg,
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  sampleTitle: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  sampleSubtitle: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textTertiary,
    marginTop: 6,
    marginBottom: 2,
  },
  sampleRow: {
    fontSize: 10,
    color: Colors.textTertiary,
    fontFamily: 'Courier',
    marginBottom: 2,
  },
  statsBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    marginBottom: Spacing.md,
    flexWrap: 'wrap',
  },
  datePicker: {},
  dateLabel: {
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  dateInput: {
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
    borderRadius: Radius.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    backgroundColor: Colors.bgPrimary,
    minWidth: 130,
  },
  statChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
  },
  statChip: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    minWidth: 60,
  },
  statVal: { fontSize: FontSize.sm, fontWeight: '600', color: Colors.textPrimary },
  statLabel: { fontSize: 9, color: Colors.textTertiary, marginTop: 1 },
  infoBar: {
    backgroundColor: Colors.infoBg,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  infoText: { fontSize: FontSize.xs, color: Colors.info },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: Colors.borderLight,
  },
  previewName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  previewQty: { fontSize: FontSize.xs, color: Colors.textSecondary },
  matchPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: Radius.round,
    maxWidth: 220,
  },
  matchPillText: { fontSize: FontSize.xs, fontWeight: '500' },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  cancelBtn: {
    flex: 1,
    borderWidth: 0.5,
    borderColor: Colors.borderMedium,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  importBtn: {
    flex: 2,
    backgroundColor: Colors.textPrimary,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  importBtnText: { color: Colors.bgPrimary, fontSize: FontSize.sm, fontWeight: '600' },
  doneContainer: {
    flex: 1,
    backgroundColor: Colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  doneCard: {
    backgroundColor: Colors.bgPrimary,
    borderRadius: Radius.xl,
    padding: Spacing.xxxl,
    alignItems: 'center',
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
    width: '100%',
  },
  doneIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.successBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  doneTitle: {
    fontSize: FontSize.xl,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  doneSub: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.xl,
  },
  doneBtn: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.md,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderWidth: 0.5,
    borderColor: Colors.borderLight,
  },
  doneBtnText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },

  // Breadbot fetch card + modal
  breadbotLead: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: Spacing.md,
  },
  breadbotBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: Radius.md,
  },
  breadbotBtnText: { fontSize: FontSize.sm, fontWeight: '600' },
  backfillLink: {
    marginTop: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 0.5,
  },
  backfillLinkText: { fontSize: FontSize.xs, fontWeight: '500' },
  tabRow: {
    flexDirection: 'row',
    marginTop: Spacing.md,
    borderBottomWidth: 0.5,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: { fontSize: FontSize.sm, fontWeight: '500' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
  },
  modalTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  modalSub: { fontSize: FontSize.xs, marginTop: 4 },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: Spacing.lg,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: Radius.md,
    alignItems: 'center',
  },
  modalCancelText: { fontSize: FontSize.sm, fontWeight: '500' },
  modalFetch: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalFetchText: { fontSize: FontSize.sm, fontWeight: '600' },
});
