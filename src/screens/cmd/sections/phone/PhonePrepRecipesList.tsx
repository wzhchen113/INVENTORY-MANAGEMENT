// src/screens/cmd/sections/phone/PhonePrepRecipesList.tsx — Spec 142 (chunk c).
//
// The phone Prep-recipes surface (AC-PREP1/2). Full-width list → full-screen
// detail, no 340px pane. Row = name / "YIELD q unit · $cost/BATCH" / "$cpu/unit"
// + "IN N MENU ITEMS". Detail: YIELD / BATCH COST / COST PER UNIT stats, an
// INGREDIENTS section, a USED IN section, and honest desktop-only actions
// (EDIT RECIPE / LOG A BATCH → toast, AC-PREP2). Reuses prepRecipes + cost
// getters; no new store surface.

import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { getConversionFactor } from '../../../../utils/unitConversion';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { TwoLineRow, GroupCaption, StatPanel } from './PhoneWidgets';
import { recipeCapacity } from './menuCapacityFallback';
import type { PrepRecipe } from '../../../../types';

// ── Detail ───────────────────────────────────────────────────────────────────
function PrepDetail({ prep }: { prep: PrepRecipe }) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const recipes = useStore((s) => s.recipes);
  const menuCapacity = useStore((s) => s.menuCapacity);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getPrepRecipe = useStore((s) => s.getPrepRecipe);
  const getPrepRecipeCost = useStore((s) => s.getPrepRecipeCost);
  const getPrepRecipeCostPerUnit = useStore((s) => s.getPrepRecipeCostPerUnit);
  const getIngredientLineCost = useStore((s) => s.getIngredientLineCost);

  const cost = getPrepRecipeCost(prep.id);
  const cpu = getPrepRecipeCostPerUnit(prep.id);

  const ingredientRows = (prep.ingredients || []).map((ing, i) => {
    const isPrep = (ing.type ?? 'raw') === 'prep';
    const sub = isPrep ? getPrepRecipe(ing.itemId) : undefined;
    let lineCost = 0;
    if (isPrep && sub) {
      const scpu = getPrepRecipeCostPerUnit(sub.id);
      const factor = getConversionFactor(ing.unit, sub.yieldUnit);
      lineCost = +(scpu * (factor !== null ? ing.quantity * factor : ing.quantity)).toFixed(2);
    } else {
      lineCost = +getIngredientLineCost(ing).toFixed(2);
    }
    return { key: `${ing.itemId}:${i}`, name: ing.itemName || sub?.name || '—', qty: `${ing.quantity} ${ing.unit}`, cost: lineCost, isPrep };
  });

  const usedIn = recipes
    .filter((r) => (r.prepItems || []).some((p) => p.prepRecipeId === prep.id))
    .map((r) => {
      const cap = menuCapacity[r.id] ?? null;
      const { makeable } = recipeCapacity(r, inventory, currentStore?.id ?? '', cap);
      return { id: r.id, name: getLocalizedName({ menuItem: r.menuItem, i18nNames: r.i18nNames }, locale), sellPrice: r.sellPrice, makeable };
    });

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <Text style={[PhoneType.microCaption, { color: C.fg3 }]} numberOfLines={1}>
          PREP{prep.category ? ` · ${prep.category.toUpperCase()}` : ''}
        </Text>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>
          {getLocalizedName({ name: prep.name, i18nNames: prep.i18nNames }, locale)}
        </Text>
      </View>

      <StatPanel
        testID="phone-prep-statpanel"
        cells={[
          { label: 'YIELD', value: `${prep.yieldQuantity} ${prep.yieldUnit}`, tone: 'fg' },
          { label: 'BATCH COST', value: `$${cost.toFixed(2)}`, tone: 'fg' },
          { label: `COST/${prep.yieldUnit.toUpperCase()}`, value: `$${cpu.toFixed(2)}`, tone: 'fg' },
        ]}
      />

      {/* Ingredients */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>INGREDIENTS</GroupCaption>
        {ingredientRows.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>{T('section.prepRecipes.noIngredients')}</Text>
        ) : (
          ingredientRows.map((ln) => (
            <View key={ln.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}>
              <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{ln.name}</Text>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{ln.qty}</Text>
              <Text style={[PhoneType.tableNum, { color: C.fg }]}>${ln.cost.toFixed(2)}</Text>
            </View>
          ))
        )}
      </View>

      {/* Used in */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>USED IN {usedIn.length} MENU ITEMS</GroupCaption>
        {usedIn.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>not used in any menu item</Text>
        ) : (
          usedIn.map((u) => (
            <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}>
              <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{u.name}</Text>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{u.sellPrice ? `$${u.sellPrice.toFixed(2)}` : '—'}</Text>
              <Text style={[PhoneType.metaMono, { color: C.fg2 }]}>×{u.makeable ?? '—'}</Text>
            </View>
          ))
        )}
      </View>

      {/* Actions — desktop-only, honest toasts (AC-PREP2). */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <ActionButton testID="phone-prep-edit" label="EDIT RECIPE" onPress={() => Toast.show({ type: 'info', text1: T('common.editOnDesktop') })} />
        <ActionButton testID="phone-prep-log-batch" label="LOG A BATCH" onPress={() => Toast.show({ type: 'info', text1: T('common.availableOnDesktop') })} />
      </View>
    </View>
  );
}

function ActionButton({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const C = useCmdColors();
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────
export const PhonePrepRecipesList: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const prepRecipes = useStore((s) => s.prepRecipes);
  const recipes = useStore((s) => s.recipes);
  const getPrepRecipeCost = useStore((s) => s.getPrepRecipeCost);
  const getPrepRecipeCostPerUnit = useStore((s) => s.getPrepRecipeCostPerUnit);

  const drill = usePhoneDrill<PrepRecipe>();

  const storePreps = React.useMemo(
    () => prepRecipes
      .filter((p) => p.isCurrent !== false)
      .slice()
      .sort((a, b) =>
        getLocalizedName({ name: a.name, i18nNames: a.i18nNames }, locale)
          .localeCompare(getLocalizedName({ name: b.name, i18nNames: b.i18nNames }, locale), locale),
      ),
    [prepRecipes, locale],
  );

  const usedInCount = React.useCallback(
    (prepId: string) => recipes.filter((r) => (r.prepItems || []).some((p) => p.prepRecipeId === prepId)).length,
    [recipes],
  );

  const listNode = (
    <FlatList
      testID="phone-prep-flatlist"
      style={{ flex: 1, minHeight: 0, backgroundColor: C.bg }}
      data={storePreps}
      keyExtractor={(p) => p.id}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== 'web'}
      ListEmptyComponent={
        <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
          {T('section.prepRecipes.noPrepsHint')}
        </Text>
      }
      renderItem={({ item: p }) => {
        const cost = getPrepRecipeCost(p.id);
        const cpu = getPrepRecipeCostPerUnit(p.id);
        const n = usedInCount(p.id);
        return (
          <TwoLineRow
            testID={`phone-prep-row-${p.id}`}
            name={getLocalizedName({ name: p.name, i18nNames: p.i18nNames }, locale)}
            rightValue={<Text style={[PhoneType.tableNum, { color: C.fg }]}>${cpu.toFixed(2)}<Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>/{p.yieldUnit}</Text></Text>}
            meta={<Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>YIELD {p.yieldQuantity} {p.yieldUnit} · ${cost.toFixed(2)}/BATCH</Text>}
            line2Right={<Text style={[PhoneType.metaMono, { color: C.fg3 }]}>IN {n} MENU ITEMS</Text>}
            onPress={() => drill.open(p)}
          />
        );
      }}
    />
  );

  return (
    <PhoneDrillScaffold
      testID="phone-prep"
      parentCaption="PREP"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <PrepDetail prep={drill.selected} /> : null}
    />
  );
};
