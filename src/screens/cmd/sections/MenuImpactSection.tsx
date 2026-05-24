// src/screens/cmd/sections/MenuImpactSection.tsx — Spec 060.
//
// Dedicated section under the INSIGHTS sidebar group. Sortable table
// over `useStore().menuCapacity` (computed server-side via the
// `compute_menu_capacity` RPC; see db.ts:fetchMenuCapacity). One row
// per recipe in the current brand. Columns per architect's contract
// (spec §B / "Component contracts > B. Dedicated MenuImpactSection.tsx"):
//
//   menu item name | makeable_qty | binding ingredient | low ingredient count | brand
//
// Default sort: makeable_qty ASC (most-impacted first). Header click
// toggles direction. Rows with `hasRecipe === false` (no BOM) pin to
// the bottom regardless of direction — two-key comparator.
//
// Loading/empty: storeLoading + empty slice → ListSkeleton. Recipes
// present but no capacity rows → "loading menu impact…". Recipes empty
// → "no menu items in this brand".
//
// Realtime: no new channel. The slice is refreshed by the existing
// useRealtimeSync onSync path (which calls loadFromSupabase →
// loadMenuCapacity). Same 400ms debounce.

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { useIsSuperAdmin } from '../../../hooks/useRole';
import { getLocalizedName } from '../../../i18n/localizedName';
import { ListSkeleton } from '../../../components/cmd/ListSkeleton';
import type { MenuCapacityRow } from '../../../lib/db';

type SortColumn = 'name' | 'makeable' | 'binding' | 'low' | 'brand';
type SortDir = 'asc' | 'desc';

interface DerivedRow {
  recipeId: string;
  name: string;
  brandId: string;
  brandName: string;
  capacity: MenuCapacityRow | null;
  // Display fields derived once per render.
  hasRecipe: boolean;
  makeableQty: number | null;
  bindingCatalogName: string | null;
  lowCount: number;
  hasUnitMismatch: boolean;
  truncated: boolean;
  bindingShortfall: number | null;
}

// Pure two-key comparator helper. Primary key:
//   hasRecipe ? 0 : 1   — no-BOM rows always sink to the bottom
// regardless of sort direction (per AC §B "sort order pushes them to
// the bottom regardless of direction"). Secondary key: the selected
// column with the user's direction.
//
// Exported for the jest test only; not consumed by anyone else.
export function compareRows(a: DerivedRow, b: DerivedRow, col: SortColumn, dir: SortDir, locale: string): number {
  const noBomA = a.hasRecipe ? 0 : 1;
  const noBomB = b.hasRecipe ? 0 : 1;
  if (noBomA !== noBomB) return noBomA - noBomB;

  const sign = dir === 'asc' ? 1 : -1;
  let cmp = 0;
  switch (col) {
    case 'name':
      cmp = a.name.localeCompare(b.name, locale);
      break;
    case 'makeable': {
      // Both null is impossible past the noBom pre-filter, but be safe.
      const av = a.makeableQty ?? Number.POSITIVE_INFINITY;
      const bv = b.makeableQty ?? Number.POSITIVE_INFINITY;
      cmp = av - bv;
      break;
    }
    case 'binding': {
      // Empty string sorts after any name. nulls (no constraint) → ''
      const av = a.bindingCatalogName || '';
      const bv = b.bindingCatalogName || '';
      // Push empty string to the end regardless of direction. Two-tier
      // again: primary "has-binding-name", secondary localeCompare.
      const noNameA = av ? 0 : 1;
      const noNameB = bv ? 0 : 1;
      if (noNameA !== noNameB) return noNameA - noNameB;
      cmp = av.localeCompare(bv, locale);
      break;
    }
    case 'low':
      cmp = a.lowCount - b.lowCount;
      break;
    case 'brand':
      cmp = a.brandName.localeCompare(b.brandName, locale);
      break;
  }
  return cmp * sign;
}

export default function MenuImpactSection() {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const isSuperAdmin = useIsSuperAdmin();

  const recipes = useStore((s) => s.recipes);
  const menuCapacity = useStore((s) => s.menuCapacity);
  const brand = useStore((s) => s.brand);
  const brandsList = useStore((s) => s.brandsList);
  const storeLoading = useStore((s) => s.storeLoading);

  // UI state. Default sort per AC §B: makeable_qty ascending.
  const [sortCol, setSortCol] = React.useState<SortColumn>('makeable');
  const [sortDir, setSortDir] = React.useState<SortDir>('asc');
  const [impactedOnly, setImpactedOnly] = React.useState(false);

  const brandNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const b of brandsList) map.set(b.id, b.name);
    if (brand?.id) map.set(brand.id, brand.name);
    return map;
  }, [brandsList, brand]);

  // Build the derived rows from the recipes slice — capacity may be
  // missing for individual rows if the RPC hasn't replied yet.
  const derived = React.useMemo<DerivedRow[]>(() => {
    return recipes.map((r) => {
      const cap = menuCapacity[r.id] ?? null;
      const localizedName = getLocalizedName(
        { menuItem: r.menuItem, i18nNames: r.i18nNames },
        locale,
      );
      const brandName = brandNameById.get(r.brandId) ?? '';
      return {
        recipeId: r.id,
        name: localizedName,
        brandId: r.brandId,
        brandName,
        capacity: cap,
        hasRecipe: cap ? cap.hasRecipe : true, // assume "has recipe" until RPC says otherwise
        makeableQty: cap ? cap.makeableQty : null,
        bindingCatalogName: cap ? cap.bindingCatalogName : null,
        lowCount: cap ? cap.lowIngredientCount : 0,
        hasUnitMismatch: cap ? cap.hasUnitMismatch : false,
        truncated: cap ? cap.truncated : false,
        bindingShortfall: cap ? cap.bindingShortfall : null,
      };
    });
  }, [recipes, menuCapacity, locale, brandNameById]);

  // Filter affordance: "show impacted only" hides rows where
  // makeableQty > 0 AND lowIngredientCount === 0 AND hasRecipe === true.
  const filtered = React.useMemo(() => {
    if (!impactedOnly) return derived;
    return derived.filter((r) => {
      if (!r.hasRecipe) return false; // no-BOM rows aren't "impacted", they're undefined
      if (r.makeableQty === 0) return true;
      if (r.lowCount > 0) return true;
      if (r.hasUnitMismatch || r.truncated) return true;
      return false;
    });
  }, [derived, impactedOnly]);

  const sorted = React.useMemo(() => {
    return filtered.slice().sort((a, b) => compareRows(a, b, sortCol, sortDir, locale));
  }, [filtered, sortCol, sortDir, locale]);

  // First-mount skeleton — same predicate as VendorsSection / RecipesSection.
  if (storeLoading && recipes.length === 0) {
    return <ListSkeleton rows={10} />;
  }

  const onHeaderPress = (col: SortColumn) => {
    if (col === sortCol) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0 }}>
      {/* Header */}
      <View
        style={{
          paddingHorizontal: 22,
          paddingTop: 18,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
          <Text style={[Type.h1, { color: C.fg }]}>{T('section.menuImpact.title')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
            {impactedOnly
              ? T('section.menuImpact.filteredCount', { filtered: filtered.length, total: derived.length })
              : T('section.menuImpact.totalCount', { count: derived.length })}
          </Text>
        </View>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.menuImpact.subtitle')}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={
              impactedOnly
                ? T('section.menuImpact.showAll')
                : T('section.menuImpact.showImpactedOnly')
            }
            onPress={() => setImpactedOnly((v) => !v)}
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderWidth: 1,
              borderColor: impactedOnly ? C.accent : C.border,
              backgroundColor: impactedOnly ? C.accentBg : 'transparent',
              borderRadius: CmdRadius.sm,
            }}
          >
            <Text
              style={{
                fontFamily: mono(600),
                fontSize: 10.5,
                color: impactedOnly ? C.accent : C.fg2,
                letterSpacing: 0.3,
              }}
            >
              {impactedOnly
                ? T('section.menuImpact.showAll')
                : T('section.menuImpact.showImpactedOnly')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Table */}
      {recipes.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            {T('section.menuImpact.emptyNoRecipes')}
          </Text>
        </View>
      ) : sorted.length === 0 && impactedOnly ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            {T('section.menuImpact.emptyAllFull')}
          </Text>
        </View>
      ) : Object.keys(menuCapacity).length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 22 }}>
          <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
            {T('section.menuImpact.emptyLoading')}
          </Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22 }}>
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
                alignItems: 'center',
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
                gap: 10,
                backgroundColor: C.bg,
              }}
            >
              <HeaderCell
                column="name"
                label={T('section.menuImpact.colMenuItem')}
                active={sortCol === 'name'}
                dir={sortDir}
                onPress={onHeaderPress}
                style={{ flex: 1 }}
              />
              <HeaderCell
                column="makeable"
                label={T('section.menuImpact.colMakeableQty')}
                active={sortCol === 'makeable'}
                dir={sortDir}
                onPress={onHeaderPress}
                style={{ width: 110, alignItems: 'flex-end' }}
                align="right"
              />
              <HeaderCell
                column="binding"
                label={T('section.menuImpact.colBindingIngredient')}
                active={sortCol === 'binding'}
                dir={sortDir}
                onPress={onHeaderPress}
                style={{ flex: 1.2 }}
              />
              <HeaderCell
                column="low"
                label={T('section.menuImpact.colLowCount')}
                active={sortCol === 'low'}
                dir={sortDir}
                onPress={onHeaderPress}
                style={{ width: 90, alignItems: 'flex-end' }}
                align="right"
              />
              {isSuperAdmin ? (
                <HeaderCell
                  column="brand"
                  label={T('section.menuImpact.colBrand')}
                  active={sortCol === 'brand'}
                  dir={sortDir}
                  onPress={onHeaderPress}
                  style={{ width: 140 }}
                />
              ) : null}
            </View>

            {sorted.map((r, i) => (
              <Row
                key={r.recipeId}
                row={r}
                first={i === 0}
                showBrand={isSuperAdmin}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

interface HeaderCellProps {
  column: SortColumn;
  label: string;
  active: boolean;
  dir: SortDir;
  onPress: (col: SortColumn) => void;
  style?: object;
  align?: 'left' | 'right';
}

function HeaderCell({ column, label, active, dir, onPress, style, align = 'left' }: HeaderCellProps) {
  const C = useCmdColors();
  const arrow = active ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
  return (
    <TouchableOpacity
      onPress={() => onPress(column)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={style}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 9.5,
          color: active ? C.fg : C.fg3,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          textAlign: align,
        }}
      >
        {label}{arrow}
      </Text>
    </TouchableOpacity>
  );
}

function Row({ row, first, showBrand }: { row: DerivedRow; first: boolean; showBrand: boolean }) {
  const C = useCmdColors();
  const T = useT();

  const isZero = row.makeableQty === 0;
  const isLow = (row.makeableQty ?? 0) > 0 && row.lowCount > 0;

  // Capacity cell — mirrors the badge's number formatting (prefix "~"
  // for unit mismatch, suffix "?" for truncated), with pill background
  // for zero/low states.
  const renderCapacity = () => {
    if (!row.hasRecipe) {
      return (
        <Text
          style={{
            fontFamily: mono(400),
            fontSize: 11,
            fontStyle: 'italic',
            color: C.fg3,
            textAlign: 'right',
          }}
        >
          {T('section.menuImpact.noRecipe')}
        </Text>
      );
    }
    if (row.makeableQty === null || row.makeableQty === undefined) {
      return (
        <Text
          style={{
            fontFamily: mono(500),
            fontSize: 11.5,
            color: C.fg3,
            fontVariant: ['tabular-nums'],
            textAlign: 'right',
          }}
        >
          {T('section.menuImpact.unknownCapacity')}
        </Text>
      );
    }
    const prefix = row.hasUnitMismatch ? T('section.menuImpact.unitMismatchIndicator') : '';
    const suffix = row.truncated ? T('section.menuImpact.truncatedIndicator') : '';
    const numLabel = `${prefix}${Math.floor(row.makeableQty)}${suffix}`;

    if (isZero || isLow) {
      const bg = isZero ? C.dangerBg : C.warnBg;
      const fg = isZero ? C.danger : C.warn;
      return (
        <View
          style={{
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: CmdRadius.xs,
            backgroundColor: bg,
            alignSelf: 'flex-end',
          }}
        >
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 10.5,
              letterSpacing: 0.5,
              color: fg,
              fontVariant: ['tabular-nums'],
            }}
          >
            {numLabel}
          </Text>
        </View>
      );
    }
    return (
      <Text
        style={{
          fontFamily: mono(500),
          fontSize: 11.5,
          color: C.fg,
          fontVariant: ['tabular-nums'],
          textAlign: 'right',
        }}
      >
        {numLabel}
      </Text>
    );
  };

  // Binding ingredient cell — name + optional shortfall hint.
  const renderBinding = () => {
    if (!row.hasRecipe || !row.bindingCatalogName) {
      return (
        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
          {T('section.menuImpact.limitedByNone')}
        </Text>
      );
    }
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text
          style={{ fontFamily: sans(500), fontSize: 12, color: C.fg }}
          numberOfLines={1}
        >
          {row.bindingCatalogName}
        </Text>
        {row.hasUnitMismatch ? (
          <UnitMismatchIcon T={T} />
        ) : null}
      </View>
    );
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 16,
        gap: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: C.border,
        borderStyle: 'dashed',
      }}
    >
      <Text
        style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }}
        numberOfLines={1}
      >
        {row.name}
      </Text>
      <View style={{ width: 110, alignItems: 'flex-end' }}>{renderCapacity()}</View>
      <View style={{ flex: 1.2, minWidth: 0 }}>{renderBinding()}</View>
      <Text
        style={{
          fontFamily: mono(500),
          fontSize: 11.5,
          color: row.lowCount > 0 ? C.warn : C.fg3,
          width: 90,
          textAlign: 'right',
          fontVariant: ['tabular-nums'],
        }}
      >
        {row.lowCount}
      </Text>
      {showBrand ? (
        <Text
          style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2, width: 140 }}
          numberOfLines={1}
        >
          {row.brandName}
        </Text>
      ) : null}
    </View>
  );
}

// Subtle unit-mismatch indicator with web tooltip. Same shape as the
// existing `DisabledCreatePoButton` tooltip pattern.
function UnitMismatchIcon({ T }: { T: (key: string) => string }) {
  const C = useCmdColors();
  const tooltip = T('section.menuImpact.unitMismatchTooltip');
  const tooltipProps =
    Platform.OS === 'web'
      ? ({ title: tooltip, accessibilityLabel: tooltip } as any)
      : { accessibilityLabel: tooltip };
  return (
    <View
      {...tooltipProps}
      style={{
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: C.warn,
        backgroundColor: C.warnBg,
      }}
    >
      <Text
        style={{
          fontFamily: mono(700),
          fontSize: 8.5,
          color: C.warn,
          letterSpacing: 0.4,
        }}
      >
        ~
      </Text>
    </View>
  );
}

