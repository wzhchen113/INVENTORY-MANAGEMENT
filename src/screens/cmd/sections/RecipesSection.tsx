import React from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../../theme/colors';
import { sans, mono, Type } from '../../../theme/typography';
import { useStore } from '../../../store/useStore';
import { useRole } from '../../../hooks/useRole';
import { TabStrip } from '../../../components/cmd/TabStrip';
import { StatCard } from '../../../components/cmd/StatCard';
import { StatusPill } from '../../../components/cmd/StatusPill';
import { PropertiesJson } from '../../../components/cmd/PropertiesJson';
import { SectionCaption } from '../../../components/cmd/SectionCaption';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Reads useStore.recipes + getRecipeCost +
// getRecipeFoodCostPct. Detail shows the ingredient table with cost
// breakdown. Staff sees view-only without the cost columns.
export default function RecipesSection() {
  const C = useCmdColors();
  const role = useRole();
  const recipes = useStore((s) => s.recipes);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getRecipeCost = useStore((s) => s.getRecipeCost);
  const getRecipeFoodCostPct = useStore((s) => s.getRecipeFoodCostPct);
  const getIngredientLineCost = useStore((s) => s.getIngredientLineCost);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('recipe.tsx');

  // Recipes are brand-level after the catalog refactor — every store sees
  // the same set. (Previously this filtered by storeId; that's now the
  // brand id, and the comparison always failed for non-Towson stores.)
  const storeRecipes = recipes;

  React.useEffect(() => {
    if (selectedId && storeRecipes.find((r) => r.id === selectedId)) return;
    setSelectedId(storeRecipes[0]?.id || null);
  }, [storeRecipes, selectedId]);

  const sel = storeRecipes.find((r) => r.id === selectedId);
  const selCost = sel ? getRecipeCost(sel.id) : 0;
  const selMargin = sel && sel.sellPrice ? Math.round((1 - selCost / sel.sellPrice) * 100) : null;
  const selFoodCostPct = sel ? getRecipeFoodCostPct(sel.id) : 0;

  const ingredientRows = React.useMemo(() => {
    if (!sel) return [];
    return (sel.ingredients || []).map((ing) => {
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
      };
    });
  }, [sel, inventory, getIngredientLineCost, selCost]);

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
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
          }}
        >
          <Text style={[Type.h2, { color: C.fg }]}>Recipes</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
            {storeRecipes.length} total
          </Text>
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={storeRecipes}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              no recipes for {currentStore.name || 'this store'}
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
                    <View style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm }}>
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>DUPLICATE</Text>
                    </View>
                    <View style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>EDIT</Text>
                    </View>
                  </View>
                ) : null
              }
            />
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
                  <StatCard label="Plate cost" value={`$${selCost.toFixed(2)}`} sub={`${(sel.ingredients || []).length} ingredients`} />
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
          </>
        )}
      </View>
    </>
  );
}
