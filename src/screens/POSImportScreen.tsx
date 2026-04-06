// src/screens/POSImportScreen.tsx
import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, TextInput,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';

const isWeb = Platform.OS === 'web';

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
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [importDate, setImportDate] = useState(todayISO);
  const [fileType, setFileType] = useState<'items' | 'modifiers'>('items');

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
      <View style={styles.doneContainer}>
        <View style={styles.doneCard}>
          <View style={styles.doneIcon}>
            <Ionicons name="checkmark" size={28} color={Colors.success} />
          </View>
          <Text style={styles.doneTitle}>Import complete</Text>
          <Text style={styles.doneSub}>
            {rows.length} items processed for {formatDisplayDate(importDate)}.{'\n'}
            {matchedCount} recipe-matched items will deduct inventory.{'\n'}
            Reconciliation report updated.
          </Text>
          <TouchableOpacity
            style={styles.doneBtn}
            onPress={() => {
              setStep('upload');
              setRows([]);
              setFilename('');
              setImportDate(todayISO());
            }}
          >
            <Text style={styles.doneBtnText}>Import another file</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <WebScrollView id="pos-scroll" contentContainerStyle={styles.content}>
      {step === 'upload' && (
        <Card>
          <CardHeader title="Upload POS sales CSV" />
          <View style={styles.adminNotice}>
            <Text style={styles.adminNoticeText}>
              Admin only · {currentStore.name} · Logged to audit trail
            </Text>
          </View>
          <TouchableOpacity style={styles.uploadZone} onPress={pickFile}>
            <View style={styles.uploadIcon}>
              <Ionicons name="cloud-upload-outline" size={28} color={Colors.textSecondary} />
            </View>
            <Text style={styles.uploadTitle}>Tap to upload CSV file</Text>
            <Text style={styles.uploadSub}>
              Supports item reports and modifier reports
            </Text>
            <Text style={styles.uploadSub}>
              From DoorDash, UberEats, GrubHub, Toast, Square, etc.
            </Text>
          </TouchableOpacity>

          <View style={styles.sampleBox}>
            <Text style={styles.sampleTitle}>Supported formats</Text>
            <Text style={styles.sampleSubtitle}>Item report</Text>
            <Text style={styles.sampleRow}>Source, Item, Item price per order, Sold, Count</Text>
            <Text style={styles.sampleSubtitle}>Modifier report</Text>
            <Text style={styles.sampleRow}>Location, Modifier, Item, Source, Count, Date</Text>
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
                <Text style={styles.dateLabel}>Import date</Text>
                {isWeb ? (
                  <input
                    type="date"
                    value={importDate}
                    onChange={(e: any) => setImportDate(e.target.value)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 8,
                      border: '1px solid rgba(0,0,0,0.15)',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      backgroundColor: '#fff',
                      color: '#1A1A18',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <TextInput
                    style={styles.dateInput}
                    value={importDate}
                    onChangeText={setImportDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={Colors.textTertiary}
                  />
                )}
              </View>
              <View style={styles.statChips}>
                <View style={styles.statChip}>
                  <Text style={styles.statVal}>{rows.length}</Text>
                  <Text style={styles.statLabel}>Items</Text>
                </View>
                <View style={styles.statChip}>
                  <Text style={styles.statVal}>{totalQty}</Text>
                  <Text style={styles.statLabel}>Total sold</Text>
                </View>
                {totalRevenue > 0 && (
                  <View style={styles.statChip}>
                    <Text style={styles.statVal}>${totalRevenue.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Revenue</Text>
                  </View>
                )}
                <View style={[styles.statChip, { backgroundColor: Colors.successBg }]}>
                  <Text style={[styles.statVal, { color: Colors.success }]}>{matchedCount}</Text>
                  <Text style={styles.statLabel}>Matched</Text>
                </View>
                <View style={[styles.statChip, rows.length - matchedCount > 0 ? { backgroundColor: Colors.warningBg } : {}]}>
                  <Text style={[styles.statVal, rows.length - matchedCount > 0 ? { color: Colors.warning } : {}]}>
                    {rows.length - matchedCount}
                  </Text>
                  <Text style={styles.statLabel}>Unmatched</Text>
                </View>
              </View>
            </View>

            <View style={styles.infoBar}>
              <Text style={styles.infoText}>
                {fileType === 'modifiers'
                  ? 'Modifiers matched to recipes will deduct ingredient quantities. Unmatched modifiers (customizations, removals) are skipped.'
                  : 'Items matched to recipes will deduct exact ingredient quantities. Unmatched items are recorded but won\'t affect inventory.'}
              </Text>
            </View>

            {/* Preview rows */}
            {rows.map((row, idx) => {
              const recipe = findRecipe(row.menuItem);
              return (
                <View key={idx} style={styles.previewRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.previewName}>{row.menuItem}</Text>
                    <Text style={styles.previewQty}>
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
              style={styles.cancelBtn}
              onPress={() => {
                setStep('upload');
                setRows([]);
              }}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
              <Text style={styles.importBtnText}>
                Import {rows.length} items · {formatDisplayDate(importDate)}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </WebScrollView>
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
  importBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '600' },
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
});
