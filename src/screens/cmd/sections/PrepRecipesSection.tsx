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
import { PrepRecipeFormDrawer } from '../../../components/cmd/PrepRecipeFormDrawer';
import { confirmAction } from '../../../utils/confirmAction';
import { relativeTime } from '../../../utils/relativeTime';
import { getConversionFactor } from '../../../utils/unitConversion';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Distinct from RecipesSection: prep recipes are
// sub-recipes (BOH prep that yields a sub-ingredient — "marinated chicken
// → 1 lb yield"), not menu items. They have a yield (qty + unit) instead
// of a sell price, and their ingredients can themselves be other prep
// recipes (sub-recipes recursive). Reuses useStore.prepRecipes +
// getPrepRecipeCost + getPrepRecipeCostPerUnit selectors.
export default function PrepRecipesSection() {
  const C = useCmdColors();
  const role = useRole();
  const prepRecipes = useStore((s) => s.prepRecipes);
  const inventory = useStore((s) => s.inventory);
  const currentStore = useStore((s) => s.currentStore);
  const getPrepRecipe = useStore((s) => s.getPrepRecipe);
  const getPrepRecipeCost = useStore((s) => s.getPrepRecipeCost);
  const getPrepRecipeCostPerUnit = useStore((s) => s.getPrepRecipeCostPerUnit);
  const getIngredientLineCost = useStore((s) => s.getIngredientLineCost);
  const deletePrepRecipe = useStore((s) => s.deletePrepRecipe);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState('prep.tsx');
  const [drawerMode, setDrawerMode] = React.useState<null | 'new' | 'edit' | 'duplicate'>(null);

  // Prep recipes are brand-level after the catalog refactor — every
  // store sees the same set. Just filter to the current version.
  const storePrepRecipes = React.useMemo(
    () => prepRecipes.filter((p) => p.isCurrent !== false),
    [prepRecipes],
  );

  React.useEffect(() => {
    if (selectedId && storePrepRecipes.find((r) => r.id === selectedId)) return;
    setSelectedId(storePrepRecipes[0]?.id || null);
  }, [storePrepRecipes, selectedId]);

  const sel = storePrepRecipes.find((r) => r.id === selectedId);
  const selCost = sel ? getPrepRecipeCost(sel.id) : 0;
  const selCostPerUnit = sel ? getPrepRecipeCostPerUnit(sel.id) : 0;

  const ingredientRows = React.useMemo(() => {
    if (!sel) return [];
    return (sel.ingredients || []).map((ing) => {
      const isPrep = (ing.type ?? 'raw') === 'prep';
      // Resolve via lineage — the stored sub-recipe id may point at a
      // non-current version, but we want the current cost.
      const subRecipe = isPrep ? getPrepRecipe(ing.itemId) : undefined;
      // Raw ingredient: ing.itemId is a catalog id (brand-level). Resolve
      // to current store's inventory row for cost / par display.
      const item = !isPrep
        ? (inventory.find((i) => i.catalogId === ing.itemId && i.storeId === currentStore.id) ||
           inventory.find((i) => i.id === ing.itemId))
        : undefined;
      // For raw ingredients we delegate to getIngredientLineCost; for sub-recipes
      // we estimate via cost-per-unit × converted quantity (matches the
      // canonical conversion used by getRecipeCost — without it a 1 lb yield
      // sub-recipe used at 8 oz would be charged 8× instead of 0.5×).
      let lineCost = 0;
      if (isPrep && subRecipe) {
        const cpu = getPrepRecipeCostPerUnit(subRecipe.id);
        const factor = getConversionFactor(ing.unit, subRecipe.yieldUnit);
        const convertedQty = factor !== null ? ing.quantity * factor : ing.quantity;
        lineCost = +(cpu * convertedQty).toFixed(2);
      } else {
        lineCost = +getIngredientLineCost(ing).toFixed(2);
      }
      const pct = selCost > 0 ? Math.round((lineCost / selCost) * 100) : 0;
      return {
        id: ing.itemId,
        name: ing.itemName || subRecipe?.name || item?.name || '—',
        qty: ing.quantity,
        unit: ing.unit,
        cost: lineCost,
        pct,
        kind: isPrep ? 'sub' : 'raw',
      };
    });
  }, [sel, inventory, prepRecipes, getIngredientLineCost, getPrepRecipe, getPrepRecipeCostPerUnit, selCost]);

  return (
    <>
      {/* List pane */}
      <View
        style={{
          width: 340,
          backgroundColor: C.panel,
          borderRightWidth: 1,
          borderRightColor: C.border,
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
          <Text style={[Type.h2, { color: C.fg }]}>Prep recipes</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {storePrepRecipes.length} active
            </Text>
            {role === 'admin' ? (
              <TouchableOpacity
                onPress={() => setDrawerMode('new')}
                style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                accessibilityRole="button"
                accessibilityLabel="New prep recipe"
              >
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>+ NEW</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <FlatList
          data={storePrepRecipes}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              no prep recipes for {currentStore.name || 'this store'}
            </Text>
          }
          renderItem={({ item: r }) => {
            const isSel = r.id === selectedId;
            const cost = getPrepRecipeCost(r.id);
            const cpu = getPrepRecipeCostPerUnit(r.id);
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
                    {r.name}
                  </Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>{shortId(r.id)}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
                    {r.yieldQuantity} {r.yieldUnit}
                  </Text>
                  <View style={{ flex: 1 }} />
                  {role === 'admin' ? (
                    <>
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg, fontVariant: ['tabular-nums'] }}>
                        ${cost.toFixed(2)}
                      </Text>
                      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg2, fontVariant: ['tabular-nums'] }}>
                        ${cpu.toFixed(2)}/{r.yieldUnit}
                      </Text>
                    </>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Detail pane */}
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {!sel ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>
              {storePrepRecipes.length === 0
                ? 'no prep recipes yet — sub-recipes used as ingredients in menu items'
                : 'select a prep recipe'}
            </Text>
          </View>
        ) : (
          <>
            <TabStrip
              tabs={[
                { id: 'prep.tsx',         label: 'prep.tsx' },
                { id: 'method.tsx',       label: 'method.tsx' },
                { id: 'sub_recipes.tsx',  label: 'sub_recipes.tsx' },
                { id: 'usage.tsx',        label: 'usage.tsx' },
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
                          `Delete "${sel.name}"?`,
                          'Removes the prep recipe and its ingredient list. Any menu recipe referencing it will lose the prep link.',
                          () => {
                            deletePrepRecipe(sel.id);
                            setSelectedId(null);
                            Toast.show({ type: 'success', text1: 'Deleted', text2: sel.name });
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
            {tabId === 'sub_recipes.tsx' ? (
              <PrepSubRecipesTab prep={sel} />
            ) : tabId === 'usage.tsx' ? (
              <PrepUsageTab prep={sel} />
            ) : tabId === 'method.tsx' ? (
              <PrepMethodPlaceholder prepName={sel.name} />
            ) : (
            <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>{shortId(sel.id)}</Text>
                  <StatusPill status="ok" label={`v${sel.version ?? 1}`} />
                  {sel.category ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3 }}>· {sel.category}</Text>
                  ) : null}
                </View>
                <Text style={[Type.display, { color: C.fg }]}>{sel.name}</Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  yields {sel.yieldQuantity} {sel.yieldUnit} · {(sel.ingredients || []).length} ingredient
                  {(sel.ingredients || []).length === 1 ? '' : 's'}
                  {sel.createdAt ? ` · created ${relativeTime(sel.createdAt) || 'recently'} ago` : ''}
                </Text>
              </View>

              {role === 'admin' ? (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label="Total cost"    value={`$${selCost.toFixed(2)}`} sub={`for ${sel.yieldQuantity} ${sel.yieldUnit}`} />
                  <StatCard label="Cost / unit"   value={`$${selCostPerUnit.toFixed(2)}`} sub={`per ${sel.yieldUnit}`} />
                  <StatCard label="Ingredients"   value={String((sel.ingredients || []).length)} sub={`${ingredientRows.filter((r) => r.kind === 'sub').length} sub-recipe${ingredientRows.filter((r) => r.kind === 'sub').length === 1 ? '' : 's'}`} />
                  <StatCard label="Version"       value={`v${sel.version ?? 1}`} sub={sel.parentId ? 'derived' : 'original'} />
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
                    <SectionCaption tone="fg3" size={10.5}>bom.tsv</SectionCaption>
                    {role === 'admin' ? (
                      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>
                        {ingredientRows.length} lines · total ${selCost.toFixed(2)}
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
                        <Text
                          style={{
                            fontFamily: mono(700),
                            fontSize: 9.5,
                            color: row.kind === 'sub' ? C.accent : C.fg3,
                            width: 40,
                            letterSpacing: 0.5,
                          }}
                        >
                          {row.kind === 'sub' ? 'PREP' : 'RAW'}
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
                      { key: 'category',     value: sel.category ? `"${sel.category}"` : '—' },
                      { key: 'yield_qty',    value: String(sel.yieldQuantity) },
                      { key: 'yield_unit',   value: `"${sel.yieldUnit}"` },
                      { key: 'version',      value: String(sel.version ?? 1) },
                      { key: 'is_current',   value: String(sel.isCurrent ?? true) },
                      ...(role === 'admin'
                        ? [
                            { key: 'total_cost',    value: `$${selCost.toFixed(2)}` },
                            { key: 'cost_per_unit', value: `$${selCostPerUnit.toFixed(2)}` },
                          ]
                        : [{ key: 'cost', value: '— admin only' }]),
                      { key: 'notes',        value: sel.notes ? `"${sel.notes}"` : '"—"' },
                    ]}
                  />
                </View>
              </View>
            </ScrollView>
            )}
          </>
        )}
      </View>

      <PrepRecipeFormDrawer
        visible={drawerMode !== null}
        mode={drawerMode || 'new'}
        prep={drawerMode === 'edit' || drawerMode === 'duplicate' ? sel : undefined}
        onClose={() => setDrawerMode(null)}
      />
    </>
  );
}

// ─── sub_recipes.tsx — children + parents graph ───────────────────────
function PrepSubRecipesTab({ prep }: { prep: any }) {
  const C = useCmdColors();
  const prepRecipes = useStore((s) => s.prepRecipes);

  // Children: this prep's ingredients with type === 'prep' point at other preps.
  const children = React.useMemo(() => {
    const ings = (prep.ingredients || []).filter((i: any) => (i.type || 'raw') === 'prep' && i.itemId);
    return ings.map((i: any) => {
      const child = prepRecipes.find((p) => p.id === i.itemId);
      return {
        id: i.itemId,
        name: child?.name || `(missing ${String(i.itemId).slice(0, 6)})`,
        quantity: i.quantity,
        unit: i.unit,
        broken: !child,
      };
    });
  }, [prep, prepRecipes]);

  // Parents: any prep whose ingredients reference THIS prep id.
  const parents = React.useMemo(() => {
    return prepRecipes.filter((p) =>
      (p.ingredients || []).some((i: any) => (i.type || 'raw') === 'prep' && i.itemId === prep.id),
    );
  }, [prepRecipes, prep.id]);

  // Detect circular reference: BFS from children, stop at prep.id.
  const circular = React.useMemo(() => {
    const visited = new Set<string>();
    const queue: string[] = children.map((c: any) => c.id);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === prep.id) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const node = prepRecipes.find((p) => p.id === cur);
      if (!node) continue;
      for (const ing of (node.ingredients || []) as any[]) {
        if ((ing.type || 'raw') === 'prep' && ing.itemId) queue.push(ing.itemId);
      }
    }
    return false;
  }, [children, prepRecipes, prep.id]);

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{prep.name} · sub-recipes</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Dependency graph: children (preps this one references) and parents (preps that reference this one).
        </Text>
      </View>
      {circular ? (
        <View style={{ borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.lg, backgroundColor: C.dangerBg, padding: 14 }}>
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger, letterSpacing: 0.4 }}>CIRCULAR REFERENCE DETECTED</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, marginTop: 4 }}>
            One of this prep's children eventually references back to itself. Cost cascades will fail until resolved.
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 14 }}>
        <View style={{ flex: 1, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>children.tsv</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{children.length}</Text>
          </View>
          {children.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 14 }}>no sub-recipe references — only raw ingredients</Text>
          ) : (
            children.map((c: any, i: number) => (
              <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12, color: c.broken ? C.danger : C.fg, flex: 1 }} numberOfLines={1}>{c.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>{c.quantity} {c.unit}</Text>
              </View>
            ))
          )}
        </View>
        <View style={{ flex: 1, backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
            <SectionCaption tone="fg3" size={10.5}>parents.tsv</SectionCaption>
            <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{parents.length}</Text>
          </View>
          {parents.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 14 }}>no preps reference this</Text>
          ) : (
            parents.map((p, i) => (
              <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
                <Text style={{ fontFamily: sans(500), fontSize: 12, color: C.fg, flex: 1 }} numberOfLines={1}>{p.name}</Text>
                <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>v{p.version ?? 1}</Text>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

// ─── usage.tsx — where this prep is consumed ──────────────────────────
function PrepUsageTab({ prep }: { prep: any }) {
  const C = useCmdColors();
  const recipes = useStore((s) => s.recipes);
  const posImports = useStore((s) => s.posImports);
  const currentStore = useStore((s) => s.currentStore);

  // Recipes that reference this prep via recipe_prep_items (= recipe.prepItems on the model).
  const consumers = React.useMemo(() => {
    return recipes
      .filter((r) => (r.prepItems || []).some((p: any) => p.prepRecipeId === prep.id))
      .map((r) => {
        const item = (r.prepItems || []).find((p: any) => p.prepRecipeId === prep.id);
        return { recipe: r, qtyPerSale: item?.quantity || 0, unit: item?.unit || prep.yieldUnit };
      });
  }, [recipes, prep.id, prep.yieldUnit]);

  // Sales-driven weekly consumption.
  const weeklyDepletion = React.useMemo(() => {
    let totalQty = 0;
    let weekCount = 1;
    const oneWeekAgo = Date.now() - 7 * 86400000;
    for (const im of posImports.filter((p) => p.storeId === currentStore.id)) {
      if (new Date(im.importedAt).getTime() < oneWeekAgo) continue;
      for (const it of im.items || []) {
        const c = consumers.find((cn) => cn.recipe.id === it.recipeId);
        if (c && it.qtySold) totalQty += c.qtyPerSale * it.qtySold;
      }
    }
    return { totalQty, weekCount };
  }, [posImports, consumers, currentStore.id]);

  const yieldQty = (prep.yieldQuantity || 0);
  const daysCover = weeklyDepletion.totalQty > 0 ? (yieldQty / (weeklyDepletion.totalQty / 7)).toFixed(1) : '—';

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{prep.name} · usage</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Where this prep is consumed and how much per week.
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label="Used by" value={String(consumers.length)} sub="recipes" />
        <StatCard label="Per week" value={`${weeklyDepletion.totalQty.toFixed(1)} ${prep.yieldUnit}`} sub="sales-driven" />
        <StatCard label="Yield" value={`${yieldQty} ${prep.yieldUnit}`} sub="per batch" />
        <StatCard label="Days cover" value={daysCover === '—' ? '—' : `${daysCover}d`} sub="at current rate" />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>consumers.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{consumers.length}</Text>
        </View>
        {consumers.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            no recipes reference this prep yet
          </Text>
        ) : (
          consumers.map(({ recipe, qtyPerSale, unit }, i) => (
            <View key={recipe.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
              <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{recipe.menuItem}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>{recipe.category}</Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 110, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                {qtyPerSale} {unit} / sale
              </Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

// ─── method.tsx (Tier 2 — needs prep_recipe_methods table) ──────────────
function PrepMethodPlaceholder({ prepName }: { prepName: string }) {
  const C = useCmdColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{prepName} · method</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          Cook steps, yield check, HACCP cooling log.
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>NOT YET WIRED</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          Needs a `prep_recipe_methods` table — coming in a follow-up migration.
        </Text>
      </View>
    </ScrollView>
  );
}
