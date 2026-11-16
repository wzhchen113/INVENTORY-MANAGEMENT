import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useT } from '../../hooks/useT';
import type { Store } from '../../types';

// Ingredient Save store scope — which stores a Save (edit) or Create (new)
// applies to:
//   this → only the store whose row is being edited (or the current store
//          when creating)
//   all  → every store of the brand
//   pick → the stores ticked in `storeIds`
export type StoreScopeMode = 'this' | 'all' | 'pick';

export interface StoreScope {
  mode: StoreScopeMode;
  /** Ticked stores for `pick` mode. Ignored by `this` / `all`. */
  storeIds: string[];
}

export function initialStoreScope(mode: StoreScopeMode, selfStoreId: string): StoreScope {
  // `pick` starts with this store ticked so switching to it is a refinement,
  // not an empty list.
  return { mode, storeIds: selfStoreId ? [selfStoreId] : [] };
}

/**
 * The store ids a scope resolves to, in `brandStores` order. `pick` keeps
 * only ids that are still brand stores (a stale id can't leak through).
 */
export function resolveScopeStoreIds(
  scope: StoreScope,
  brandStores: Pick<Store, 'id'>[],
  selfStoreId: string,
): string[] {
  if (scope.mode === 'this') return selfStoreId ? [selfStoreId] : [];
  if (scope.mode === 'all') {
    const ids = brandStores.map((s) => s.id);
    // Never drop the edited/current store, even if the stores slice hasn't
    // loaded it.
    return selfStoreId && !ids.includes(selfStoreId) ? [selfStoreId, ...ids] : ids;
  }
  const picked = new Set(scope.storeIds);
  return brandStores.filter((s) => picked.has(s.id)).map((s) => s.id);
}

interface Props {
  scope: StoreScope;
  onChange: (next: StoreScope) => void;
  brandStores: Pick<Store, 'id' | 'name'>[];
  selfStoreId: string;
  /** 'edit' explains which fields follow the scope; 'new' explains creation. */
  mode: 'edit' | 'new';
}

export const StoreScopePicker: React.FC<Props> = ({ scope, onChange, brandStores, selfStoreId, mode }) => {
  const C = useCmdColors();
  const T = useT();
  const selfName = brandStores.find((s) => s.id === selfStoreId)?.name ?? '';

  const renderOption = (value: StoreScopeMode, label: string) => {
    const on = scope.mode === value;
    return (
      <TouchableOpacity
        key={value}
        onPress={() => onChange({ ...scope, mode: value })}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={label}
        style={{
          paddingVertical: 4, paddingHorizontal: 9, borderRadius: CmdRadius.sm,
          borderWidth: 1, borderColor: on ? C.accent : C.border,
          backgroundColor: on ? C.accentBg : 'transparent',
        }}
      >
        <Text style={{ fontFamily: mono(on ? 700 : 400), fontSize: 10.5, color: on ? C.fg : C.fg2 }}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const toggleStore = (id: string) => {
    const has = scope.storeIds.includes(id);
    onChange({ ...scope, storeIds: has ? scope.storeIds.filter((x) => x !== id) : [...scope.storeIds, id] });
  };

  const pickedCount = resolveScopeStoreIds(scope, brandStores, selfStoreId).length;

  return (
    <View style={{ gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={T('section.inventory.storeScopeLabel')}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text style={{ fontFamily: mono(600), fontSize: 9.5, letterSpacing: 0.6, color: C.fg3 }}>
          {T('section.inventory.storeScopeLabel').toUpperCase()}
        </Text>
        {renderOption('this', selfName ? T('section.inventory.storeScopeThisNamed', { store: selfName }) : T('section.inventory.storeScopeThis'))}
        {renderOption('all', T('section.inventory.storeScopeAll', { count: brandStores.length }))}
        {renderOption('pick', T('section.inventory.storeScopePick'))}
      </View>
      {scope.mode === 'pick' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {brandStores.map((s) => {
            const on = scope.storeIds.includes(s.id);
            return (
              <TouchableOpacity
                key={s.id}
                onPress={() => toggleStore(s.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={s.name}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 5,
                  paddingVertical: 3, paddingHorizontal: 8, borderRadius: CmdRadius.sm,
                  borderWidth: 1, borderColor: on ? C.accent : C.border,
                  backgroundColor: on ? C.accentBg : 'transparent',
                }}
              >
                <Text style={{ fontFamily: mono(700), fontSize: 10, color: on ? C.fg : C.fg3 }}>{on ? '☑' : '☐'}</Text>
                <Text style={{ fontFamily: mono(on ? 600 : 400), fontSize: 10.5, color: on ? C.fg : C.fg2 }}>{s.name}</Text>
              </TouchableOpacity>
            );
          })}
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: pickedCount === 0 ? C.danger : C.fg3 }}>
            {pickedCount === 0
              ? T('section.inventory.storeScopeNonePicked')
              : T('section.inventory.storeScopePickedCount', { count: pickedCount })}
          </Text>
        </View>
      ) : null}
      <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3, lineHeight: 13 }}>
        {mode === 'edit' ? T('section.inventory.storeScopeEditHelp') : T('section.inventory.storeScopeNewHelp')}
      </Text>
    </View>
  );
};
