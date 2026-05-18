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
import { useT } from '../../../hooks/useT';
import { useLocale } from '../../../hooks/useLocale';
import { getLocalizedName } from '../../../i18n/localizedName';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

// Pattern B — list+detail. Distinct from RecipesSection: prep recipes are
// sub-recipes (BOH prep that yields a sub-ingredient — "marinated chicken
// → 1 lb yield"), not menu items. They have a yield (qty + unit) instead
// of a sell price, and their ingredients can themselves be other prep
// recipes (sub-recipes recursive). Reuses useStore.prepRecipes +
// getPrepRecipeCost + getPrepRecipeCostPerUnit selectors.
export default function PrepRecipesSection() {
  const C = useCmdColors();
  const T = useT();
  const role = useRole();
  const locale = useLocale();
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
  // Spec 040 P3 / Q5 — sort by current-locale label so list ordering
  // matches what the user sees.
  const storePrepRecipes = React.useMemo(
    () => prepRecipes
      .filter((p) => p.isCurrent !== false)
      .slice()
      .sort((a, b) =>
        getLocalizedName({ name: a.name, i18nNames: a.i18nNames }, locale)
          .localeCompare(
            getLocalizedName({ name: b.name, i18nNames: b.i18nNames }, locale),
            locale,
          ),
      ),
    [prepRecipes, locale],
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
          <Text style={[Type.h2, { color: C.fg }]}>{T('section.prepRecipes.listTitle')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {storePrepRecipes.length} {T('section.prepRecipes.active')}
            </Text>
            {role === 'admin' ? (
              <TouchableOpacity
                onPress={() => setDrawerMode('new')}
                style={{ paddingVertical: 3, paddingHorizontal: 7, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                accessibilityRole="button"
                accessibilityLabel={T('section.prepRecipes.newAria')}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: '#000' }}>{T('section.prepRecipes.newButton')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <FlatList
          data={storePrepRecipes}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
              {T('section.prepRecipes.noPrepsForStore', { storeName: currentStore.name || T('chrome.store') })}
            </Text>
          }
          renderItem={({ item: r }) => {
            const isSel = r.id === selectedId;
            const cost = getPrepRecipeCost(r.id);
            const cpu = getPrepRecipeCostPerUnit(r.id);
            const localizedName = getLocalizedName(
              { name: r.name, i18nNames: r.i18nNames },
              locale,
            );
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
                ? T('section.prepRecipes.noPrepsHint')
                : T('section.prepRecipes.selectPrep')}
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
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.fg2 }}>{T('section.prepRecipes.duplicate')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        confirmAction(
                          T('section.prepRecipes.deletePrepConfirm', { name: sel.name }),
                          T('section.prepRecipes.deletePrepBody'),
                          () => {
                            deletePrepRecipe(sel.id);
                            setSelectedId(null);
                            Toast.show({ type: 'success', text1: T('section.prepRecipes.deletedToast'), text2: sel.name });
                          },
                        );
                      }}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(500), fontSize: 10.5, color: C.danger }}>{T('section.prepRecipes.delete')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setDrawerMode('edit')}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, backgroundColor: C.accent, borderRadius: CmdRadius.sm }}
                    >
                      <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: '#000' }}>{T('section.prepRecipes.edit')}</Text>
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
                <Text style={[Type.display, { color: C.fg }]}>
                  {getLocalizedName({ name: sel.name, i18nNames: sel.i18nNames }, locale)}
                </Text>
                <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
                  {(sel.ingredients || []).length === 1
                    ? T('section.prepRecipes.yieldDescription', { qty: sel.yieldQuantity, unit: sel.yieldUnit, count: (sel.ingredients || []).length })
                    : T('section.prepRecipes.yieldDescriptionPlural', { qty: sel.yieldQuantity, unit: sel.yieldUnit, count: (sel.ingredients || []).length })}
                  {sel.createdAt
                    ? (relativeTime(sel.createdAt)
                        ? T('section.prepRecipes.createdAgo', { time: relativeTime(sel.createdAt) || '' })
                        : T('section.prepRecipes.createdRecently'))
                    : ''}
                </Text>
              </View>

              {role === 'admin' ? (
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <StatCard label={T('section.prepRecipes.totalCost')}    value={`$${selCost.toFixed(2)}`} sub={T('section.prepRecipes.forYield', { qty: sel.yieldQuantity, unit: sel.yieldUnit })} />
                  <StatCard label={T('section.prepRecipes.costPerUnit')}   value={`$${selCostPerUnit.toFixed(2)}`} sub={T('section.prepRecipes.perUnit', { unit: sel.yieldUnit })} />
                  <StatCard label={T('section.prepRecipes.ingredientsLabel')}   value={String((sel.ingredients || []).length)} sub={
                    ingredientRows.filter((r) => r.kind === 'sub').length === 1
                      ? T('section.prepRecipes.subRecipeCount', { count: ingredientRows.filter((r) => r.kind === 'sub').length })
                      : T('section.prepRecipes.subRecipeCountPlural', { count: ingredientRows.filter((r) => r.kind === 'sub').length })
                  } />
                  <StatCard label={T('section.prepRecipes.version')}       value={`v${sel.version ?? 1}`} sub={sel.parentId ? T('section.prepRecipes.derived') : T('section.prepRecipes.original')} />
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
                        {T('section.prepRecipes.lineSummary', { count: ingredientRows.length, cost: selCost.toFixed(2) })}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 40 }}>{T('section.prepRecipes.kindCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 60 }}>{T('section.prepRecipes.idCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 }}>{T('section.prepRecipes.nameCol')}</Text>
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 90, textAlign: 'right' }}>{T('section.prepRecipes.qtyCol')}</Text>
                    {role === 'admin' ? (
                      <>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 80, textAlign: 'right' }}>{T('section.prepRecipes.costCol')}</Text>
                        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase', width: 50, textAlign: 'right' }}>{T('section.prepRecipes.pctCol')}</Text>
                      </>
                    ) : null}
                  </View>
                  {ingredientRows.length === 0 ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
                      {T('section.prepRecipes.noIngredients')}
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
                          {row.kind === 'sub' ? T('section.prepRecipes.subKind') : T('section.prepRecipes.raw')}
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
                        : [{ key: 'cost', value: T('common.adminOnly') }]),
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
  const T = useT();
  const prepRecipes = useStore((s) => s.prepRecipes);

  // Children: this prep's ingredients with type === 'prep' point at other preps.
  const children = React.useMemo(() => {
    const ings = (prep.ingredients || []).filter((i: any) => (i.type || 'raw') === 'prep' && i.itemId);
    return ings.map((i: any) => {
      const child = prepRecipes.find((p) => p.id === i.itemId);
      return {
        id: i.itemId,
        name: child?.name || T('section.prepRecipes.missingMarker', { id: String(i.itemId).slice(0, 6) }),
        quantity: i.quantity,
        unit: i.unit,
        broken: !child,
      };
    });
  }, [prep, prepRecipes, T]);

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
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.prepRecipes.subRecipesTitle', { name: prep.name })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.prepRecipes.subRecipesSubtitle')}
        </Text>
      </View>
      {circular ? (
        <View style={{ borderWidth: 1, borderColor: C.danger, borderRadius: CmdRadius.lg, backgroundColor: C.dangerBg, padding: 14 }}>
          <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.danger, letterSpacing: 0.4 }}>{T('section.prepRecipes.circularDetected')}</Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg, marginTop: 4 }}>
            {T('section.prepRecipes.circularBody')}
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
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 14 }}>{T('section.prepRecipes.noChildren')}</Text>
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
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 14 }}>{T('section.prepRecipes.noParents')}</Text>
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
  const T = useT();
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
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.prepRecipes.usageTitle', { name: prep.name })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.prepRecipes.usageSubtitle')}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <StatCard label={T('section.prepRecipes.usedBy')} value={String(consumers.length)} sub={T('section.prepRecipes.recipes')} />
        <StatCard label={T('section.prepRecipes.perWeek')} value={`${weeklyDepletion.totalQty.toFixed(1)} ${prep.yieldUnit}`} sub={T('section.prepRecipes.salesDriven')} />
        <StatCard label={T('section.prepRecipes.yieldLabel')} value={`${yieldQty} ${prep.yieldUnit}`} sub={T('section.prepRecipes.perBatch')} />
        <StatCard label={T('section.prepRecipes.daysCover')} value={daysCover === '—' ? '—' : `${daysCover}d`} sub={T('section.prepRecipes.atCurrentRate')} />
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: C.border }}>
          <SectionCaption tone="fg3" size={10.5}>consumers.tsv</SectionCaption>
          <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>{consumers.length}</Text>
        </View>
        {consumers.length === 0 ? (
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, padding: 22, textAlign: 'center' }}>
            {T('section.prepRecipes.noConsumers')}
          </Text>
        ) : (
          consumers.map(({ recipe, qtyPerSale, unit }, i) => (
            <View key={recipe.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 14, gap: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
              <Text style={{ fontFamily: sans(500), fontSize: 12.5, color: C.fg, flex: 1 }} numberOfLines={1}>{recipe.menuItem}</Text>
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>{recipe.category}</Text>
              <Text style={{ fontFamily: mono(500), fontSize: 11.5, color: C.fg, width: 110, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                {T('section.prepRecipes.qtyPerSale', { qty: qtyPerSale, unit })}
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
  const T = useT();
  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
      <View>
        <Text style={[Type.h1, { color: C.fg }]}>{T('section.prepRecipes.methodTitle', { name: prepName })}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2 }}>
          {T('section.prepRecipes.methodSubtitle')}
        </Text>
      </View>
      <View style={{ backgroundColor: C.panel, borderRadius: CmdRadius.lg, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10.5, color: C.fg3, letterSpacing: 0.4 }}>{T('section.prepRecipes.notYetWired')}</Text>
        <Text style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2, textAlign: 'center', maxWidth: 460 }}>
          {T('section.prepRecipes.methodNotWiredBody')}
        </Text>
      </View>
    </ScrollView>
  );
}
