// src/screens/cmd/sections/phone/PhoneCatalogList.tsx — Spec 142 (chunk b).
//
// The phone catalog lens (AC-INV5). Same shape as the per-store phone list: a
// full-width virtualized list grouped by category → a full-screen drill-in
// detail, NO 340px fixed pane, NO tab strip, NO EDIT/DELETE/NEW toolbar (Hard
// Rule 4). Catalog groups the SAME `inventory` slice by lowercase name (the
// legacy cross-store convention the desktop InventoryCatalogMode uses) — no new
// store field, no new db.ts surface. Desktop-only edit actions surface an honest
// toast (AC-D5) rather than a fake phone form.

import React from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { useT } from '../../../../hooks/useT';
import { useLocale } from '../../../../hooks/useLocale';
import { getLocalizedName } from '../../../../i18n/localizedName';
import { matchesQuery } from '../../../../i18n/matchesQuery';
import { relativeTime } from '../../../../utils/relativeTime';
import { StatusPill } from '../../../../components/cmd/StatusPill';
import { PhoneDrillScaffold } from './PhoneDrillScaffold';
import { usePhoneDrill } from './usePhoneDrill';
import { GroupCaption, StatPanel, PropertyCard } from './PhoneWidgets';
import type { InventoryItem, ItemStatus } from '../../../../types';

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 6) : id);

function aggStatus(getStatus: (i: InventoryItem) => ItemStatus, rows: InventoryItem[]): ItemStatus {
  if (rows.some((r) => getStatus(r) === 'out')) return 'out';
  if (rows.some((r) => getStatus(r) === 'low')) return 'low';
  return 'ok';
}

interface CatalogGroup {
  /** Stable identity for usePhoneDrill — the lowercase-name group key. */
  id: string;
  key: string;
  name: string;
  category: string;
  unit: string;
  rows: InventoryItem[];
  totalStock: number;
  weightedCost: number;
  storeCount: number;
  primary: InventoryItem;
  i18nNames?: InventoryItem['i18nNames'];
}

type ListRow =
  | { kind: 'header'; key: string; category: string }
  | { kind: 'row'; key: string; group: CatalogGroup };

// ── Detail ───────────────────────────────────────────────────────────────────
function CatalogDetail({ group }: { group: CatalogGroup }) {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const stores = useStore((s) => s.stores);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const status = aggStatus(getItemStatus, group.rows);
  const avgCost = group.totalStock > 0
    ? group.weightedCost / group.totalStock
    : group.rows.reduce((s, r) => s + (r.costPerUnit || 0), 0) / Math.max(1, group.rows.length);
  const displayName = getLocalizedName({ name: group.name, i18nNames: group.i18nNames }, locale);
  const lastCount = group.rows.reduce<string | null>(
    (latest, r) => (r.lastUpdatedAt && (!latest || r.lastUpdatedAt > latest) ? r.lastUpdatedAt : latest),
    null,
  );

  const propRows = [
    { label: 'CATEGORY', value: group.category },
    { label: 'UNIT', value: group.unit },
    { label: 'CASE PACK', value: `${group.primary.caseQty || '—'}${group.primary.casePrice ? ` · $${group.primary.casePrice.toFixed(2)}/case` : ''}` },
    { label: 'AVG COST', value: avgCost > 0 ? `$${avgCost.toFixed(2)}` : '—' },
    // Spec 160 — RELABEL ONLY (same reasoning as InventoryCatalogMode): this is
    // a brand-wide max(lastUpdatedAt) reduce, i.e. "last EDITED". Hardcoded
    // literal in an already-hardcoded propRows array; no new i18n key.
    { label: 'LAST EDITED', value: relativeTime(lastCount) || 'never' },
  ];

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusPill status={status} />
          <Text style={[PhoneType.microCaption, { color: C.fg3, flex: 1 }]} numberOfLines={1}>
            CATALOG · {group.category.toUpperCase()} · {shortId(group.primary.id)}
          </Text>
        </View>
        <Text style={[PhoneType.detailTitle, { color: C.fg }]}>{displayName}</Text>
      </View>

      <StatPanel
        testID="phone-catalog-statpanel"
        cells={[
          { label: 'ON HAND', value: `${group.totalStock.toFixed(1)}`, tone: 'fg' },
          { label: 'STORES', value: `${group.storeCount}/${stores.length}`, tone: 'fg' },
          { label: 'AVG COST', value: avgCost > 0 ? `$${avgCost.toFixed(2)}` : '—', tone: 'fg' },
        ]}
      />

      {/* Per-store breakdown */}
      <View style={{ backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: CmdRadius.md, overflow: 'hidden' }}>
        <GroupCaption>PER STORE</GroupCaption>
        {group.rows.map((row) => {
          const store = stores.find((s) => s.id === row.storeId);
          return (
            <View
              key={row.id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: C.border }}
            >
              <Text style={{ fontFamily: PhoneType.itemName.fontFamily, fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                {store?.name || row.storeId.slice(0, 6)}
              </Text>
              <Text style={[PhoneType.metaMono, { color: C.fg2 }]}>
                {row.currentStock} /{row.parLevel} {row.unit}
              </Text>
              <StatusPill status={getItemStatus(row)} />
            </View>
          );
        })}
      </View>

      {/* Properties */}
      <PropertyCard title="PROPERTIES" rows={propRows} />

      {/* Desktop-only edit — honest toast (AC-D5), no fake phone form. */}
      <TouchableOpacity
        testID="phone-catalog-edit-desktop"
        onPress={() => Toast.show({ type: 'info', text1: T('section.inventory.editOnDesktop') })}
        activeOpacity={0.85}
        accessibilityRole="button"
        style={{ height: 48, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: mono(600), fontSize: 12, letterSpacing: 0.5, color: C.fg2 }}>
          {T('section.inventory.editOnDesktop')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ── List ─────────────────────────────────────────────────────────────────────
export const PhoneCatalogList: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const locale = useLocale();
  const inventory = useStore((s) => s.inventory);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [query, setQuery] = React.useState('');
  const drill = usePhoneDrill<CatalogGroup>();

  const groups = React.useMemo<CatalogGroup[]>(() => {
    const map = new Map<string, CatalogGroup>();
    for (const it of inventory) {
      const k = it.name.toLowerCase();
      let g = map.get(k);
      if (!g) {
        g = { id: k, key: k, name: it.name, category: it.category, unit: it.unit, rows: [], totalStock: 0, weightedCost: 0, storeCount: 0, primary: it, i18nNames: it.i18nNames };
        map.set(k, g);
      }
      g.rows.push(it);
      g.totalStock += it.currentStock || 0;
      g.weightedCost += (it.currentStock || 0) * (it.costPerUnit || 0);
    }
    for (const g of map.values()) g.storeCount = new Set(g.rows.map((r) => r.storeId)).size;
    return Array.from(map.values());
  }, [inventory]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return groups;
    return groups.filter((g) => {
      const localizedName = getLocalizedName({ name: g.name, i18nNames: g.i18nNames }, locale);
      return matchesQuery(query, [localizedName, g.name, g.category]);
    });
  }, [groups, query, locale]);

  const listData = React.useMemo<ListRow[]>(() => {
    const byCat = new Map<string, CatalogGroup[]>();
    for (const g of filtered) {
      const arr = byCat.get(g.category);
      if (arr) arr.push(g);
      else byCat.set(g.category, [g]);
    }
    const cats = Array.from(byCat.keys()).sort((a, b) => a.localeCompare(b, locale));
    const out: ListRow[] = [];
    for (const cat of cats) {
      out.push({ kind: 'header', key: `h:${cat}`, category: cat });
      const rows = byCat.get(cat)!.slice().sort((a, b) =>
        getLocalizedName({ name: a.name, i18nNames: a.i18nNames }, locale)
          .localeCompare(getLocalizedName({ name: b.name, i18nNames: b.i18nNames }, locale), locale),
      );
      for (const g of rows) out.push({ kind: 'row', key: g.key, group: g });
    }
    return out;
  }, [filtered, locale]);

  const renderRow = (g: CatalogGroup) => {
    const status = aggStatus(getItemStatus, g.rows);
    const avgCost = g.totalStock > 0
      ? g.weightedCost / g.totalStock
      : g.rows.reduce((s, r) => s + (r.costPerUnit || 0), 0) / Math.max(1, g.rows.length);
    return (
      <TouchableOpacity
        testID={`phone-catalog-row-${g.key}`}
        onPress={() => drill.open(g)}
        activeOpacity={0.7}
        style={{ minHeight: 56, paddingHorizontal: 14, paddingVertical: 9, gap: 4, borderBottomWidth: 1, borderBottomColor: C.border }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusPill status={status} />
          <Text style={[PhoneType.itemName, { flex: 1, color: C.fg }]} numberOfLines={1}>
            {getLocalizedName({ name: g.name, i18nNames: g.i18nNames }, locale)}
          </Text>
          <Text style={[PhoneType.metaMono, { color: C.fg2 }]}>{avgCost > 0 ? `$${avgCost.toFixed(2)}` : '—'}</Text>
        </View>
        <Text style={[PhoneType.metaMono, { color: C.fg3 }]} numberOfLines={1}>
          {g.storeCount === 1
            ? T('section.inventory.inStore', { count: g.storeCount })
            : T('section.inventory.inStores', { count: g.storeCount })}
          {' · '}
          {g.totalStock.toFixed(1)} {g.unit}
        </Text>
      </TouchableOpacity>
    );
  };

  const listNode = (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
        <TextInput
          testID="phone-catalog-search"
          value={query}
          onChangeText={setQuery}
          placeholder={T('section.inventory.filterPlaceholder')}
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
        testID="phone-catalog-flatlist"
        style={{ flex: 1, minHeight: 0 }}
        data={listData}
        keyExtractor={(r) => r.key}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
        ListEmptyComponent={
          <Text style={[PhoneType.metaMono, { color: C.fg3, padding: 22, textAlign: 'center' }]}>
            {groups.length === 0 ? T('section.inventory.noIngredients') : T('section.inventory.noMatches')}
          </Text>
        }
        renderItem={({ item: r }) =>
          r.kind === 'header' ? <GroupCaption>{r.category}</GroupCaption> : renderRow(r.group)
        }
      />
    </View>
  );

  return (
    <PhoneDrillScaffold
      testID="phone-catalog"
      parentCaption="CATALOG"
      onBack={drill.close}
      list={listNode}
      detail={drill.selected ? <CatalogDetail group={drill.selected} /> : null}
    />
  );
};
