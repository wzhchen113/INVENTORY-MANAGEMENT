// src/screens/cmd/sections/phone/PhoneMenuImpactList.tsx — Spec 142 (chunk c).
//
// The phone Menu-impact surface (AC-MI1…4). The desktop MAKEABLE / LIMITED BY /
// LOW INGR. table re-shaped into two-line card rows (Hard Rule 2): NOT a table.
// Chips ALL / IMPACTED ONLY; a KPI caption "N BLOCKED · N LIMITED · MOST-
// IMPACTED FIRST"; rows sorted capacity ascending (most-impacted first). Server
// `menuCapacity` value when available, client fallback otherwise (AC-MI2). Taps
// open the SHARED PhoneMenuItemDetail (AC-MI3).

import React from 'react';
import { View, Text, FlatList, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { TwoLineRow, ChipRow, type Chip } from './PhoneWidgets';
import { PhoneMenuItemDetail, CapacityPill } from './PhoneMenuItemDetail';
import { recipeCapacity } from './menuCapacityFallback';
import type { Recipe } from '../../../../types';

interface ImpactRow {
  id: string;
  recipe: Recipe;
  name: string;
  makeable: number | null;
  limitedBy: string | null;
  lowCount: number;
}

export const PhoneMenuImpactList: React.FC = () => {
  const C = useCmdColors();
  const locale = useLocale();
  const recipes = useStore((s) => s.recipes);
  const menuCapacity = useStore((s) => s.menuCapacity);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);

  const [chip, setChip] = React.useState<'all' | 'impacted'>('all');
  const drill = usePhoneDrill<{ id: string }>();

  const rows = React.useMemo<ImpactRow[]>(() => {
    const storeId = currentStore?.id ?? '';
    const derived = recipes.map((r) => {
      const cap = menuCapacity[r.id] ?? null;
      const { makeable, limitedBy } = recipeCapacity(r, inventory, storeId, cap);
      return {
        id: r.id,
        recipe: r,
        name: getLocalizedName({ menuItem: r.menuItem, i18nNames: r.i18nNames }, locale),
        makeable,
        limitedBy,
        lowCount: cap?.lowIngredientCount ?? 0,
      };
    });
    // Sort capacity ascending — most-impacted first (null sinks to the bottom).
    return derived.sort((a, b) => {
      const av = a.makeable ?? Number.POSITIVE_INFINITY;
      const bv = b.makeable ?? Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      return a.name.localeCompare(b.name, locale);
    });
  }, [recipes, menuCapacity, inventory, currentStore?.id, locale]);

  const isImpacted = (r: ImpactRow) => r.makeable === 0 || r.lowCount > 0 || (r.makeable !== null && r.makeable < 15);
  const impactedRows = React.useMemo(() => rows.filter(isImpacted), [rows]);
  const visible = chip === 'impacted' ? impactedRows : rows;

  const blocked = rows.filter((r) => r.makeable === 0).length;
  const limited = rows.filter((r) => r.makeable !== null && r.makeable > 0 && r.makeable < 15).length;

  const chips: Chip[] = [
    { key: 'all', label: 'ALL', count: rows.length },
    { key: 'impacted', label: 'IMPACTED ONLY', count: impactedRows.length },
  ];

  const listNode = (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
        <Text style={[PhoneType.caption, { color: C.fg3 }]}>
          {blocked} BLOCKED · {limited} LIMITED · MOST-IMPACTED FIRST
        </Text>
      </View>
      <ChipRow chips={chips} activeKey={chip} onSelect={(k) => setChip(k as 'all' | 'impacted')} testID="phone-menuimpact-chips" />
      <FlatList
        testID="phone-menuimpact-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={visible}
        keyExtractor={(r) => r.id}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            no menu items
          </Text>
        }
        renderItem={({ item: r }) => (
          <TwoLineRow
            testID={`phone-menuimpact-row-${r.id}`}
            pill={<CapacityPill makeable={r.makeable} />}
            name={r.name}
            meta={
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                {r.limitedBy ? `LIMITED BY ${r.limitedBy.toUpperCase()}` : '—'}
              </Text>
            }
            line2Right={
              r.lowCount > 0 ? (
                <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: CmdRadius.xs, borderWidth: 0.5, borderColor: C.warn, backgroundColor: C.warnBg }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 8.5, letterSpacing: 0.4, color: C.warn }}>{r.lowCount} LOW</Text>
                </View>
              ) : undefined
            }
            onPress={() => drill.open({ id: r.id })}
          />
        )}
      />
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-menuimpact"
      parentCaption="MENU"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <PhoneMenuItemDetail recipeId={drill.selected.id} /> : null}
    />
  );
};
