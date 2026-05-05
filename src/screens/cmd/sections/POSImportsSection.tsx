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
      {tabId === 'mapping.tsx' ? (
        <MappingTab />
      ) : tabId === 'sources.tsx' ? (
        <SourcesTab />
      ) : (
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
      )}

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

// ─── mapping.tsx — POS pos_name ↔ recipe map ────────────────────────────
// Reads useStore.posRecipeAliases (= pos_recipe_aliases table) for
// confirmed mappings, plus posImports.items where recipeMapped=false for
// unmapped pos_names that need attention. Without this map, sales →
// depletion is broken.
function MappingTab() {
  const C = useCmdColors();
  const aliases = useStore((s) => s.posRecipeAliases);
  const recipes = useStore((s) => s.recipes);
  const posImports = useStore((s) => s.posImports);
  const currentStore = useStore((s) => s.currentStore);

  const storeAliases = React.useMemo(
    () => aliases.filter((a) => a.store_id === currentStore.id),
    [aliases, currentStore.id],
  );

  // Confirmed mappings, joined to recipe.
  const confirmed = React.useMemo(
    () =>
      storeAliases
        .map((a) => ({
          pos_name: a.pos_name,
          recipe_id: a.recipe_id,
          recipe: recipes.find((r) => r.id === a.recipe_id),
        }))
        .sort((a, b) => a.pos_name.localeCompare(b.pos_name)),
    [storeAliases, recipes],
  );

  // Unmapped pos_names (with sales count for triage).
  const unmapped = React.useMemo(() => {
    const map = new Map<string, { pos_name: string; rows: number; lastSeen: string }>();
    for (const im of posImports.filter((p) => p.storeId === currentStore.id)) {
      for (const it of im.items || []) {
        if (it.recipeMapped) continue;
        const key = it.menuItem?.trim() || '—';
        const cur = map.get(key) || { pos_name: key, rows: 0, lastSeen: im.importedAt };
        cur.rows += 1;
        if (new Date(im.importedAt) > new Date(cur.lastSeen)) cur.lastSeen = im.importedAt;
        map.set(key, cur);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.rows - a.rows);
  }, [posImports, currentStore.id]);

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>POS mapping</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          POS SKU ↔ recipe map. Unmapped rows are ghost sales — depletion drifts until they're matched.
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Confirmed" value={String(confirmed.length)} sub="active aliases" />
        <StatCard label="Unmapped" value={String(unmapped.length)} sub={unmapped.length === 0 ? 'all clean' : 'needs match'} />
        <StatCard label="Ghost rows" value={String(unmapped.reduce((s, u) => s + u.rows, 0))} sub="across imports" />
      </View>

      <View style={{ flexDirection: 'row', gap: 14 }}>
        <SectionPanel title="UNMAPPED.LOG" right={`${unmapped.length}`} style={{ flex: 1 }}>
          {unmapped.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>no unmapped pos_names</Text>
          ) : (
            unmapped.slice(0, 20).map((u, i) => (
              <View key={u.pos_name} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>{u.pos_name}</Text>
                <View style={{ borderWidth: 1, borderColor: C.warn, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: C.warnBg }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.4 }}>UNMAPPED</Text>
                </View>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2, width: 50, textAlign: 'right' }}>{u.rows}×</Text>
              </View>
            ))
          )}
        </SectionPanel>
        <SectionPanel title="ACTIVE_ALIASES.TSV" right={`${confirmed.length}`} style={{ flex: 1.4 }}>
          {confirmed.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>
              no aliases yet — confirm an unmapped row in imports.tsx review and it will land here
            </Text>
          ) : (
            confirmed.map((c, i) => (
              <View key={c.pos_name} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>{c.pos_name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>→</Text>
                <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>
                  {c.recipe ? c.recipe.menuItem : <Text style={{ color: C.danger }}>recipe missing ({c.recipe_id.slice(0, 6)})</Text>}
                </Text>
                <View style={{ borderWidth: 1, borderColor: C.ok, borderRadius: CmdRadius.xs, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: C.okBg }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.ok, letterSpacing: 0.4 }}>OK</Text>
                </View>
              </View>
            ))
          )}
        </SectionPanel>
      </View>
    </ScrollView>
  );
}

// ─── sources.tsx — POS connector status (Tier 2 placeholder) ────────────
function SourcesTab() {
  const C = useCmdColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>POS sources</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Connected POS providers (Toast / Square / Clover / CSV). Sources are upstream of imports.tsx.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Today the only source is the manual CSV upload exposed on imports.tsx.
          Adding Toast/Square/Clover connectors needs a `pos_sources` table + OAuth flow + scheduled cron — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Local Panel helper ────────────────────────────────────────────────
function SectionPanel({ title, right, style, children }: { title: string; right?: string; style?: any; children: React.ReactNode }) {
  const C = useCmdColors();
  return (
    <View style={[{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border, borderStyle: 'dashed' }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{title}</Text>
        {right ? <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{right}</Text> : null}
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>{children}</View>
    </View>
  );
}
