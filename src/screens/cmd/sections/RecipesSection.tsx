import React from 'react';
import { View, Text, ScrollView, SectionList, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { useRole } from '../../../hooks/useRole';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';
import { RecipeFormDrawer } from '../../../components/cmd/RecipeFormDrawer';
import { FilterInput } from '../../../components/cmd/FilterInput';
import { ListSkeleton } from '../../../components/cmd/ListSkeleton';
import { MenuCapacityBadge } from '../../../components/cmd/MenuCapacityBadge';
import RecipeCategoriesSection from './RecipeCategoriesSection';
import type { Tab } from '../../../components/cmd/TabStrip';
import { confirmAction } from '../../../utils/confirmAction';
import { getConversionFactor } from '../../../utils/unitConversion';
import { parseFilter } from '../../../utils/filterParser';
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { getLocalizedName } from '../../../i18n/localizedName';
import { matchesQuery } from '../../../i18n/matchesQuery';
import { toCSV, downloadCSV } from '../../../utils';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Food-cost target ratio (0.30 ⇔ the 70% target margin shown in this view).
// Used by the Target FC stat card and the CSV export.
const TARGET_FOOD_COST_PCT = 0.3;

// CSV export columns — one row per BOM line, menu-item columns repeated.
const EXPORT_COLUMNS = [
  'recipe_id', 'menu_item', 'category', 'sell_price', 'plate_cost',
  'food_cost_pct', 'margin_pct', 'target_fc', 'line_kind', 'ingredient',
  'quantity', 'unit', 'line_cost', 'pct_of_plate',
];

// Spec 048 / code-reviewer SF1 — single source for the TabStrip tabs array.
// Used by both the `categories.tsx` branch (no selection required), the
// `!sel` empty-selection branch, and the `sel`-present branch. Adding a new
// tab requires one edit, not three. Typed as `Tab[]` (not `as const`) to
// match TabStrip's mutable `Tab[]` prop signature.
const RECIPE_TABS: Tab[] = [
  { id: 'recipe.tsx',     label: 'recipe.tsx' },
  { id: 'method.tsx',     label: 'method.tsx' },
  { id: 'allergens.tsx',  label: 'allergens.tsx' },
  { id: 'sales.tsx',      label: 'sales.tsx' },
  { id: 'categories.tsx', label: 'categories.tsx' },
];

// Pattern B — list+detail. Reads useStore.recipes + getRecipeCost +
// getRecipeFoodCostPct. Detail shows the ingredient table with cost
// breakdown. Staff sees view-only without the cost columns.
export default function RecipesSection() {
  const C = useCmdColors();
  const T = useT();
  const role = useRole();
  const locale = useLocale();
  const recipes = useStore((s) => s.recipes);
  const recipeCategoriesSlice = useStore((s) => s.recipeCategories);
  const inventory = useStore((s) => s.inventory);
  const prepRecipes = useStore((s) => s.prepRecipes);
  const currentStore = useStore((s) => s.currentStore);
  const getRecipeCost = useStore((s) => s.getRecipeCost);
  const getRecipeFoodCostPct = useStore((s) => s.getRecipeFoodCostPct);
  const getIngredientLineCost = useStore((s) => s.getIngredientLineCost);
  const getPrepRecipe = useStore((s) => s.getPrepRecipe);
  const getPrepRecipeCostPerUnit = useStore((s) => s.getPrepRecipeCostPerUnit);
  const deleteRecipe = useStore((s) => s.deleteRecipe);
  // Spec 055 — first-mount skeleton when storeLoading is true and the
  // recipes slice is still empty.
  const storeLoading = useStore((s) => s.storeLoading);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('recipe.tsx');
  const [drawerMode, setDrawerMode] = React.useState<null | 'new' | 'edit' | 'duplicate'>(null);
  const [filterText, setFilterText] = React.useState('');

  // Recipes are brand-level after the catalog refactor — every store sees
  // the same set. (Previously this filtered by storeId; that's now the
  // brand id, and the comparison always failed for non-Towson stores.)
  const storeRecipes = recipes;

  // Same `key:value` syntax as the inventory filter — `cat:appetizer chicken`
  // narrows by category and substring-matches menuItem. status / vendor are
  // accepted but no-op (don't apply to recipes), so users can paste a query
  // copied from the inventory filter without errors.
  //
  // Spec 040 P3 / Q4 — bare-token text matches the localized menuItem AND
  // the English canonical via matchesQuery (diacritic + case folding).
  // Sort by current-locale label via localeCompare.
  const filteredRecipes = React.useMemo(() => {
    const base = !filterText.trim()
      ? storeRecipes
      : (() => {
          const parsed = parseFilter(filterText);
          return storeRecipes.filter((r) => {
            for (const { key, value } of parsed.filters) {
              if (key === 'category' && (r.category || '').toLowerCase() !== value) return false;
            }
            if (parsed.text.length > 0) {
              const localized = getLocalizedName(
                { menuItem: r.menuItem, i18nNames: r.i18nNames },
                locale,
              );
              if (!matchesQuery(parsed.text.join(' '), [localized, r.menuItem])) return false;
            }
            return true;
          });
        })();
    return [...base].sort((a, b) =>
      getLocalizedName({ menuItem: a.menuItem, i18nNames: a.i18nNames }, locale)
        .localeCompare(
          getLocalizedName({ menuItem: b.menuItem, i18nNames: b.i18nNames }, locale),
          locale,
        ),
    );
  }, [storeRecipes, filterText, locale]);

  // Group the filtered list into category sections for the SectionList. Items
  // stay name-sorted (filteredRecipes already is); section headers sort A–Z by
  // localized category name.
  const recipeSections = React.useMemo(() => {
    const groups = new Map<string, typeof filteredRecipes>();
    for (const r of filteredRecipes) {
      const cat = r.category || '—';
      const bucket = groups.get(cat);
      if (bucket) bucket.push(r);
      else groups.set(cat, [r]);
    }
    return [...groups.entries()]
      .map(([cat, data]) => {
        const catEntry = recipeCategoriesSlice.find((c) => c.name === cat);
        const title = catEntry
          ? getLocalizedName({ name: catEntry.name, i18nNames: catEntry.i18nNames }, locale)
          : cat;
        return { key: cat, title, data };
      })
      .sort((a, b) => a.title.localeCompare(b.title, locale));
  }, [filteredRecipes, recipeCategoriesSlice, locale]);

  React.useEffect(() => {
    if (selectedId && filteredRecipes.find((r) => r.id === selectedId)) return;
    setSelectedId(filteredRecipes[0]?.id || null);
  }, [filteredRecipes, selectedId]);

  const sel = storeRecipes.find((r) => r.id === selectedId);
  const selCost = sel ? getRecipeCost(sel.id) : 0;
  const selMargin = sel && sel.sellPrice ? Math.round((1 - selCost / sel.sellPrice) * 100) : null;
  const selFoodCostPct = sel ? getRecipeFoodCostPct(sel.id) : 0;
  const selTargetFc = sel?.sellPrice ? sel.sellPrice * TARGET_FOOD_COST_PCT : null;

  // Shared BOM line-cost builder (raw ingredients + prep recipes), reused by
  // the detail table and the CSV export. Prep cost mirrors useStore.getRecipeCost:
  // cost-per-unit × (ing.unit → yieldUnit converted) quantity. `pct` is each
  // line's share of the recipe's plate cost.
  const lineRowsFor = React.useCallback(
    (rec: (typeof recipes)[number], recCost: number) => {
      const rawRows = (rec.ingredients || []).map((ing) => {
        // ing.itemId is a catalog id; resolve to the current store's
        // inventory_items row for the name. Fall back to legacy id match.
        const item =
          inventory.find((i) => i.catalogId === ing.itemId && i.storeId === currentStore.id) ||
          inventory.find((i) => i.id === ing.itemId);
        const lineCost = getIngredientLineCost(ing);
        const pct = recCost > 0 ? Math.round((lineCost / recCost) * 100) : 0;
        return { id: ing.itemId, name: ing.itemName || item?.name || '—', qty: ing.quantity, unit: ing.unit, cost: lineCost, pct, kind: 'raw' as const };
      });
      const prepRows = (rec.prepItems || []).map((prep) => {
        const subRecipe = getPrepRecipe(prep.prepRecipeId);
        const cpu = subRecipe ? getPrepRecipeCostPerUnit(subRecipe.id) : 0;
        const factor = subRecipe ? getConversionFactor(prep.unit, subRecipe.yieldUnit) : null;
        const convertedQty = factor !== null ? prep.quantity * factor : prep.quantity;
        const lineCost = +(cpu * convertedQty).toFixed(2);
        const pct = recCost > 0 ? Math.round((lineCost / recCost) * 100) : 0;
        return { id: prep.prepRecipeId, name: prep.prepRecipeName || subRecipe?.name || '—', qty: prep.quantity, unit: prep.unit, cost: lineCost, pct, kind: 'prep' as const };
      });
      return [...rawRows, ...prepRows];
    },
    [inventory, currentStore.id, prepRecipes, getIngredientLineCost, getPrepRecipe, getPrepRecipeCostPerUnit],
  );

  const ingredientRows = React.useMemo(
    () => (sel ? lineRowsFor(sel, selCost) : []),
    [sel, selCost, lineRowsFor],
  );

  // CSV export — one row per BOM line (raw or prep), with the menu-item columns
  // repeated. Scope = the current filtered list. Web download via src/utils.
  const onExportCsv = React.useCallback(() => {
    if (filteredRecipes.length === 0) {
      Toast.show({ type: 'error', text1: T('section.recipes.exportEmptyToast') });
      return;
    }
    const data: Record<string, any>[] = [];
    for (const r of filteredRecipes) {
      const cost = getRecipeCost(r.id);
      const base = {
        recipe_id: shortId(r.id),
        menu_item: r.menuItem,
        category: r.category,
        sell_price: r.sellPrice ? r.sellPrice.toFixed(2) : '',
        plate_cost: cost.toFixed(2),
        food_cost_pct: r.sellPrice ? getRecipeFoodCostPct(r.id).toFixed(1) : '',
        margin_pct: r.sellPrice ? Math.round((1 - cost / r.sellPrice) * 100) : '',
        target_fc: r.sellPrice ? (r.sellPrice * TARGET_FOOD_COST_PCT).toFixed(2) : '',
      };
      const lines = lineRowsFor(r, cost);
      if (lines.length === 0) {
        data.push({ ...base, line_kind: '', ingredient: '', quantity: '', unit: '', line_cost: '', pct_of_plate: '' });
      } else {
        for (const ln of lines) {
          data.push({ ...base, line_kind: ln.kind, ingredient: ln.name, quantity: ln.qty, unit: ln.unit, line_cost: ln.cost.toFixed(2), pct_of_plate: ln.pct });
        }
      }
    }
    const slug = (currentStore.name || 'store').toLowerCase().replace(/\s+/g, '-');
    downloadCSV(`menu-bom_${slug}_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(data, EXPORT_COLUMNS));
    Toast.show({ type: 'success', text1: T('section.recipes.exportedToast'), text2: `${data.length} rows` });
  }, [filteredRecipes, getRecipeCost, getRecipeFoodCostPct, lineRowsFor, currentStore.name, T]);

  // Food-cost ratio coloring — lower is better (ingredient cost as a share
  // of menu price). ≤30% is a healthy plate; >50% lands in the red.
  const foodCostColor = (p: number | null): string =>
    p == null ? C.fg2
    : p <= 30 ? C.ok
    : p <= 50 ? C.warn
    : C.danger;

  // Spec 055 first-mount skeleton — only fires on the initial load when
  // the recipes slice is still empty. After the first fetch resolves,
  // subsequent re-mounts skip this branch.
  if (storeLoading && recipes.length === 0) {
    return <ListSkeleton rows={8} />;
  }

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 340,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
          minHeight: 0,
        }}
      >
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 14,
            paddingBottom: 10,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={[Type.h2, { color: C.fg }]}>{T('section.recipes.listTitle')}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                {filterText.trim()
                  ? `${filteredRecipes.length} / ${storeRecipes.length}`
                  : T('section.recipes.totalCount', { count: storeRecipes.length })}
              </Text>
            </View>
            {role === 'admin' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <TouchableOpacity
                  onPress={onExportCsv}
                  style={{ paddingVertical: 3, paddingHorizontal: 7, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
                  accessibilityRole="button"
                  accessibilityLabel={T('section.recipes.exportAria')}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg2 }}>{T('section.recipes.exportCsv')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setDrawerMode('new')}
                  style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                  accessibilityRole="button"
                  accessibilityLabel={T('section.recipes.newAria')}
                >
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>{T('section.recipes.newButton')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
          <FilterInput
            value={filterText}
            onChangeText={setFilterText}
            placeholder={T('section.recipes.filterPlaceholder')}
          />
        </View>
        <SectionList
          style={{ flex: 1, minHeight: 0 }}
          sections={recipeSections}
          keyExtractor={(r) => r.id}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {filterText.trim()
                ? T('section.recipes.noMatch')
                : T('section.recipes.noRecipesForStore', { storeName: currentStore.name || T('chrome.store') })}
            </Text>
          }
          renderSectionHeader={({ section }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 16,
                paddingTop: 11,
                paddingBottom: 5,
                backgroundColor: C.panel,
                borderBottomWidth: 1,
                borderBottomColor: C.border,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.fg3, letterSpacing: 0.8 }}>
                {section.title.toUpperCase()}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>{section.data.length}</Text>
            </View>
          )}
          renderItem={({ item: r }) => {
            const isSel = r.id === selectedId;
            const cost = getRecipeCost(r.id);
            const foodCostPct = r.sellPrice ? Math.round((cost / r.sellPrice) * 100) : null;
            const localizedName = getLocalizedName(
              { menuItem: r.menuItem, i18nNames: r.i18nNames },
              locale,
            );
            const catEntry = recipeCategoriesSlice.find((c) => c.name === r.category);
            const localizedCategory = catEntry
              ? getLocalizedName({ name: catEntry.name, i18nNames: catEntry.i18nNames }, locale)
              : r.category;
            return (
              <TouchableOpacity
                onPress={() => setSelectedId(r.id)}
                activeOpacity={0.85}
                style={{
                  paddingHorizontal: 16 - (isSel ? 2 : 0),
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: C.border,
                  borderLeftWidth: isSel ? 2 : 0,
                  borderLeftColor: C.accent,
                  backgroundColor: isSel ? C.accentBg : 'transparent',
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {localizedName}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{shortId(r.id)}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {localizedCategory}
                  </Text>
                  <View style={{ flex: 1 }} />
                  {role === 'admin' ? (
                    <>
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg, fontVariant: ['tabular-nums'] }}>
                        ${cost.toFixed(2)}
                      </Text>
                      {foodCostPct != null ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: foodCostColor(foodCostPct), fontVariant: ['tabular-nums'] }}>
                          {foodCostPct}%
                        </Text>
                      ) : (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>{T('section.recipes.sub')}</Text>
                      )}
                    </>
                  ) : null}
                </View>
                {/* Spec 060 — per-recipe capacity badge. Renders nothing
                    while the menuCapacity slice is loading; flips to a
                    pill (red at 0, amber when a touched ingredient is
                    low) or neutral text once the RPC resolves. */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <MenuCapacityBadge recipeId={r.id} />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {/* Spec 048 — `categories.tsx` is NOT recipe-scoped, so render it
            even when no recipe is selected. Other tabs (sales/method/
            allergens/recipe) still require a selection and fall through
            to the "select a recipe" message when `sel` is null. */}
        {tabId === 'categories.tsx' ? (
          <>
            <TabStrip
              tabs={RECIPE_TABS}
              activeId={tabId}
              onChange={setTabId}
            />
            <RecipeCategoriesSection />
          </>
        ) : !sel ? (
          // Spec 048 / code-reviewer SF2 — render the TabStrip in the
          // empty-selection state too, so a user with no recipe selected
          // (filter to zero, brand with no recipes) can still navigate to
          // the `categories.tsx` tab. No rightSlot here — the duplicate /
          // delete / edit actions only make sense when a recipe is selected.
          <>
            <TabStrip
              tabs={RECIPE_TABS}
              activeId={tabId}
              onChange={setTabId}
            />
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                {storeRecipes.length === 0 ? T('section.recipes.noRecipes').toLowerCase() : T('section.recipes.selectRecipe')}
              </Text>
            </View>
          </>
        ) : (
          <>
            <TabStrip
              tabs={RECIPE_TABS}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                role === 'admin' ? (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => setDrawerMode('duplicate')}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.recipes.duplicate')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        confirmAction(
                          T('section.recipes.deleteRecipeConfirm', { name: sel.menuItem }),
                          T('section.recipes.deleteRecipeBody'),
                          () => {
                            deleteRecipe(sel.id);
                            setSelectedId(null);
                            Toast.show({ type: 'success', text1: T('section.recipes.deletedToast'), text2: sel.menuItem });
                          },
                          'Delete',
                        );
                      }}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>{T('section.recipes.delete')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setDrawerMode('edit')}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>{T('section.recipes.edit')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : null
              }
            />
            {tabId === 'sales.tsx' ? (
              <RecipeSalesTab recipeId={sel.id} recipeName={sel.menuItem} />
            ) : tabId === 'method.tsx' ? (
              <RecipeMethodPlaceholder recipeName={sel.menuItem} />
            ) : tabId === 'allergens.tsx' ? (
              <RecipeAllergensPlaceholder recipeName={sel.menuItem} />
            ) : (
            <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="ok" label={T('section.recipes.active')} />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    · {sel.category}
                  </Text>
                </View>
                <Text style={[Type.display, { color: C.fg }]}>
                  {getLocalizedName({ menuItem: sel.menuItem, i18nNames: sel.i18nNames }, locale)}
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {(sel.prepItems || []).length
                    ? T('section.recipes.ingredientsPlusPrep', { count: (sel.ingredients || []).length, prep: (sel.prepItems || []).length })
                    : T('section.recipes.ingredientsCount', { count: (sel.ingredients || []).length })}
                </Text>
              </View>

              {role === 'admin' ? (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard
                    label={T('section.recipes.plateCost')}
                    value={`$${selCost.toFixed(2)}`}
                    sub={
                      (sel.prepItems || []).length
                        ? T('section.recipes.ingredientsPlusPrep', { count: (sel.ingredients || []).length, prep: (sel.prepItems || []).length })
                        : T('section.recipes.ingredientsCount', { count: (sel.ingredients || []).length })
                    }
                  />
                  <StatCard label={T('section.recipes.menuPrice')} value={sel.sellPrice ? `$${sel.sellPrice.toFixed(2)}` : '—'} sub={sel.category.toLowerCase()} />
                  <StatCard
                    label={T('section.recipes.margin')}
                    value={selMargin != null ? `${selMargin}%` : '—'}
                    sub={selMargin != null ? T('section.recipes.vsTarget') : T('section.recipes.subRecipe')}
                  />
                  <StatCard label={T('section.recipes.foodCostPct')} value={`${selFoodCostPct.toFixed(1)}%`} sub={T('section.recipes.costSubtitle')} />
                  <StatCard
                    label={T('section.recipes.targetFc')}
                    value={selTargetFc != null ? `$${selTargetFc.toFixed(2)}` : '—'}
                    sub={T('section.recipes.targetFcSub', { pct: Math.round(TARGET_FOOD_COST_PCT * 100) })}
                  />
                </View>
              ) : null}

              {/* Ingredient table + properties */}
              <View style={{ flexDirection: 'row', gap: 14 }}>
                <View
                  style={{
                    flex: 1.4,
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.lg,
                    borderWidth: 1,
                    borderColor: C.border,
                    overflow: 'hidden',
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
                    <SectionCaption tone="fg3" size={10.5}>ingredients.tsv</SectionCaption>
                    {role === 'admin' ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                        {T('section.recipes.lineSummary', { count: ingredientRows.length, cost: selCost.toFixed(2) })}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 40 }}>{T('section.recipes.kindCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60 }}>{T('section.recipes.idCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.recipes.nameCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.recipes.qtyCol')}</Text>
                    {role === 'admin' ? (
                      <>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.recipes.costCol')}</Text>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 50, textAlign: 'right' }}>{T('section.recipes.pctCol')}</Text>
                      </>
                    ) : null}
                  </View>
                  {ingredientRows.length === 0 ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                      {T('section.recipes.noIngredients')}
                    </Text>
                  ) : (
                    ingredientRows.map((row, i) => (
                      <View
                        key={`${row.id}:${i}`}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingVertical: 8,
                          paddingHorizontal: 14,
                          gap: 10,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: C.border,
                          borderStyle: 'dashed',
                        }}
                      >
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: row.kind === 'prep' ? C.accent : C.fg3, width: 40, letterSpacing: 0.5 }}>
                          {row.kind === 'prep' ? T('section.recipes.prep') : T('section.recipes.raw')}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 60 }}>{shortId(row.id)}</Text>
                        <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>
                          {row.name}
                        </Text>
                        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                          {row.qty} {row.unit}
                        </Text>
                        {role === 'admin' ? (
                          <>
                            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                              ${row.cost.toFixed(2)}
                            </Text>
                            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 50, textAlign: 'right' }}>
                              {row.pct}%
                            </Text>
                          </>
                        ) : null}
                      </View>
                    ))
                  )}
                </View>
                <View
                  style={{
                    flex: 1,
                    backgroundColor: C.panel,
                    borderRadius: CmdRadius.lg,
                    borderWidth: 1,
                    borderColor: C.border,
                    padding: 14,
                    gap: 6,
                  }}
                >
                  <SectionCaption tone="fg3" size={10.5}>properties.json</SectionCaption>
                  <PropertiesJson
                    entries={[
                      { key: 'menu',        value: `"${sel.category}"` },
                      { key: 'station',     value: '"line 1"' },
                      { key: 'ingredients', value: String((sel.ingredients || []).length) },
                      { key: 'prep_items',  value: String((sel.prepItems || []).length) },
                      ...(role === 'admin'
                        ? [
                            { key: 'plate_cost',    value: `$${selCost.toFixed(2)}` },
                            { key: 'menu_price',    value: sel.sellPrice ? `$${sel.sellPrice.toFixed(2)}` : '"sub"' },
                            { key: 'target_margin', value: '70%' },
                          ]
                        : [{ key: 'plate_cost', value: T('common.adminOnly') }]),
                    ]}
                  />
                </View>
              </View>
            </ScrollView>
            )}
          </>
        )}
      </View>

      <RecipeFormDrawer
        visible={drawerMode !== null}
        mode={drawerMode || 'new'}
        recipe={drawerMode === 'edit' || drawerMode === 'duplicate' ? sel : undefined}
        onClose={() => setDrawerMode(null)}
      />
    </>
  );
}

// ─── sales.tsx — POS-driven units / revenue / margin ─────────────────
function RecipeSalesTab({ recipeId, recipeName }: { recipeId: string; recipeName: string }) {
  const C = useCmdColors();
  const T = useT();
  const posImports = useStore((s) => s.posImports);
  const recipes = useStore((s) => s.recipes);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const recipe = recipes.find((r) => r.id === recipeId);

  // Aggregate sales for this recipe across pos_imports.
  const salesRows = React.useMemo(() => {
    const rows: { date: string; importId: string; qty: number; revenue: number }[] = [];
    for (const im of posImports.filter((p) => p.storeId === currentStore.id)) {
      let qty = 0, rev = 0;
      for (const it of im.items || []) {
        if (it.recipeId === recipeId) {
          qty += it.qtySold || 0;
          rev += it.revenue || 0;
        }
      }
      if (qty > 0) rows.push({ date: im.importedAt.slice(0, 10), importId: im.id, qty, revenue: rev });
    }
    return rows.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [posImports, recipeId, currentStore.id]);

  const totalUnits = salesRows.reduce((s, r) => s + r.qty, 0);
  const totalRevenue = salesRows.reduce((s, r) => s + r.revenue, 0);

  // Recipe cost from BOM × current cost_per_unit. This is an inline copy of the
  // getIngredientLineCost SHORT-CIRCUIT path (qty in the item's counted unit ×
  // cost). Spec 104 — `costPerUnit` is per-each, so bridge `× subUnitSize` to
  // match the store helper's short-circuit and keep the roll-up dollar unchanged.
  const recipeCost = React.useMemo(() => {
    if (!recipe) return 0;
    let c = 0;
    for (const ing of recipe.ingredients || []) {
      const item = inventory.find((i) => (i as any).catalogId === ing.itemId || i.id === ing.itemId);
      if (item?.costPerUnit) c += (ing.quantity || 0) * item.costPerUnit * (item.subUnitSize || 1);
    }
    return c;
  }, [recipe, inventory]);
  const sellPrice = recipe?.sellPrice || 0;
  const margin = sellPrice - recipeCost;
  const fcPct = sellPrice === 0 ? 0 : Math.round((recipeCost * 100) / sellPrice);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.recipes.salesTitle', { name: recipeName })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.recipes.salesSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.recipes.unitsYtd')} value={String(totalUnits)} sub={T('section.recipes.acrossImports')} />
        <StatCard label={T('section.recipes.revenueYtd')} value={`$${totalRevenue.toFixed(0)}`} sub="" />
        <StatCard label={T('section.recipes.foodCostPct')} value={fcPct ? `${fcPct}%` : '—'} sub={T('section.recipes.salesVsSell', { price: sellPrice.toFixed(2) })} />
        <StatCard label={T('section.recipes.marginPerUnit')} value={margin ? `$${margin.toFixed(2)}` : '—'} sub={T('section.recipes.salesCost', { cost: recipeCost.toFixed(2) })} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>recent_sales.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
            {salesRows.length === 1
              ? T('section.recipes.importsCount', { count: salesRows.length })
              : T('section.recipes.importsCountPlural', { count: salesRows.length })}
          </Text>
        </View>
        {salesRows.length === 0 ? (
          <View style={{ padding: 22, alignItems: 'center', gap: 6 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.warn, letterSpacing: 0.4 }}>{T('section.recipes.noSalesData')}</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
              {T('section.recipes.noSalesDataBody')}
            </Text>
          </View>
        ) : (
          salesRows.slice(0, 30).map((r, i) => (
            <View key={r.importId} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 100 }}>{r.date}</Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>{T('section.recipes.salesImport', { id: r.importId.slice(-6) })}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>{T('section.recipes.salesUnits', { count: r.qty })}</Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 90, textAlign: 'right', fontVariant: ['tabular-nums'] }}>${r.revenue.toFixed(0)}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

// ─── method.tsx (Tier 2 — needs recipe_methods table) ─────────────────
function RecipeMethodPlaceholder({ recipeName }: { recipeName: string }) {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.recipes.methodTitle', { name: recipeName })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.recipes.methodSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.recipes.notYetWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {T('section.recipes.methodNotWiredBody')}
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── allergens.tsx (Tier 2 — needs allergen flags on catalog_ingredients) ─
function RecipeAllergensPlaceholder({ recipeName }: { recipeName: string }) {
  const C = useCmdColors();
  const T = useT();
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.recipes.allergensTitle', { name: recipeName })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.recipes.allergensSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.recipes.notYetWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {T('section.recipes.allergensNotWiredBody')}
        </Text>
      </View>
    </ScrollView>
  );
}
