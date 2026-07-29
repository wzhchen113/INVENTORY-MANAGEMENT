// src/screens/cmd/sections/phone/PhonePOSImports.tsx — Spec 147.
//
// Phone tier of the POS imports screen (design handoff README §7-17 — "POS
// imports (+ UPLOAD CSV)"). The desktop TabStrip + import-history table + alias
// mapping UI becomes a full-width import list → full-screen detail. Row =
// state pill + filename + matched/total value; meta = when · rows · matched.
// Tap opens the detail (TOTAL / MATCHED / UNMAPPED stats + the unmatched-item
// list). A 48px "+ UPLOAD CSV" primary surfaces an honest toast — the CSV
// column-mapping flow and the alias-mapping UI are desktop-only (per the
// handoff's "desktop-only edit actions surface honest toasts" rule).
//
// PRESENTATIONAL / direct-store — reads the same posImports / currentStore /
// recipes slices the desktop section reads (like PhoneOrdering / PhoneVendors);
// no re-derived math beyond the same matched/total tallies the desktop row uses.
//
// Hard Rules honored: full filenames (flex:1, ellipsize past the full width),
// no table, one vertical scroll, every tappable ≥44×44, state pills use the
// ok/low/out semantic tokens — never the accent.

import React from 'react';
import { View, Text, TouchableOpacity, FlatList, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { relativeTime } from '../../../../utils/relativeTime';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { StatPanel, GroupCaption, TwoLineRow } from './PhoneWidgets';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import type { POSImport } from '../../../../types';

// Tallies for one import — matches the desktop row's status derivation.
function tally(im: POSImport): { total: number; matched: number; errors: number; status: 'ok' | 'low' | 'out' } {
  const total = im.items?.length || 0;
  const matched = (im.items || []).filter((it) => it.recipeMapped).length;
  const errors = total - matched;
  const status: 'ok' | 'low' | 'out' = total > 0 && matched === 0 ? 'out' : errors > 0 ? 'low' : 'ok';
  return { total, matched, errors, status };
}

// ── Detail ───────────────────────────────────────────────────────────────────
function ImportDetail({ im }: { im: POSImport }) {
  const C = useCmdColors();
  const T = useT();
  const { total, matched, errors, status } = tally(im);
  const unmatched = (im.items || []).filter((it) => !it.recipeMapped);

  const statusLabel =
    status === 'ok'
      ? T('section.posImports.phone.stateSuccess')
      : status === 'low'
        ? T('section.posImports.phone.statePartial')
        : T('section.posImports.phone.stateFailed');

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Text style={[PhoneType.microCaption, { color: C.fg3 }]} numberOfLines={1}>
          {T('section.posImports.phone.detailCaption', { date: im.date || '—', state: statusLabel.toUpperCase() })}
        </Text>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]} numberOfLines={2}>{im.filename}</Text>
      </View>

      <StatPanel
        testID="phone-posimport-statpanel"
        cells={[
          { label: T('section.posImports.phone.statTotal'), value: `${total}`, tone: 'fg' },
          { label: T('section.posImports.phone.statMatched'), value: `${matched}`, tone: matched > 0 ? 'ok' : 'fg' },
          { label: T('section.posImports.phone.statUnmapped'), value: `${errors}`, tone: errors > 0 ? 'low' : 'fg' },
        ]}
      />

      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>{T('section.posImports.phone.unmatchedGroup')}</GroupCaption>
        {unmatched.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>
            {T('section.posImports.phone.allMatched')}
          </Text>
        ) : (
          unmatched.map((it, i) => (
            <View
              key={`${it.menuItem}-${i}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}
            >
              <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{it.menuItem}</Text>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>
                {T('section.posImports.phone.soldQty', { qty: it.qtySold })}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export const PhonePOSImports: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const posImports = useStore((s) => s.posImports);
  const currentStore = useStore((s) => s.currentStore);
  const drill = usePhoneDrill<POSImport>();

  const imports = React.useMemo(
    () => posImports.filter((p) => p.storeId === currentStore.id).slice().reverse(),
    [posImports, currentStore.id],
  );

  // The CSV column-mapping flow and the alias mapping UI are desktop-only —
  // surface an honest toast rather than a fake form (handoff rule).
  const onUpload = () =>
    Toast.show({ type: 'info', text1: T('common.editOnDesktop'), text2: T('section.posImports.phone.uploadToast') });

  const header = (
    <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, gap: 4 }}>
      <Text style={[PhoneType.screenTitle, { color: C.fg }]}>{T('section.posImports.title')}</Text>
      <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
        {T('section.posImports.phone.subtitle', { count: imports.length })}
      </Text>
    </View>
  );

  const listNode = (
    <View style={{ flex: 1, minHeight: 0 }}>
      <FlatList
        testID="phone-posimports-flatlist"
        style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
        contentContainerStyle={{ paddingBottom: 88 }}
        data={imports}
        keyExtractor={(im) => im.id}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListHeaderComponent={
          <>
            {header}
            {imports.length > 0 ? <GroupCaption>{T('section.posImports.phone.importsGroup')}</GroupCaption> : null}
          </>
        }
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            {T('section.posImports.phone.empty', { store: currentStore.name || T('chrome.store') })}
          </Text>
        }
        renderItem={({ item: im }) => {
          const { total, matched, status } = tally(im);
          return (
            <TwoLineRow
              testID={`phone-posimport-row-${im.id}`}
              pill={<StatusPill status={status} label={(status === 'ok' ? T('section.posImports.phone.stateSuccess') : status === 'low' ? T('section.posImports.phone.statePartial') : T('section.posImports.phone.stateFailed')).toUpperCase()} />}
              name={im.filename}
              rightValue={<Text style={[PhoneType.tableNum, { color: status === 'out' ? C.danger : matched < total ? C.warn : C.fg }]}>{matched}/{total}</Text>}
              meta={
                <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                  {T('section.posImports.phone.rowMeta', {
                    when: relativeTime(im.importedAt) || '—',
                    rows: total,
                    matched,
                  })}
                </Text>
              }
              onPress={() => drill.open(im)}
            />
          );
        }}
      />
      {/* 48px thumb-reachable primary. Absolute so it floats above the list. */}
      <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
        <TouchableOpacity
          testID="phone-posimport-upload"
          onPress={onUpload}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>
            {T('section.posImports.phone.upload')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-posimports"
      parentCaption={T('section.posImports.phone.parentCaption')}
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <ImportDetail im={drill.selected} /> : null}
    />
  );
};

export default PhonePOSImports;
