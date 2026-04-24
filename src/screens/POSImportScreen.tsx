// src/screens/POSImportScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, TextInput,
  Modal, ActivityIndicator,
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
import { fetchBreadbotSales } from '../lib/db';
import { Colors, useColors, Spacing, Radius, FontSize } from '../theme/colors';

const isWeb = Platform.OS === 'web';

// Stores whose sales live in the breadbot public API. Must match STORE_MAP
// in supabase/functions/fetch-breadbot-sales/index.ts — the client-side set
// is just the UI guard; the edge function is the source of truth.
const BREADBOT_STORES = new Set(['Frederick', 'Charles']);

interface ParsedRow {
  menuItem: string;
  qtySold: number;
  revenue: number;
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
  const { recipes, importPOS, currentUser, currentStore } = useStore();
  const C = useColors();
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [importDate, setImportDate] = useState(todayISO);
  const [fileType, setFileType] = useState<'items' | 'modifiers'>('items');

  // Breadbot fetch modal state
  const [showBreadbotModal, setShowBreadbotModal] = useState(false);
  const [breadbotDate, setBreadbotDate] = useState(todayISO);
  const [fetchingBreadbot, setFetchingBreadbot] = useState(false);
  const storeHasBreadbot = !!currentStore && BREADBOT_STORES.has(currentStore.name);

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

  const findRecipe = (menuItem: string) => {
    // Skip non-food items and removal modifiers
    const lower = menuItem.toLowerCase().trim();
    if (/^(no |add utensils|extra |add )/.test(lower)) return undefined;

    // Exact match
    const exact = recipes.find((r) => r.menuItem.toLowerCase() === lower);
    if (exact) return exact;

    // Word-boundary fuzzy: only match if the full recipe name appears in the POS name or vice versa
    return recipes.find((r) => {
      const rLower = r.menuItem.toLowerCase();
      // POS "BBQ" should not match recipe "BBQ Sauce" — require full containment only for longer names
      if (lower.length < 4 || rLower.length < 4) return false;
      return lower.includes(rLower) || rLower.includes(lower);
    });
  };

  const matchedCount = useMemo(
    () => rows.filter((r) => findRecipe(r.menuItem)).length,
    [rows, recipes],
  );
  const totalQty = rows.reduce((s, r) => s + r.qtySold, 0);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);

  const handleImport = () => {
    const items = rows.map((row) => {
      const recipe = findRecipe(row.menuItem);
      return {
        menuItem: row.menuItem,
        qtySold: row.qtySold,
        revenue: row.revenue,
        recipeId: recipe?.id,
        recipeMapped: !!recipe,
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
    setStep('done');
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
      {step === 'upload' && storeHasBreadbot && (
        <Card>
          <CardHeader title="Fetch from Breadbot" />
          <Text style={[styles.breadbotLead, { color: C.textSecondary }]}>
            Pull {currentStore.name}'s sales directly from the breadbot API instead of uploading a CSV. POS, delivery, and kiosk channels are summed per item.
          </Text>
          <TouchableOpacity
            style={[styles.breadbotBtn, { backgroundColor: C.textPrimary }]}
            onPress={() => {
              setBreadbotDate(todayISO());
              setShowBreadbotModal(true);
            }}
          >
            <Ionicons name="cloud-download-outline" size={18} color={C.bgPrimary} />
            <Text style={[styles.breadbotBtnText, { color: C.bgPrimary }]}>Fetch sales from Breadbot</Text>
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
                <DatePicker value={importDate} onChange={(d) => setImportDate(d || todayISO)} label="Import date" placeholder="Select date" />
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

            {/* Preview rows */}
            {rows.map((row, idx) => {
              const recipe = findRecipe(row.menuItem);
              return (
                <View key={idx} style={[styles.previewRow, { borderBottomColor: C.borderLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.previewName, { color: C.textPrimary }]}>{row.menuItem}</Text>
                    <Text style={[styles.previewQty, { color: C.textSecondary }]}>
                      {row.qtySold} sold{row.revenue > 0 ? ` · $${row.revenue.toFixed(2)}` : ''}
                    </Text>
                  </View>
                  <Badge
                    label={recipe ? recipe.menuItem : 'No recipe'}
                    variant={recipe ? 'ok' : 'low'}
                  />
                </View>
              );
            })}
          </Card>

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor: C.borderMedium }]}
              onPress={() => {
                setStep('upload');
                setRows([]);
              }}
            >
              <Text style={[styles.cancelBtnText, { color: C.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.importBtn, { backgroundColor: C.textPrimary }]} onPress={handleImport}>
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
          <View style={{ marginTop: Spacing.md }}>
            <DatePicker
              value={breadbotDate}
              onChange={(d) => setBreadbotDate(d || todayISO())}
              label="Sales date"
              placeholder="Select date"
            />
          </View>
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.modalCancel, { borderColor: C.borderMedium }]}
              onPress={() => setShowBreadbotModal(false)}
              disabled={fetchingBreadbot}
            >
              <Text style={[styles.modalCancelText, { color: C.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
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
          </View>
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
