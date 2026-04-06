// src/screens/POSImportScreen.tsx
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useStore } from '../store/useStore';
import { Card, CardHeader, Badge } from '../components';
import { WebScrollView } from '../components/WebScrollView';
import { Colors, Spacing, Radius, FontSize } from '../theme/colors';

interface ParsedRow {
  menuItem: string;
  qtySold: number;
  revenue: number;
}

export default function POSImportScreen() {
  const { recipes, importPOS, currentUser } = useStore();
  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [colItem, setColItem] = useState(0);
  const [colQty, setColQty] = useState(1);
  const [headers, setHeaders] = useState<string[]>([]);

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'text/comma-separated-values' });
      if (result.canceled) return;
      const asset = result.assets[0];
      setFilename(asset.name);
      const text = await FileSystem.readAsStringAsync(asset.uri);
      parseCSV(text, asset.name);
    } catch (e) {
      Alert.alert('Error', 'Could not read file. Make sure it is a .csv file.');
    }
  };

  const parseCSV = (text: string, fname: string) => {
    const lines = text.trim().split('\n').map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
    if (lines.length < 2) { Alert.alert('Error', 'CSV must have at least a header row and one data row'); return; }
    const hdrs = lines[0];
    setHeaders(hdrs);
    // Auto-detect columns
    const itemCol = hdrs.findIndex((h) => /item|name|product|menu|desc/i.test(h));
    const qtyCol = hdrs.findIndex((h) => /qty|quantity|sold|count|amount/i.test(h));
    if (itemCol >= 0) setColItem(itemCol);
    if (qtyCol >= 0) setColQty(qtyCol);

    const parsed: ParsedRow[] = lines.slice(1)
      .filter((row) => row.length > 1 && row[itemCol >= 0 ? itemCol : 0])
      .map((row) => ({
        menuItem: row[itemCol >= 0 ? itemCol : 0] || '',
        qtySold: parseFloat(row[qtyCol >= 0 ? qtyCol : 1]) || 0,
        revenue: parseFloat(row[2]) || 0,
      }));
    setRows(parsed);
    setStep('preview');
  };

  const findRecipe = (menuItem: string) =>
    recipes.find((r) => r.menuItem.toLowerCase() === menuItem.toLowerCase() || menuItem.toLowerCase().includes(r.menuItem.toLowerCase().split(' ')[0]));

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
      importedAt: new Date().toLocaleString(),
      importedBy: currentUser?.name || '',
      date: new Date().toLocaleDateString(),
      storeId: 's1',
      items,
    });
    setStep('done');
  };

  if (step === 'done') {
    return (
      <View style={styles.doneContainer}>
        <View style={styles.doneCard}>
          <View style={styles.doneIcon}><Text style={styles.doneIconText}>✓</Text></View>
          <Text style={styles.doneTitle}>Import complete</Text>
          <Text style={styles.doneSub}>
            {rows.length} items processed. Inventory deducted using recipe ratios where mapped. Reconciliation report updated.
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => { setStep('upload'); setRows([]); setFilename(''); }}>
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
            <Text style={styles.adminNoticeText}>Admin only · Logged to audit trail</Text>
          </View>
          <TouchableOpacity style={styles.uploadZone} onPress={pickFile}>
            <View style={styles.uploadIcon}>
              <Text style={styles.uploadIconText}>↑</Text>
            </View>
            <Text style={styles.uploadTitle}>Tap to upload CSV file</Text>
            <Text style={styles.uploadSub}>From your POS system (Toast, Square, Clover, etc.)</Text>
            <Text style={styles.uploadSub}>Columns: item name + qty sold</Text>
          </TouchableOpacity>

          <View style={styles.sampleBox}>
            <Text style={styles.sampleTitle}>Expected format</Text>
            <Text style={styles.sampleRow}>Item Name, Qty Sold, Revenue</Text>
            <Text style={styles.sampleRow}>Grilled Chicken Plate, 36, 504.00</Text>
            <Text style={styles.sampleRow}>Beef Burger, 16, 208.00</Text>
            <Text style={styles.sampleRow}>Caesar Salad, 14, 168.00</Text>
          </View>
        </Card>
      )}

      {step === 'preview' && (
        <>
          <Card>
            <CardHeader title={`Preview — ${filename}`} right={
              <Badge label={`${rows.length} rows`} variant="ok" />
            } />
            <View style={styles.infoBar}>
              <Text style={styles.infoText}>
                Items with a matched recipe will deduct exact ingredient quantities. Unmatched items use usage-per-portion estimates.
              </Text>
            </View>
            {rows.map((row, idx) => {
              const recipe = findRecipe(row.menuItem);
              return (
                <View key={idx} style={styles.previewRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.previewName}>{row.menuItem}</Text>
                    <Text style={styles.previewQty}>{row.qtySold} sold · ${row.revenue.toFixed(2)}</Text>
                  </View>
                  <Badge
                    label={recipe ? `Recipe: ${recipe.menuItem}` : 'No recipe'}
                    variant={recipe ? 'ok' : 'low'}
                  />
                </View>
              );
            })}
          </Card>

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => { setStep('upload'); setRows([]); }}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.importBtn} onPress={handleImport}>
              <Text style={styles.importBtnText}>Import & reconcile</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </WebScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bgTertiary },
  content: { padding: Spacing.lg },
  adminNotice: { backgroundColor: Colors.warningBg, borderRadius: Radius.sm, padding: 6, marginBottom: Spacing.md },
  adminNoticeText: { fontSize: FontSize.xs, color: Colors.warning, textAlign: 'center' },
  uploadZone: { borderWidth: 1.5, borderColor: Colors.borderMedium, borderRadius: Radius.lg, borderStyle: 'dashed', padding: Spacing.xxxl, alignItems: 'center' },
  uploadIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.bgSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.md },
  uploadIconText: { fontSize: 22, color: Colors.textSecondary },
  uploadTitle: { fontSize: FontSize.base, fontWeight: '500', color: Colors.textPrimary, marginBottom: 4 },
  uploadSub: { fontSize: FontSize.xs, color: Colors.textSecondary, textAlign: 'center' },
  sampleBox: { marginTop: Spacing.lg, backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, padding: Spacing.md },
  sampleTitle: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.textSecondary, marginBottom: 6 },
  sampleRow: { fontSize: 10, color: Colors.textTertiary, fontFamily: 'Courier', marginBottom: 2 },
  infoBar: { backgroundColor: Colors.infoBg, borderRadius: Radius.md, padding: Spacing.sm, marginBottom: Spacing.md },
  infoText: { fontSize: FontSize.xs, color: Colors.info },
  previewRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: Colors.borderLight },
  previewName: { fontSize: FontSize.sm, fontWeight: '500', color: Colors.textPrimary },
  previewQty: { fontSize: FontSize.xs, color: Colors.textSecondary },
  actionRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  cancelBtn: { flex: 1, borderWidth: 0.5, borderColor: Colors.borderMedium, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  cancelBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary },
  importBtn: { flex: 2, backgroundColor: Colors.textPrimary, borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center' },
  importBtnText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: '600' },
  doneContainer: { flex: 1, backgroundColor: Colors.bgTertiary, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  doneCard: { backgroundColor: Colors.bgPrimary, borderRadius: Radius.xl, padding: Spacing.xxxl, alignItems: 'center', borderWidth: 0.5, borderColor: Colors.borderLight, width: '100%' },
  doneIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.successBg, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.lg },
  doneIconText: { fontSize: 24, color: Colors.success },
  doneTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.textPrimary, marginBottom: Spacing.sm },
  doneSub: { fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: Spacing.xl },
  doneBtn: { backgroundColor: Colors.bgSecondary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 0.5, borderColor: Colors.borderLight },
  doneBtnText: { fontSize: FontSize.sm, color: Colors.textPrimary, fontWeight: '500' },
});
