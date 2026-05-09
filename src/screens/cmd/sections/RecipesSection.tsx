import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
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
import { confirmAction } from '../../../utils/confirmAction';
import { getConversionFactor } from '../../../utils/unitConversion';
import { parseFilter } from '../../../utils/filterParser';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Reads useStore.recipes + getRecipeCost +
// getRecipeFoodCostPct. Detail shows the ingredient table with cost
// breakdown. Staff sees view-only without the cost columns.
export default function RecipesSection() {
  const C = useCmdColors();
  const role = useRole();
  const recipes = useStore((s) => s.recipes);
  const inventory = useStore((s) => s.inventory);
  const prepRecipes = useStore((s) => s.prepRecipes);
  const currentStore = useStore((s) => s.currentStore);
  const getRecipeCost = useStore((s) => s.getRecipeCost);
  const getRecipeFoodCostPct = useStore((s) => s.getRecipeFoodCostPct);
  const getIngredientLineCost = useStore((s) => s.getIngredientLineCost);
  const getPrepRecipe = useStore((s) => s.getPrepRecipe);
  const getPrepRecipeCostPerUnit = useStore((s) => s.getPrepRecipeCostPerUnit);
  const deleteRecipe = useStore((s) => s.deleteRecipe);

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
  const filteredRecipes = React.useMemo(() => {
    if (!filterText.trim()) return storeRecipes;
    const parsed = parseFilter(filterText);
    return storeRecipes.filter((r) => {
      for (const { key, value } of parsed.filters) {
        if (key === 'category' && (r.category || '').toLowerCase() !== value) return false;
      }
      if (parsed.text.length > 0) {
        const haystack = (r.menuItem || '').toLowerCase();
        for (const t of parsed.text) if (!haystack.includes(t)) return false;
      }
      return true;
    });
  }, [storeRecipes, filterText]);

  React.useEffect(() => {
    if (selectedId && filteredRecipes.find((r) => r.id === selectedId)) return;
    setSelectedId(filteredRecipes[0]?.id || null);
  }, [filteredRecipes, selectedId]);

  const sel = storeRecipes.find((r) => r.id === selectedId);
  const selCost = sel ? getRecipeCost(sel.id) : 0;
  const selMargin = sel && sel.sellPrice ? Math.round((1 - selCost / sel.sellPrice) * 100) : null;
  const selFoodCostPct = sel ? getRecipeFoodCostPct(sel.id) : 0;

  const ingredientRows = React.useMemo(() => {
    if (!sel) return [];
    const rawRows = (sel.ingredients || []).map((ing) => {
      // ing.itemId is now a catalog id; resolve to the current store's
      // inventory_items row for cost/par. Fall back to legacy id match.
      const item =
        inventory.find((i) => i.catalogId === ing.itemId && i.storeId === currentStore.id) ||
        inventory.find((i) => i.id === ing.itemId);
      const lineCost = getIngredientLineCost(ing);
      const pct = selCost > 0 ? Math.round((lineCost / selCost) * 100) : 0;
      return {
        id: ing.itemId,
        name: ing.itemName || item?.name || '—',
        qty: ing.quantity,
        unit: ing.unit,
        cost: lineCost,
        pct,
        kind: 'raw' as const,
      };
    });
    // Prep recipes contribute to plate cost too — render them as PREP rows so
    // the breakdown sums to 100% and the user can see what each prep costs.
    // Mirrors the conversion in useStore.getRecipeCost: cost-per-unit ×
    // (ing.unit → yieldUnit converted) quantity.
    const prepRows = (sel.prepItems || []).map((prep) => {
      // Resolve via lineage so a recipe pointing at an old version still
      // costs against the current prep (yield, ingredients, etc.).
      const subRecipe = getPrepRecipe(prep.prepRecipeId);
      const cpu = subRecipe ? getPrepRecipeCostPerUnit(subRecipe.id) : 0;
      const factor = subRecipe ? getConversionFactor(prep.unit, subRecipe.yieldUnit) : null;
      const convertedQty = factor !== null ? prep.quantity * factor : prep.quantity;
      const lineCost = +(cpu * convertedQty).toFixed(2);
      const pct = selCost > 0 ? Math.round((lineCost / selCost) * 100) : 0;
      return {
        id: prep.prepRecipeId,
        name: prep.prepRecipeName || subRecipe?.name || '—',
        qty: prep.quantity,
        unit: prep.unit,
        cost: lineCost,
        pct,
        kind: 'prep' as const,
      };
    });
    return [...rawRows, ...prepRows];
  }, [sel, inventory, prepRecipes, getIngredientLineCost, getPrepRecipe, getPrepRecipeCostPerUnit, selCost, currentStore.id]);

  const marginColor = (m: number | null): string =>
    m == null ? C.fg2
    : m >= 70 ? C.ok
    : m >= 50 ? C.warn
    : C.danger;

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
              <Text style={[Type.h2, { color: C.fg }]}>Recipes</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
                {filterText.trim()
                  ? `${filteredRecipes.length} / ${storeRecipes.length}`
                  : `${storeRecipes.length} total`}
              </Text>
            </View>
            {role === 'admin' ? (
              <TouchableOpacity
                onPress={() => setDrawerMode('new')}
                style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                accessibilityRole="button"
                accessibilityLabel="New recipe"
              >
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>+ NEW</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <FilterInput
            value={filterText}
            onChangeText={setFilterText}
            placeholder="cat:appetizer chicken"
          />
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={filteredRecipes}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {filterText.trim()
                ? `no recipes match filter`
                : `no recipes for ${currentStore.name || 'this store'}`}
            </Text>
          }
          renderItem={({ item: r }) => {
            const isSel = r.id === selectedId;
            const cost = getRecipeCost(r.id);
            const margin = r.sellPrice ? Math.round((1 - cost / r.sellPrice) * 100) : null;
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
                    {r.menuItem}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{shortId(r.id)}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {r.category}
                  </Text>
                  <View style={{ flex: 1 }} />
                  {role === 'admin' ? (
                    <>
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg, fontVariant: ['tabular-nums'] }}>
                        ${cost.toFixed(2)}
                      </Text>
                      {margin != null ? (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: marginColor(margin), fontVariant: ['tabular-nums'] }}>
                          {margin}%
                        </Text>
                      ) : (
                        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>sub</Text>
                      )}
                    </>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg, minHeight: 0, minWidth: 0 }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {storeRecipes.length === 0 ? 'no recipes yet' : 'select a recipe'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'recipe.tsx',    label: 'recipe.tsx' },
                { id: 'method.tsx',    label: 'method.tsx' },
                { id: 'allergens.tsx', label: 'allergens.tsx' },
                { id: 'sales.tsx',     label: 'sales.tsx' },
              ]}
              activeId={tabId}
              onChange={setTabId}
              rightSlot={
                role === 'admin' ? (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      onPress={() => setDrawerMode('duplicate')}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>DUPLICATE</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        confirmAction(
                          `Delete "${sel.menuItem}"?`,
                          'Removes the recipe and its ingredient/prep links. POS imports referencing it stay intact (they record the menu name, not the FK).',
                          () => {
                            deleteRecipe(sel.id);
                            setSelectedId(null);
                            Toast.show({ type: 'success', text1: 'Deleted', text2: sel.menuItem });
                          },
                        );
                      }}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>DELETE</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setDrawerMode('edit')}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>EDIT</Text>
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
                  <StatusPill status="ok" label="ACTIVE" />
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
                    · {sel.category}
                  </Text>
                </View>
                <Text style={[Type.display, { color: C.fg }]}>{sel.menuItem}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {(sel.ingredients || []).length} ingredients{(sel.prepItems || []).length ? ` + ${(sel.prepItems || []).length} prep recipes` : ''}
                </Text>
              </View>

              {role === 'admin' ? (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard
                    label="Plate cost"
                    value={`$${selCost.toFixed(2)}`}
                    sub={
                      (sel.prepItems || []).length
                        ? `${(sel.ingredients || []).length} ingredients + ${(sel.prepItems || []).length} prep`
                        : `${(sel.ingredients || []).length} ingredients`
                    }
                  />
                  <StatCard label="Menu price" value={sel.sellPrice ? `$${sel.sellPrice.toFixed(2)}` : '—'} sub={sel.category.toLowerCase()} />
                  <StatCard
                    label="Margin"
                    value={selMargin != null ? `${selMargin}%` : '—'}
                    sub={selMargin != null ? 'vs target 70%' : 'sub-recipe'}
                  />
                  <StatCard label="Food cost %" value={`${selFoodCostPct.toFixed(1)}%`} sub="cost ÷ menu price" />
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
                        {ingredientRows.length} lines · plate cost ${selCost.toFixed(2)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 40 }}>kind</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60 }}>id</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>name</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>qty</Text>
                    {role === 'admin' ? (
                      <>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>cost</Text>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 50, textAlign: 'right' }}>%</Text>
                      </>
                    ) : null}
                  </View>
                  {ingredientRows.length === 0 ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                      no ingredients defined
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
                          {row.kind === 'prep' ? 'PREP' : 'RAW'}
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
                        : [{ key: 'plate_cost', value: '— admin only' }]),
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

  // Recipe cost from BOM × current cost_per_unit.
  const recipeCost = React.useMemo(() => {
    if (!recipe) return 0;
    let c = 0;
    for (const ing of recipe.ingredients || []) {
      const item = inventory.find((i) => (i as any).catalogId === ing.itemId || i.id === ing.itemId);
      if (item?.costPerUnit) c += (ing.quantity || 0) * item.costPerUnit;
    }
    return c;
  }, [recipe, inventory]);
  const sellPrice = recipe?.sellPrice || 0;
  const margin = sellPrice - recipeCost;
  const fcPct = sellPrice === 0 ? 0 : Math.round((recipeCost * 100) / sellPrice);

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{recipeName} · sales</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          POS-driven units sold / revenue / food cost % / margin · joined via POS mapping
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Units · YTD" value={String(totalUnits)} sub="across imports" />
        <StatCard label="Revenue · YTD" value={`$${totalRevenue.toFixed(0)}`} sub="" />
        <StatCard label="Food cost %" value={fcPct ? `${fcPct}%` : '—'} sub={`vs sell $${sellPrice.toFixed(2)}`} />
        <StatCard label="Margin / unit" value={margin ? `$${margin.toFixed(2)}` : '—'} sub={`cost $${recipeCost.toFixed(2)}`} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>recent_sales.log</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{salesRows.length} import{salesRows.length === 1 ? '' : 's'}</Text>
        </View>
        {salesRows.length === 0 ? (
          <View style={{ padding: 22, alignItems: 'center', gap: 6 }}>
            <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.warn, letterSpacing: 0.4 }}>NO SALES DATA</Text>
            <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
              Either no POS imports include this recipe, or the POS pos_name isn't mapped — check posimports/mapping.tsx.
            </Text>
          </View>
        ) : (
          salesRows.slice(0, 30).map((r, i) => (
            <View key={r.importId} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, width: 100 }}>{r.date}</Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, flex: 1 }} numberOfLines={1}>import {r.importId.slice(-6)}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, width: 80, textAlign: 'right' }}>{r.qty} units</Text>
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
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{recipeName} · method</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Ordered cook steps with time + ingredient-tag references.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Cook procedures need a `recipe_methods` table (step_no, instruction, duration_min, ingredient_tags) — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── allergens.tsx (Tier 2 — needs allergen flags on catalog_ingredients) ─
function RecipeAllergensPlaceholder({ recipeName }: { recipeName: string }) {
  const C = useCmdColors();
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{recipeName} · allergens</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          9-col allergen matrix computed from ingredient flags.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Needs allergen flags on `catalog_ingredients` (gluten, dairy, egg, soy, peanut, tree_nut, fish, shellfish, sesame) — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}
