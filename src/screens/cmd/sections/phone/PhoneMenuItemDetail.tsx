// src/screens/cmd/sections/phone/PhoneMenuItemDetail.tsx — Spec 142 (chunk c).
//
// The SHARED full-screen menu-item detail (AC-BOM2 / AC-MI3). Both the phone
// Menu-items (Recipes) list AND the phone Menu-impact list drill into THIS one
// component, so "tapping a Menu-impact row opens the same menu-item detail as
// the Menu items/BOM section" holds by construction. Reads the same recipes +
// cost getters the desktop pane reads; capacity uses the server `menuCapacity`
// value when present, the client fallback otherwise.

import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { usePaletteAction } from '../../../../lib/paletteAction';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { statusFg } from '../../../../theme/statusColors';
import { StatPanel, GroupCaption } from './PhoneWidgets';
import { recipeCapacity, recipeRawLines } from './menuCapacityFallback';
import type { ItemStatus } from '../../../../types';

// Capacity/margin pill — thin wrapper over the status tokens (never the accent):
// ×0 danger / ~N warn (<15) / ~N ok. Exported so both phone lists reuse it.
export function CapacityPill({ makeable }: { makeable: number | null }) {
  const C = useCmdColors();
  const neutral = makeable === null;
  const danger = makeable === 0;
  const warn = makeable !== null && makeable > 0 && makeable < 15;
  const fg = neutral ? C.fg3 : danger ? C.danger : warn ? C.warn : C.ok;
  const bg = neutral ? C.panel2 : danger ? C.dangerBg : warn ? C.warnBg : C.okBg;
  const label = neutral ? '—' : danger ? '×0' : `~${makeable}`;
  return (
    <View style={{ paddingHorizontal: 9, paddingVertical: 2, borderRadius: CmdRadius.pill, borderWidth: 0.5, borderColor: fg, backgroundColor: bg, alignSelf: 'flex-start' }}>
      <Text style={{ fontFamily: mono(700), fontSize: 10, letterSpacing: 0.5, color: fg, fontVariant: ['tabular-nums'] }}>{label}</Text>
    </View>
  );
}

interface Props {
  recipeId: string;
}

export const PhoneMenuItemDetail: React.FC<Props> = ({ recipeId }) => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const recipes = useStore((s) => s.recipes);
  const menuCapacity = useStore((s) => s.menuCapacity);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);
  const getRecipeCost = useStore((s) => s.getRecipeCost);
  const getRecipeFoodCostPct = useStore((s) => s.getRecipeFoodCostPct);
  const getPrepRecipe = useStore((s) => s.getPrepRecipe);

  const recipe = recipes.find((r) => r.id === recipeId);
  if (!recipe) {
    return (
      <View style={{ padding: 22 }}>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>recipe not found</Text>
      </View>
    );
  }

  const cap = menuCapacity[recipe.id] ?? null;
  const { makeable, limitedBy } = recipeCapacity(recipe, inventory, currentStore?.id ?? '', cap);
  const cost = getRecipeCost(recipe.id);
  const fcPct = getRecipeFoodCostPct(recipe.id);
  const margin = recipe.sellPrice ? Math.round((1 - cost / recipe.sellPrice) * 100) : null;
  const displayName = getLocalizedName({ menuItem: recipe.menuItem, i18nNames: recipe.i18nNames }, locale);

  // Per-line BOM availability (raw = tracked with MAKES ×N + status; prep = PREP
  // tag). The on-hand→plate-unit conversion comes from the shared
  // `recipeRawLines()` helper (aligned index-for-index with recipe.ingredients)
  // so the makeable math isn't re-derived here; the item is still resolved once
  // more for the status pill + on-hand display, which the pure helper doesn't
  // carry.
  const converted = recipeRawLines(recipe, inventory, currentStore?.id ?? '');
  const rawLines = (recipe.ingredients || []).map((ing, i) => {
    const line = converted[i];
    const item =
      inventory.find((it) => it.catalogId === ing.itemId && it.storeId === currentStore?.id) ||
      inventory.find((it) => it.id === ing.itemId);
    const makesN = line.needPerPlate > 0 ? Math.floor(line.onHand / line.needPerPlate) : null;
    const status: ItemStatus = item ? getItemStatus(item) : 'out';
    return {
      key: `raw:${ing.itemId}`,
      name: line.name,
      need: `${ing.quantity} ${ing.unit}`,
      makesN,
      onHand: item ? `${item.currentStock} ${item.unit}` : '—',
      status,
      isPrep: false,
    };
  });
  const prepLines = (recipe.prepItems || []).map((prep) => {
    const sub = getPrepRecipe(prep.prepRecipeId);
    return {
      key: `prep:${prep.prepRecipeId}`,
      name: prep.prepRecipeName || sub?.name || '—',
      need: `${prep.quantity} ${prep.unit}`,
      makesN: null as number | null,
      onHand: '—',
      status: 'ok' as ItemStatus,
      isPrep: true,
    };
  });
  const bomLines = [...rawLines, ...prepLines];

  const goOrdering = () => usePaletteAction.getState().request({ section: 'Ordering', selectedName: null });
  const editToast = () => Toast.show({ type: 'info', text1: T('common.editOnDesktop') });

  return (
    <View style={{ padding: 16, gap: 16 }}>
      {/* Hero */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <CapacityPill makeable={makeable} />
          <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]} numberOfLines={1}>
            MENU · {(recipe.category || '—').toUpperCase()}
          </Text>
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{displayName}</Text>
      </View>

      {/* Stats */}
      <StatPanel
        testID="phone-menu-statpanel"
        cells={[
          { label: 'MAKEABLE', value: makeable === null ? '—' : `${makeable}`, tone: makeable === 0 ? 'out' : 'fg' },
          { label: 'PRICE', value: recipe.sellPrice ? `$${recipe.sellPrice.toFixed(2)}` : '—', tone: 'fg' },
          { label: 'MARGIN', value: margin === null ? '—' : `${margin}%`, tone: 'fg' },
        ]}
      />

      {/* Ingredient availability */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>{limitedBy ? `LIMITED BY ${limitedBy.toUpperCase()}` : 'INGREDIENT AVAILABILITY'}</GroupCaption>
        {bomLines.length === 0 ? (
          <Text style={[PhoneType.metaMono, { color: C.fg3, paddingHorizontal: 14, paddingVertical: 12 }]}>
            {T('section.recipes.noIngredients')}
          </Text>
        ) : (
          bomLines.map((ln) => (
            <View key={ln.key} style={{ gap: 3, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[PhoneType.itemName, { color: C.fg, flex: 1 }]} numberOfLines={1}>{ln.name}</Text>
                {ln.isPrep ? (
                  <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: CmdRadius.xs, borderWidth: 0.5, borderColor: C.accent, backgroundColor: C.accentBg }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 8.5, letterSpacing: 0.5, color: C.accent }}>PREP</Text>
                  </View>
                ) : (
                  <Text style={[PhoneType.metaMono, { color: statusFg(C, ln.status) }]}>{ln.onHand}</Text>
                )}
              </View>
              <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
                NEED {ln.need} / PLATE{ln.makesN !== null ? ` · MAKES ×${ln.makesN}` : ''}
              </Text>
            </View>
          ))
        )}
      </View>

      {/* Plate costing */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, paddingHorizontal: 14, paddingVertical: 12 }}>
        <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]}>PLATE COSTING</Text>
        <Text style={[PhoneType.tableNum, { color: C.fg }]}>${cost.toFixed(2)}</Text>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]}>{fcPct.toFixed(1)}% FC</Text>
      </View>

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity
          testID="phone-menu-edit"
          onPress={editToast}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>EDIT RECIPE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="phone-menu-order-shortages"
          onPress={goOrdering}
          activeOpacity={0.85}
          accessibilityRole="button"
          style={{ flex: 1, height: 48, borderRadius: CmdRadius.sm, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 12, letterSpacing: 0.5, color: C.accentFg }}>ORDER SHORTAGES</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
