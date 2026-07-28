// src/screens/cmd/sections/phone/PhoneMenuItemsList.tsx — Spec 142 (chunk c).
//
// The phone Menu-items (Recipes) surface (AC-BOM1). A full-width grouped list —
// no 340px pane, no tab strips (Hard Rule 4). Row = margin pill + name /
// "N INGREDIENTS · COST $X" / price + makeable tag. Taps open the SHARED
// PhoneMenuItemDetail (AC-BOM2), the same detail the Menu-impact list opens.

import React from 'react';
import { View, Text, TextInput, FlatList, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { matchesQuery } from '../../../../i18n/matchesQuery';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { TwoLineRow, GroupCaption } from './PhoneWidgets';
import { PhoneMenuItemDetail, CapacityPill } from './PhoneMenuItemDetail';
import { recipeCapacity } from './menuCapacityFallback';
import type { Recipe } from '../../../../types';

// Margin pill — thin status wrapper (never the accent): healthy ≥60 ok, ≥40
// warn, else danger. Local to this row file per spec-142 §4.
function MarginPill({ margin }: { margin: number | null }) {
  const C = useCmdColors();
  const neutral = margin === null;
  const fg = neutral ? C.fg3 : margin >= 60 ? C.ok : margin >= 40 ? C.warn : C.danger;
  const bg = neutral ? C.panel2 : margin >= 60 ? C.okBg : margin >= 40 ? C.warnBg : C.dangerBg;
  return (
    <View style={{ paddingHorizontal: 9, paddingVertical: 2, borderRadius: CmdRadius.pill, borderWidth: 0.5, borderColor: fg, backgroundColor: bg, alignSelf: 'flex-start' }}>
      <Text style={{ fontFamily: mono(700), fontSize: 10, letterSpacing: 0.5, color: fg }}>{neutral ? '—' : `${margin}%`}</Text>
    </View>
  );
}

type ListRow =
  | { kind: 'header'; key: string; category: string }
  | { kind: 'row'; key: string; recipe: Recipe };

export const PhoneMenuItemsList: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const recipes = useStore((s) => s.recipes);
  const menuCapacity = useStore((s) => s.menuCapacity);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getRecipeCost = useStore((s) => s.getRecipeCost);

  const [query, setQuery] = React.useState('');
  const drill = usePhoneDrill<{ id: string }>();

  const displayName = React.useCallback(
    (r: Recipe) => getLocalizedName({ menuItem: r.menuItem, i18nNames: r.i18nNames }, locale),
    [locale],
  );

  const filtered = React.useMemo(() => {
    if (!query.trim()) return recipes;
    return recipes.filter((r) => matchesQuery(query, [displayName(r), r.menuItem, r.category]));
  }, [recipes, query, displayName]);

  const listData = React.useMemo<ListRow[]>(() => {
    const byCat = new Map<string, Recipe[]>();
    for (const r of filtered) {
      const cat = r.category || '—';
      const arr = byCat.get(cat);
      if (arr) arr.push(r);
      else byCat.set(cat, [r]);
    }
    const cats = Array.from(byCat.keys()).sort((a, b) => a.localeCompare(b, locale));
    const out: ListRow[] = [];
    for (const cat of cats) {
      out.push({ kind: 'header', key: `h:${cat}`, category: cat });
      const rs = byCat.get(cat)!.slice().sort((a, b) => displayName(a).localeCompare(displayName(b), locale));
      for (const r of rs) out.push({ kind: 'row', key: r.id, recipe: r });
    }
    return out;
  }, [filtered, displayName, locale]);

  const renderRecipe = (r: Recipe) => {
    const cost = getRecipeCost(r.id);
    const count = (r.ingredients || []).length + (r.prepItems || []).length;
    const margin = r.sellPrice ? Math.round((1 - cost / r.sellPrice) * 100) : null;
    const cap = menuCapacity[r.id] ?? null;
    const { makeable } = recipeCapacity(r, inventory, currentStore?.id ?? '', cap);
    return (
      <TwoLineRow
        testID={`phone-menuitem-row-${r.id}`}
        pill={<MarginPill margin={margin} />}
        name={displayName(r)}
        rightValue={<Text style={[PhoneType.tableNum, { color: C.fg }]}>{r.sellPrice ? `$${r.sellPrice.toFixed(2)}` : '—'}</Text>}
        meta={
          <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
            {count} INGREDIENTS · COST ${cost.toFixed(2)}
          </Text>
        }
        line2Right={<CapacityPill makeable={makeable} />}
        onPress={() => drill.open({ id: r.id })}
      />
    );
  };

  const listNode = (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
        <TextInput
          testID="phone-menuitem-search"
          value={query}
          onChangeText={setQuery}
          placeholder={T('section.recipes.filterPlaceholder')}
          placeholderTextColor={C.fg3}
          style={{
            height: 44,
            paddingHorizontal: 12,
            fontFamily: mono(400),
            fontSize: 13,
            color: C.fg,
            backgroundColor: C.panel2,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: CmdRadius.sm,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
      </View>
      <FlatList
        testID="phone-menuitem-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={listData}
        keyExtractor={(r) => r.key}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            {recipes.length === 0 ? T('section.recipes.noRecipes') : T('section.recipes.noMatch')}
          </Text>
        }
        renderItem={({ item: r }) => (r.kind === 'header' ? <GroupCaption>{r.category}</GroupCaption> : renderRecipe(r.recipe))}
      />
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-menuitems"
      parentCaption="MENU"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <PhoneMenuItemDetail recipeId={drill.selected.id} /> : null}
    />
  );
};
