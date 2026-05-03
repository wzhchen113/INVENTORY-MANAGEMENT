import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { UploadCsvModal } from '../../../components/cmd/UploadCsvModal';
import { RunImportModal } from '../../../components/cmd/RunImportModal';
import { relativeTime } from '../../../utils/relativeTime';
import { ColumnMapping, computeDiff, DiffSummary } from '../../../lib/csvImport';

// Pattern C — stream/report. Table of POS imports with state pill +
// counts. Reads useStore.posImports for the current store. Empty state
// when no imports exist (default seeded state).
export default function POSImportsSection() {
  const C = useCmdColors();
  const posImports = useStore((s) => s.posImports);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const [tabId, setTabId] = React.useState('imports.tsx');
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [runOpen, setRunOpen] = React.useState(false);
  const [pendingFilename, setPendingFilename] = React.useState('');
  const [pendingDiff, setPendingDiff] = React.useState<DiffSummary | null>(null);

  const imports = React.useMemo(
    () => posImports.filter((p) => p.storeId === currentStore.id).slice().reverse(),
    [posImports, currentStore.id],
  );

  // For each import: rows = items.length, matched = items where recipeMapped, errors = unmapped count
  const rowsTotal = imports.reduce((s, im) => s + (im.items?.length || 0), 0);
  const matchedTotal = imports.reduce(
    (s, im) => s + (im.items || []).filter((it) => it.recipeMapped).length,
    0,
  );
  const unmappedTotal = rowsTotal - matchedTotal;
  const failedCount = imports.filter((im) => (im.items || []).length > 0 && (im.items || []).every((it) => !it.recipeMapped)).length;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minWidth: 0 }}>
      <TabStrip
        tabs={[
          { id: 'imports.tsx', label: 'imports.tsx' },
          { id: 'mapping.tsx', label: 'mapping.tsx' },
          { id: 'sources.tsx', label: 'sources.tsx' },
        ]}
        activeId={tabId}
        onChange={setTabId}
        rightSlot={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => setUploadOpen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
              <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>UPLOAD CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { if (!pendingDiff) { setUploadOpen(true); return; } setRunOpen(true); }} style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: pendingDiff ? C.accent : C.panel2, borderRadius: CmdRadius.sm, opacity: pendingDiff ? 1 : 0.6 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: pendingDiff ? '#000' : C.fg3 }}>RUN IMPORT</Text>
            </TouchableOpacity>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View>
          <Text style={[Type.h1, { color: C.fg }]}>POS imports</Text>
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
            Sales feeds depletion. Errors = SKU not mapped to a recipe.
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            label="Last import"
            value={imports[0] ? relativeTime(imports[0].importedAt) || '—' : '—'}
            sub={imports[0]?.filename || 'no imports yet'}
          />
          <StatCard label="Rows" value={String(rowsTotal)} sub={imports.length === 0 ? 'no imports' : `across ${imports.length} import${imports.length === 1 ? '' : 's'}`} />
          <StatCard label="Unmapped" value={String(unmappedTotal)} sub={unmappedTotal === 0 ? '—' : 'needs attention'} />
          <StatCard label="Failed" value={String(failedCount)} sub={failedCount === 0 ? '—' : 'review parse errors'} />
        </View>

        <View
          style={{
            backgroundColor: C.panel,
            borderRadius: CmdRadius.lg,
            borderWidth: 1,
            borderColor: C.border,
            overflow: 'hidden',
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>imports.log</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{imports.length} imports</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 24 }}> </Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 2 }}>file</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70 }}>when</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 70, textAlign: 'right' }}>rows</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 100, textAlign: 'right' }}>matched</Text>
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>state</Text>
          </View>
          {imports.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              no POS imports for {currentStore.name || 'this store'} — upload a CSV from Toast / Square / Clover to start
            </Text>
          ) : (
            imports.map((im, i) => {
              const total = im.items?.length || 0;
              const matched = (im.items || []).filter((it) => it.recipeMapped).length;
              const errors = total - matched;
              const status: 'ok' | 'low' | 'out' =
                total > 0 && matched === 0 ? 'out' : errors > 0 ? 'low' : 'ok';
              const statusLabel = status === 'ok' ? 'success' : status === 'low' ? 'partial' : 'failed';
              const glyph = status === 'ok' ? '✓' : status === 'low' ? '!' : '✕';
              const glyphColor = status === 'ok' ? C.ok : status === 'low' ? C.warn : C.danger;
              return (
                <View
                  key={im.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 9,
                    paddingHorizontal: 14,
                    gap: 10,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                    backgroundColor: status === 'out' ? C.dangerBg : 'transparent',
                  }}
                >
                  <Text style={{ fontFamily: mono(400), fontSize: 13, color: glyphColor, width: 24 }}>{glyph}</Text>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 2 }} numberOfLines={1}>
                    {im.filename}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 70 }}>
                    {relativeTime(im.importedAt)}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 70, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {total}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: errors > 0 ? C.warn : C.fg, width: 100, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                    {matched}
                    {errors > 0 ? <Text style={{ color: C.danger }}> (−{errors})</Text> : null}
                  </Text>
                  <View style={{ width: 90, alignItems: 'flex-end' }}>
                    <StatusPill status={status} label={statusLabel.toUpperCase()} />
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      <UploadCsvModal
        visible={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onContinue={(file, rows, mapping: ColumnMapping[]) => {
          const diff = computeDiff(rows, mapping, inventory, currentStore.id);
          setPendingFilename(file.name);
          setPendingDiff(diff);
          setUploadOpen(false);
          setRunOpen(true);
        }}
      />
      <RunImportModal
        visible={runOpen}
        filename={pendingFilename}
        diff={pendingDiff}
        onClose={() => { setRunOpen(false); setPendingDiff(null); }}
      />
    </View>
  );
}
