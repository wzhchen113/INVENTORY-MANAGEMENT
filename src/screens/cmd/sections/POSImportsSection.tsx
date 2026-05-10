import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { UploadCsvModal } from '../../../components/cmd/UploadCsvModal';
import { RunImportModal } from '../../../components/cmd/RunImportModal';
import { FetchBreadbotModal, ParsedRow } from '../../../components/cmd/FetchBreadbotModal';
import { RecipePickerModal } from '../../../components/cmd/RecipePickerModal';
import { relativeTime } from '../../../utils/relativeTime';
import { ColumnMapping, computeDiff, DiffSummary } from '../../../lib/csvImport';
import { BREADBOT_STORES, BackfillResult } from '../../../lib/posBreadbot';
import { savePOSImport, fetchUnmappedPosImports } from '../../../lib/db';
import { matchRecipe, MatchResult } from '../../../utils/recipeMatch';
import { confirmAction } from '../../../utils/confirmAction';

// Pattern C — stream/report. Table of POS imports with state pill +
// counts. Reads useStore.posImports for the current store. Empty state
// when no imports exist (default seeded state).
// Section-local preview shape — single Breadbot fetch hands off these
// rows after success, and the section renders a Cmd-styled preview card
// (recipe pills + confirm) above the imports table. Mirrors the legacy
// `step === 'preview'` flow in POSImportScreen.tsx, NOT the CSV
// computeDiff → RunImportModal pipeline (which operates on inventory
// item rows, not POS sales rows).
type RowMatch = { recipeId: string | null; matchType: MatchResult['matchType'] };
type BreadbotPreview = {
  filename: string;
  rows: ParsedRow[];
  date: string;
};

export default function POSImportsSection() {
  const C = useCmdColors();
  const posImports = useStore((s) => s.posImports);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const recipes = useStore((s) => s.recipes);
  const posRecipeAliases = useStore((s) => s.posRecipeAliases);
  const importPOS = useStore((s) => s.importPOS);
  const upsertPosRecipeAliases = useStore((s) => s.upsertPosRecipeAliases);
  const currentUser = useStore((s) => s.currentUser);

  const [tabId, setTabId] = React.useState('imports.tsx');
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [runOpen, setRunOpen] = React.useState(false);
  const [pendingFilename, setPendingFilename] = React.useState('');
  const [pendingDiff, setPendingDiff] = React.useState<DiffSummary | null>(null);

  // ── Breadbot fetch state (Cmd UI port) ─────────────────────────────
  // `breadbotOpen` toggles FetchBreadbotModal. `breadbotPreview` holds
  // the post-single-fetch rows for in-section preview render. Range
  // backfill writes its outcomes into `backfillResults`, surfaced as
  // a dismissable Cmd-palette summary card above the imports table.
  const storeHasBreadbot = !!currentStore && BREADBOT_STORES.has(currentStore.name);
  const [breadbotOpen, setBreadbotOpen] = React.useState(false);
  const [breadbotPreview, setBreadbotPreview] = React.useState<BreadbotPreview | null>(null);
  const [previewMatches, setPreviewMatches] = React.useState<RowMatch[]>([]);
  // Spec 015 §10 — per-row override map. User-confirmed overrides survive
  // the re-match `useEffect` below; cleared whenever the preview itself
  // resets (cancel / confirm).
  const [previewOverrides, setPreviewOverrides] = React.useState<Record<number, RowMatch>>({});
  // Section-local picker state — `pickerForIdx` is the row index whose
  // pill is being edited; null means closed.
  const [pickerForIdx, setPickerForIdx] = React.useState<number | null>(null);
  const [committingPreview, setCommittingPreview] = React.useState(false);
  const [backfillResults, setBackfillResults] = React.useState<BackfillResult[] | null>(null);

  // Spec 015 §10 — re-run the matcher whenever preview rows / recipes /
  // aliases change, BUT honor any per-row override the user has set so
  // their picks survive subsequent re-matches (alias slice mutations,
  // recipe loads, etc).
  React.useEffect(() => {
    if (!breadbotPreview) {
      setPreviewMatches([]);
      setPreviewOverrides({});  // reset overrides when preview clears
      return;
    }
    setPreviewMatches(
      breadbotPreview.rows.map((r, idx) => {
        if (idx in previewOverrides) return previewOverrides[idx];
        const m = matchRecipe(r.menuItem, recipes, posRecipeAliases);
        return { recipeId: m.recipeId, matchType: m.matchType };
      }),
    );
  }, [breadbotPreview, recipes, posRecipeAliases, previewOverrides]);

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
            {storeHasBreadbot && (
              <TouchableOpacity
                testID="breadbot-cmd-open"
                onPress={() => {
                  // Invalidate any pending CSV diff so a stale CSV preview
                  // can't be confirmed against a Breadbot context (spec
                  // 014 lines 103-107).
                  setPendingDiff(null);
                  setPendingFilename('');
                  setBreadbotOpen(true);
                }}
                style={{
                  paddingVertical: 4,
                  paddingHorizontal: 10,
                  borderWidth: 1,
                  borderColor: C.borderStrong,
                  borderRadius: CmdRadius.sm,
                }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>FETCH BREADBOT</Text>
              </TouchableOpacity>
            )}
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

        {/* Backfill summary — Cmd-styled inline card. Mirrors legacy
            BackfillResult render at POSImportScreen.tsx:530-587. */}
        {backfillResults && (
          <BackfillSummaryCard results={backfillResults} onDismiss={() => setBackfillResults(null)} />
        )}

        {/* Single-fetch in-section preview. Renders above the imports
            table; the imports.log itself remains visible below as a
            read-only history (matches Cmd UI's stack layout, distinct
            from the legacy hide-on-preview model). */}
        {breadbotPreview && (
          <BreadbotPreviewCard
            preview={breadbotPreview}
            matches={previewMatches}
            committing={committingPreview}
            onPickRow={(idx) => setPickerForIdx(idx)}
            onCancel={() => {
              setBreadbotPreview(null);
              setPreviewMatches([]);
              setPreviewOverrides({});
            }}
            onConfirm={async () => {
              if (committingPreview) return;
              setCommittingPreview(true);
              const items = breadbotPreview.rows.map((row, idx) => {
                const m = previewMatches[idx];
                return {
                  menuItem: row.menuItem,
                  qtySold: row.qtySold,
                  revenue: row.revenue,
                  recipeId: m?.recipeId ?? undefined,
                  recipeMapped: !!m?.recipeId,
                };
              });
              try {
                // 1. Persist to pos_imports with explicit business date so
                //    future hasPOSImportForDate() calls dedup correctly
                //    across sessions/reloads (legacy parity at
                //    POSImportScreen.tsx:438).
                await savePOSImport(
                  currentStore.id,
                  breadbotPreview.filename,
                  currentUser?.id || '',
                  items,
                  breadbotPreview.date,
                );
                // 2. In-memory + inventory deduction.
                importPOS({
                  filename: breadbotPreview.filename,
                  importedAt: new Date().toISOString(),
                  importedBy: currentUser?.name || '',
                  date: breadbotPreview.date,
                  storeId: currentStore.id,
                  items,
                });
                // 3. Persist confirmed matches as aliases so the same POS
                //    string never re-fuzzy-matches on subsequent imports
                //    (legacy parity at POSImportScreen.tsx:351-356).
                const aliases = breadbotPreview.rows
                  .map((row, idx) => ({ posName: row.menuItem, recipeId: previewMatches[idx]?.recipeId }))
                  .filter((a): a is { posName: string; recipeId: string } => !!a.recipeId);
                if (aliases.length > 0) {
                  upsertPosRecipeAliases(aliases).catch(() => { /* best-effort */ });
                }
                Toast.show({
                  type: 'success',
                  text1: 'Import complete',
                  text2: `${items.length} item${items.length === 1 ? '' : 's'} for ${breadbotPreview.date}`,
                  position: 'bottom',
                });
                setBreadbotPreview(null);
                setPreviewMatches([]);
                setPreviewOverrides({});
              } catch (e: any) {
                Toast.show({
                  type: 'error',
                  text1: 'Import failed',
                  text2: e?.message || 'Could not write pos_imports',
                  position: 'bottom',
                });
              } finally {
                setCommittingPreview(false);
              }
            }}
          />
        )}

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
              no POS imports for {currentStore.name || 'this store'} — upload a CSV from Toast / Square / Clover{storeHasBreadbot ? ', or fetch from Breadbot' : ''} to start
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
      {storeHasBreadbot && (
        <FetchBreadbotModal
          visible={breadbotOpen}
          onClose={() => setBreadbotOpen(false)}
          storeId={currentStore.id}
          storeName={currentStore.name}
          onSingleFetched={(filename, rows, importDate) => {
            // Section-local preview state — render the rows + recipe
            // pills above the imports table. The section confirm action
            // calls savePOSImport + importPOS itself (legacy parity at
            // POSImportScreen.tsx:330-358), NOT computeDiff →
            // RunImportModal (architect contract correction).
            setBreadbotPreview({ filename, rows, date: importDate });
            setPreviewOverrides({});
            setBackfillResults(null);
            setBreadbotOpen(false);
          }}
          onBackfillComplete={(results) => {
            setBackfillResults(results);
            setBreadbotPreview(null);
            setPreviewOverrides({});
            setBreadbotOpen(false);
          }}
        />
      )}
      {/* Spec 015 — per-row override picker. Open whenever pickerForIdx is
          a valid row index. onPick writes to the section-local
          previewOverrides map; the re-match useEffect honors it. */}
      {breadbotPreview && pickerForIdx !== null && pickerForIdx >= 0 && pickerForIdx < breadbotPreview.rows.length ? (
        <RecipePickerModal
          visible
          onClose={() => setPickerForIdx(null)}
          posName={breadbotPreview.rows[pickerForIdx].menuItem}
          currentRecipeId={previewMatches[pickerForIdx]?.recipeId ?? null}
          allowNoMatch
          onPick={(recipeId) => {
            const idx = pickerForIdx;
            setPreviewOverrides((prev) => ({
              ...prev,
              [idx]: { recipeId, matchType: recipeId ? 'alias' : 'none' },
            }));
            setPickerForIdx(null);
          }}
        />
      ) : null}
    </View>
  );
}

// ─── Backfill summary card (Cmd palette) ───────────────────────────────
// Inline card above the imports table. Surfaces the per-day outcomes
// from a range backfill. Mirrors legacy `BackfillResult[]` render at
// POSImportScreen.tsx:530-587 with Cmd-styled chips.
function BackfillSummaryCard({
  results,
  onDismiss,
}: {
  results: BackfillResult[];
  onDismiss: () => void;
}) {
  const C = useCmdColors();
  const imported = results.filter((r) => r.outcome === 'imported');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  const failed = results.filter((r) => r.outcome === 'failed');
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.border,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingTop: 12,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <SectionCaption tone="fg3" size={10.5}>backfill.summary</SectionCaption>
        <TouchableOpacity
          testID="breadbot-cmd-summary-dismiss"
          onPress={onDismiss}
          style={{ paddingHorizontal: 6, paddingVertical: 2 }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg3 }}>×</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10 }}>
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: CmdRadius.sm,
            backgroundColor: C.okBg,
            minWidth: 70,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.ok, fontVariant: ['tabular-nums'] }}>
            {imported.length}
          </Text>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            imported
          </Text>
        </View>
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: CmdRadius.sm,
            backgroundColor: C.panel2,
            minWidth: 70,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.fg, fontVariant: ['tabular-nums'] }}>
            {skipped.length}
          </Text>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            skipped
          </Text>
        </View>
        {failed.length > 0 && (
          <View
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: CmdRadius.sm,
              backgroundColor: C.dangerBg,
              minWidth: 70,
              alignItems: 'center',
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.danger, fontVariant: ['tabular-nums'] }}>
              {failed.length}
            </Text>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                marginTop: 2,
              }}
            >
              failed
            </Text>
          </View>
        )}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: C.border }}>
        {results.map((r, i) => {
          const status: 'ok' | 'low' | 'out' =
            r.outcome === 'imported' ? 'ok' : r.outcome === 'failed' ? 'out' : 'low';
          return (
            <View
              key={r.date}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 14,
                paddingVertical: 8,
                gap: 10,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: C.border,
                borderStyle: 'dashed',
              }}
            >
              <Text
                style={{
                  fontFamily: mono(500),
                  fontSize: 11.5,
                  color: C.fg,
                  width: 100,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {r.date}
              </Text>
              <Text
                style={{
                  fontFamily: mono(400),
                  fontSize: 11,
                  color: C.fg3,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {r.outcome === 'imported' && r.itemCount !== undefined
                  ? `${r.itemCount} item${r.itemCount === 1 ? '' : 's'}`
                  : r.reason || '—'}
              </Text>
              <View style={{ alignItems: 'flex-end' }}>
                <StatusPill status={status} label={r.outcome.toUpperCase()} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Single-fetch preview card (Cmd palette) ───────────────────────────
// Renders the parsed Breadbot rows above the imports.log table with a
// recipe-match pill per row and a confirm button. Per spec 015 §10 each
// pill is pressable — opens the parent's RecipePickerModal which writes
// the user's choice to a section-local `previewOverrides` map. Override
// state survives the re-match useEffect (which would otherwise reset it
// when `recipes` or `posRecipeAliases` mutates).
function BreadbotPreviewCard({
  preview,
  matches,
  committing,
  onPickRow,
  onCancel,
  onConfirm,
}: {
  preview: BreadbotPreview;
  matches: RowMatch[];
  committing: boolean;
  /** Spec 015 §10 — open the per-row picker for this row index. */
  onPickRow: (idx: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const C = useCmdColors();
  const recipes = useStore((s) => s.recipes);
  const matchedCount = matches.filter((m) => m.recipeId).length;
  const totalQty = preview.rows.reduce((s, r) => s + r.qtySold, 0);
  const totalRevenue = preview.rows.reduce((s, r) => s + r.revenue, 0);
  return (
    <View
      style={{
        backgroundColor: C.panel,
        borderRadius: CmdRadius.lg,
        borderWidth: 1,
        borderColor: C.borderStrong,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 14,
          paddingTop: 12,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
          <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>PREVIEW</Text>
        </View>
        <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>
          {preview.filename}
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          {preview.rows.length} rows · {totalQty} sold{totalRevenue > 0 ? ` · $${totalRevenue.toFixed(2)}` : ''}
        </Text>
      </View>
      <View
        style={{
          flexDirection: 'row',
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          backgroundColor: C.panel2,
        }}
      >
        <View
          style={{
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 3,
            backgroundColor: C.okBg,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.ok, letterSpacing: 0.4 }}>
            {matchedCount} MATCHED
          </Text>
        </View>
        {preview.rows.length - matchedCount > 0 && (
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 3,
              backgroundColor: C.warnBg,
            }}
          >
            <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.4 }}>
              {preview.rows.length - matchedCount} UNMAPPED
            </Text>
          </View>
        )}
      </View>
      <View style={{ maxHeight: 360 }}>
        <ScrollView>
          {preview.rows.map((row, idx) => {
            const m = matches[idx];
            const recipe = m?.recipeId ? recipes.find((r) => r.id === m.recipeId) : null;
            const isFuzzy = m?.matchType === 'fuzzy';
            const isNone = !recipe;
            const fg = isNone ? C.danger : isFuzzy ? C.warn : C.ok;
            const bg = isNone ? C.dangerBg : isFuzzy ? C.warnBg : C.okBg;
            const label = recipe?.menuItem ?? 'no match';
            return (
              <View
                key={`${row.menuItem}-${idx}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  gap: 10,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: C.border,
                  borderStyle: 'dashed',
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg }} numberOfLines={1}>
                    {row.menuItem}
                  </Text>
                  {row.canonical && row.canonical.toLowerCase() !== row.menuItem.toLowerCase() && (
                    <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, marginTop: 2 }}>
                      → breadbot: {row.canonical}
                    </Text>
                  )}
                </View>
                <Text
                  style={{
                    fontFamily: mono(400),
                    fontSize: 11,
                    color: C.fg3,
                    width: 90,
                    textAlign: 'right',
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {row.qtySold} sold{row.revenue > 0 ? ` · $${row.revenue.toFixed(2)}` : ''}
                </Text>
                {/* Spec 015 §10 — pill is pressable. Tapping opens the
                    per-row picker; user pick writes to previewOverrides. */}
                <TouchableOpacity
                  testID={`posimport-cmd-row-picker-${idx}`}
                  onPress={() => onPickRow(idx)}
                  disabled={committing}
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 3,
                    backgroundColor: bg,
                    maxWidth: 200,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    opacity: committing ? 0.6 : 1,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: mono(700),
                      fontSize: 9.5,
                      color: fg,
                      letterSpacing: 0.4,
                    }}
                    numberOfLines={1}
                  >
                    {label.toUpperCase()}{isFuzzy ? ' (GUESS)' : ''}
                  </Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 8.5, color: fg, opacity: 0.7 }}>▾</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderTopColor: C.border,
          backgroundColor: C.panel,
        }}
      >
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
          {preview.rows.length - matchedCount === 0
            ? 'all rows mapped — depletion will run'
            : 'unmapped rows record but skip depletion · map them on mapping.tsx after import'}
        </Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          testID="breadbot-cmd-preview-cancel"
          onPress={onCancel}
          disabled={committing}
          style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            opacity: committing ? 0.5 : 1,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="breadbot-cmd-preview-confirm"
          onPress={onConfirm}
          disabled={committing}
          style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: CmdRadius.sm,
            backgroundColor: C.accent,
            opacity: committing ? 0.6 : 1,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.accentFg }}>
            {committing
              ? 'IMPORTING…'
              : `IMPORT ${preview.rows.length} ITEM${preview.rows.length === 1 ? '' : 'S'} · ${preview.date}`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── mapping.tsx — POS pos_name ↔ recipe map ────────────────────────────
// Reads useStore.posRecipeAliases (= pos_recipe_aliases table) for
// confirmed mappings. Unmapped panel is a UNION of (a) server-fetched
// fetchUnmappedPosImports (last 30 days, canonical for the long-tail
// rescue path) and (b) local-derived unmapped from `posImports.items`
// (catches names just-imported that the server fetch hasn't reflected
// yet). Per spec 015 §9.
//
// Each row is interactive:
//   - Unmapped row → opens RecipePickerModal → upsertPosRecipeAliases +
//     applyAliasToPastImports (Surfaces 2 + 3, retroactive flip).
//   - Active alias row → edit (re-pick) or remove (confirmAction-gated).
//     Global aliases (store_id === null) hide the remove affordance per §11.
function MappingTab() {
  const C = useCmdColors();
  const aliases = useStore((s) => s.posRecipeAliases);
  const recipes = useStore((s) => s.recipes);
  const posImports = useStore((s) => s.posImports);
  const currentStore = useStore((s) => s.currentStore);
  const upsertPosRecipeAliases = useStore((s) => s.upsertPosRecipeAliases);
  const applyAliasToPastImports = useStore((s) => s.applyAliasToPastImports);
  const removePosRecipeAlias = useStore((s) => s.removePosRecipeAlias);

  // Spec 015 §9 — server-fetched unmapped + refreshTick to re-fetch after
  // any add/edit/remove that mutates aliases.
  const [serverUnmapped, setServerUnmapped] = React.useState<{ menu_item: string; count: number }[]>([]);
  const [refreshTick, setRefreshTick] = React.useState(0);
  React.useEffect(() => {
    if (!currentStore.id) return;
    let cancelled = false;
    fetchUnmappedPosImports(currentStore.id)
      .then((rows) => { if (!cancelled) setServerUnmapped(rows); })
      .catch(() => { if (!cancelled) setServerUnmapped([]); });
    return () => { cancelled = true; };
  }, [currentStore.id, refreshTick]);
  const triggerServerRefresh = React.useCallback(() => setRefreshTick((n) => n + 1), []);

  // Picker state. `pickerPosName` is the row being mapped; `pickerCurrentRecipeId`
  // is set only when editing an existing alias (so the picker highlights the
  // current binding). `pickerMode` differentiates an unmapped→add (which
  // also fires the retroactive flip) from a confirmed→edit (which only
  // upserts).
  const [pickerPosName, setPickerPosName] = React.useState<string | null>(null);
  const [pickerCurrentRecipeId, setPickerCurrentRecipeId] = React.useState<string | null>(null);
  const [pickerMode, setPickerMode] = React.useState<'add' | 'edit'>('add');

  // All aliases visible to this store: store-scoped (store_id = currentStore.id)
  // PLUS global (store_id = null). Global rows render a "global" badge and
  // hide the remove affordance per §11.
  const visibleAliases = React.useMemo(
    () => aliases.filter((a) => a.store_id === currentStore.id || a.store_id === null),
    [aliases, currentStore.id],
  );

  // Confirmed mappings, joined to recipe.
  const confirmed = React.useMemo(
    () =>
      visibleAliases
        .map((a) => ({
          pos_name: a.pos_name,
          recipe_id: a.recipe_id,
          store_id: a.store_id,
          recipe: recipes.find((r) => r.id === a.recipe_id),
        }))
        .sort((a, b) => a.pos_name.localeCompare(b.pos_name)),
    [visibleAliases, recipes],
  );

  // Spec 015 §9 — merge server fetch (canonical 30-day count) with local
  // derivation (augments with lastSeen, fills any local-only names that
  // landed after the server fetch fired). Key by lowercase-trim.
  const unmapped = React.useMemo(() => {
    const map = new Map<string, { pos_name: string; rows: number; lastSeen?: string }>();
    // Layer A — server (canonical).
    for (const row of serverUnmapped) {
      const key = (row.menu_item || '').trim().toLowerCase();
      if (!key) continue;
      map.set(key, { pos_name: row.menu_item.trim(), rows: row.count });
    }
    // Layer B — local. Augments with lastSeen / adds local-only names.
    for (const im of posImports.filter((p) => p.storeId === currentStore.id)) {
      for (const it of im.items || []) {
        if (it.recipeMapped) continue;
        const name = (it.menuItem || '').trim();
        const key = name.toLowerCase();
        if (!key) continue;
        const existing = map.get(key);
        if (existing) {
          // Server already counts the row; just attach a lastSeen.
          if (!existing.lastSeen || new Date(im.importedAt) > new Date(existing.lastSeen)) {
            existing.lastSeen = im.importedAt;
          }
        } else {
          map.set(key, { pos_name: name, rows: 1, lastSeen: im.importedAt });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.rows - a.rows);
  }, [serverUnmapped, posImports, currentStore.id]);

  // Surface 2 (unmapped → add) — upsert alias for current store, then run
  // the retroactive flip (Surface 3). Toast based on returned count.
  const handlePickForUnmapped = React.useCallback(async (posName: string, recipeId: string) => {
    try {
      await upsertPosRecipeAliases([{ posName, recipeId }]);
      const count = await applyAliasToPastImports(posName, recipeId);
      Toast.show({
        type: 'success',
        text1: 'Alias saved',
        text2: count > 0
          ? `Updated ${count} past row${count === 1 ? '' : 's'}.`
          : 'Future imports will use this mapping.',
        position: 'bottom',
      });
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: 'Mapping failed',
        text2: e?.message || 'Could not save alias',
        position: 'bottom',
      });
    } finally {
      // Re-fetch the server-side unmapped count regardless of branch — even
      // a partial success may have flipped some rows.
      triggerServerRefresh();
    }
  }, [upsertPosRecipeAliases, applyAliasToPastImports, triggerServerRefresh]);

  // Surface 2 (confirmed → edit) — UPSERT on (pos_name, store_id) collapses
  // to update; no separate RPC. No retroactive flip — editing changes
  // future imports' target, but past rows already counted on the prior
  // recipe stay attributed to it (consistent with legacy semantics).
  const handlePickForEdit = React.useCallback(async (posName: string, recipeId: string) => {
    try {
      await upsertPosRecipeAliases([{ posName, recipeId }]);
      Toast.show({
        type: 'success',
        text1: 'Alias updated',
        text2: posName,
        position: 'bottom',
      });
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: 'Update failed',
        text2: e?.message || 'Could not update alias',
        position: 'bottom',
      });
    }
  }, [upsertPosRecipeAliases]);

  const handleRemove = React.useCallback((posName: string) => {
    confirmAction(
      'Remove alias',
      `Remove alias for ${posName}? Future imports of this POS string will fall back to fuzzy matching.`,
      () => {
        removePosRecipeAlias(posName);
      },
    );
  }, [removePosRecipeAlias]);

  const ghostRowCount = unmapped.reduce((s, u) => s + u.rows, 0);

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
        <StatCard label="Ghost rows" value={String(ghostRowCount)} sub="across imports" />
      </View>

      <View style={{ flexDirection: 'row', gap: 14 }}>
        <SectionPanel title="UNMAPPED.LOG" right={`${unmapped.length}`} style={{ flex: 1 }}>
          {unmapped.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>no unmapped pos_names</Text>
          ) : (
            unmapped.slice(0, 50).map((u, i) => (
              <View
                key={u.pos_name}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 7,
                  gap: 8,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: C.border,
                  borderStyle: 'dashed',
                }}
              >
                <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                  {u.pos_name}
                </Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2, width: 38, textAlign: 'right' }}>
                  {u.rows}×
                </Text>
                <TouchableOpacity
                  testID={`mapping-cmd-unmapped-pick-${u.pos_name}`}
                  onPress={() => {
                    setPickerPosName(u.pos_name);
                    setPickerCurrentRecipeId(null);
                    setPickerMode('add');
                  }}
                  style={{
                    borderWidth: 1,
                    borderColor: C.warn,
                    borderRadius: CmdRadius.xs,
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    backgroundColor: C.warnBg,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.warn, letterSpacing: 0.4 }}>
                    MAP…
                  </Text>
                  <Text style={{ fontFamily: mono(700), fontSize: 8.5, color: C.warn, opacity: 0.7 }}>▾</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </SectionPanel>
        <SectionPanel title="ACTIVE_ALIASES.TSV" right={`${confirmed.length}`} style={{ flex: 1.4 }}>
          {confirmed.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 8 }}>
              no aliases yet — tap an unmapped row to map it, or wait for auto-matches on the next import
            </Text>
          ) : (
            confirmed.map((c, i) => {
              const isGlobal = c.store_id === null;
              return (
                <View
                  key={`${c.pos_name}-${c.store_id || 'global'}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 7,
                    gap: 8,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: C.border,
                    borderStyle: 'dashed',
                  }}
                >
                  <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {c.pos_name}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>→</Text>
                  <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {c.recipe ? c.recipe.menuItem : <Text style={{ color: C.danger }}>recipe missing ({c.recipe_id.slice(0, 6)})</Text>}
                  </Text>
                  {isGlobal ? (
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: C.info,
                        borderRadius: CmdRadius.xs,
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        backgroundColor: C.infoBg,
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.info, letterSpacing: 0.4 }}>
                        GLOBAL
                      </Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      testID={`mapping-cmd-alias-edit-${c.pos_name}`}
                      onPress={() => {
                        setPickerPosName(c.pos_name);
                        setPickerCurrentRecipeId(c.recipe_id);
                        setPickerMode('edit');
                      }}
                      style={{
                        borderWidth: 1,
                        borderColor: C.borderStrong,
                        borderRadius: CmdRadius.xs,
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        backgroundColor: 'transparent',
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg2, letterSpacing: 0.4 }}>
                        EDIT
                      </Text>
                    </TouchableOpacity>
                  )}
                  {/* Spec §11 — hide remove for global aliases (UI-only gate;
                      RLS on this table is still legacy, see spec backend §2). */}
                  {!isGlobal ? (
                    <TouchableOpacity
                      testID={`mapping-cmd-alias-remove-${c.pos_name}`}
                      onPress={() => handleRemove(c.pos_name)}
                      style={{
                        borderWidth: 1,
                        borderColor: C.danger,
                        borderRadius: CmdRadius.xs,
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        backgroundColor: 'transparent',
                      }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.danger, letterSpacing: 0.4 }}>
                        REMOVE
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })
          )}
        </SectionPanel>
      </View>

      {pickerPosName !== null ? (
        <RecipePickerModal
          visible
          onClose={() => {
            setPickerPosName(null);
            setPickerCurrentRecipeId(null);
          }}
          posName={pickerPosName}
          currentRecipeId={pickerCurrentRecipeId}
          // Spec §8 / §11 — mapping.tsx never renders "No match"; closing
          // the modal is the user's "leave it alone" path.
          allowNoMatch={false}
          onPick={(recipeId) => {
            // recipeId can be null only when allowNoMatch is true; we set
            // allowNoMatch=false above, but TS types still allow null.
            if (!recipeId) {
              setPickerPosName(null);
              setPickerCurrentRecipeId(null);
              return;
            }
            const posName = pickerPosName;
            const mode = pickerMode;
            // Close immediately so the picker feels instant; the optimistic
            // alias slice update reflects the binding before the network call
            // resolves.
            setPickerPosName(null);
            setPickerCurrentRecipeId(null);
            if (mode === 'add') {
              handlePickForUnmapped(posName, recipeId);
            } else {
              handlePickForEdit(posName, recipeId);
            }
          }}
        />
      ) : null}
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
