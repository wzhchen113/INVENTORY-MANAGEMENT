import React from 'react';
import { View, Text, FlatList, TouchableOpacity, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useBreakpoint } from '../../theme/breakpoints';
import { parseFilter, matchesFilter } from '../../utils/filterParser';
import { InventoryRow } from '../../components/cmd/InventoryRow';
import { FilterInput } from '../../components/cmd/FilterInput';
import { FilterChip } from '../../components/cmd/FilterChip';
import { RoleBadge } from '../../components/cmd/RoleBadge';
import { TitleBar } from '../../components/cmd/TitleBar';
import { CmdStatusBar } from '../../components/cmd/StatusBar';
import { StatusDot } from '../../components/cmd/StatusDot';
import { ItemStatus } from '../../types';

const slugify = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');

interface ChipDef {
  id: string;
  label: string;
  match?: (status: ItemStatus, category: string) => boolean;
}

// Admin-only app — single chip set.
const CHIPS: ChipDef[] = [
  { id: 'all',     label: 'all' },
  { id: 'ok',      label: 'ok',      match: (s) => s === 'ok' },
  { id: 'low',     label: 'low',     match: (s) => s === 'low' },
  { id: 'out',     label: 'out',     match: (s) => s === 'out' },
  { id: 'protein', label: 'protein', match: (_, c) => c?.toLowerCase() === 'protein' },
  { id: 'produce', label: 'produce', match: (_, c) => c?.toLowerCase() === 'produce' },
];

export default function InventoryListScreen() {
  const C = useCmdColors();
  const breakpoint = useBreakpoint();
  const nav = useNavigation<any>();
  const inventory  = useStore((s) => s.inventory);
  const stores     = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const getItemStatus = useStore((s) => s.getItemStatus);

  const [filterText, setFilterText] = React.useState('');
  const [chipSel, setChipSel] = React.useState('all');

  const chips = CHIPS;
  const parsed = React.useMemo(() => parseFilter(filterText), [filterText]);

  const storeInventory = React.useMemo(
    () => inventory.filter((i) => i.storeId === currentStore.id),
    [inventory, currentStore.id],
  );

  const items = React.useMemo(() => {
    const chip = chips.find((c) => c.id === chipSel);
    return storeInventory.filter((i) => {
      if (!matchesFilter(i, parsed, getItemStatus)) return false;
      if (chip?.match && !chip.match(getItemStatus(i), i.category)) return false;
      return true;
    });
  }, [storeInventory, parsed, chips, chipSel, getItemStatus]);

  // Per-chip counts (for the "all 12 / ok 7 / low 3" badges).
  const chipCounts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const chip of chips) {
      if (!chip.match) {
        out[chip.id] = chip.id === 'all' ? storeInventory.length : storeInventory.length;
      } else {
        out[chip.id] = storeInventory.filter((i) => chip.match!(getItemStatus(i), i.category)).length;
      }
    }
    return out;
  }, [chips, storeInventory, getItemStatus]);

  const title = 'Inventory';
  const totalLabel = `${storeInventory.length} items`;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header */}
      {Platform.OS === 'web' && breakpoint === 'desktop' ? (
        <TitleBar storeName={currentStore?.name || 'store'} section="Inventory" />
      ) : null}

      <View
        style={{
          paddingTop: Platform.OS === 'web' ? 16 : 54,
          paddingHorizontal: 16,
          paddingBottom: 10,
          backgroundColor: C.panel,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TouchableOpacity
            onPress={() => nav.navigate('Drawer')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>☰</Text>
          </TouchableOpacity>
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontFamily: mono(400), fontSize: 11, color: C.fg3 }}
          >
            inv://{slugify(currentStore?.name || 'store')} — inventory
          </Text>
          <RoleBadge />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: sans(700), fontSize: 24, color: C.fg, letterSpacing: -0.4 }}>
            {title}
          </Text>
          <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingBottom: 4 }}>
            {totalLabel}
          </Text>
        </View>
        <FilterInput value={filterText} onChangeText={setFilterText} />
        <FlatList
          data={chips}
          keyExtractor={(c) => c.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item: c }) => (
            <FilterChip
              label={c.label}
              count={chipCounts[c.id]}
              selected={chipSel === c.id}
              onPress={() => setChipSel(c.id)}
            />
          )}
        />
      </View>

      {/* List */}
      <FlatList
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={({ item }) => (
          <InventoryRow
            item={{
              id: item.id,
              name: item.name,
              stock: item.currentStock,
              par: item.parLevel,
              unit: item.unit,
              category: item.category,
            }}
            selectedBorderWidth={3}
            onPress={() => nav.navigate('ItemDetail', { itemId: item.id })}
          />
        )}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', padding: 32, gap: 6 }}>
            <Text style={{ fontFamily: mono(400), fontSize: 12, color: C.fg3 }}>
              no matches
            </Text>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              filter:{filterText || ' (empty)'} · chip:{chipSel}
            </Text>
          </View>
        }
      />

      <CmdStatusBar
        bottomInset={Platform.OS === 'web' ? 0 : 28}
        left={
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusDot status="ok" />
              <Text style={[Type.statusBar, { color: C.fg3 }]}>synced</Text>
            </View>
            <Text style={[Type.statusBar, { color: C.fg3 }]}>
              {items.length} / {storeInventory.length}
            </Text>
          </>
        }
        right={
          <TouchableOpacity onPress={() => {
            // First filtered item — admin's quick "+ COUNT" launches into detail.
            const target = items[0];
            if (target) nav.navigate('ItemDetail', { itemId: target.id });
          }}>
            <Text style={[Type.statusBar, { color: C.accent, fontFamily: mono(600) }]}>+ COUNT</Text>
          </TouchableOpacity>
        }
      />
    </View>
  );
}
