// src/components/cmd/StoreGatePicker.tsx — Spec 161.
//
// The sign-in store gate for users who can see MORE THAN ONE store. Rendered
// by `AdminStack` in place of the whole Cmd shell while `AppState.storeGate`
// is anything but `'ready'`, which is what guarantees every section behind it
// a real `currentStore` (they dereference `currentStore.` unconditionally —
// the `{ id: '' }` placeholder would break them).
//
// It covers the `'resolving'` tick too — the window between `login()` and
// `fetchStores` resolving, when nobody yet knows whether this user will be
// asked or auto-landed. That window renders as a bare spinner: showing the
// panes there would flash a picker at single-store users who are about to be
// landed automatically.
//
// Two panes, per the owner's reference: brands on the left, that brand's
// stores on the right, a name filter over each, a ✓ on the active row. On
// phone the panes stack — brand rows first, then the store list — because two
// side-by-side columns are unusable below ~700px.
//
// The brand pane is derived from the VISIBLE STORES' `brandId`s rather than
// from `brandsList`, so it can never offer a brand whose stores the user
// can't open. `brandsList` is consulted only to put a NAME on each group;
// when it hasn't loaded (a regular admin — `login()` preloads it for
// super-admins only) the effect below fetches it, and an unresolvable id
// degrades to a generic label rather than blocking the pick.
//
// Deliberately NOT wired into TitleBar's store switcher or BrandPicker. Those
// are mid-session switchers with their own dropdown/portal behavior; folding
// all three onto this widget is a separate change.

import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans, Type } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';
import { useIsPhone } from '../../theme/breakpoints';
import { brandNameFor, visibleStoresFor } from '../../lib/storeVisibility';
import { matchesQuery } from '../../i18n/matchesQuery';
import type { Store } from '../../types';

interface BrandGroup {
  id: string;
  name: string;
  stores: Store[];
}

export const StoreGatePicker: React.FC = () => {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();

  const stores = useStore((s) => s.stores);
  const currentUser = useStore((s) => s.currentUser);
  const currentStore = useStore((s) => s.currentStore);
  const currentBrandId = useStore((s) => s.currentBrandId);
  const brand = useStore((s) => s.brand);
  const brandsList = useStore((s) => s.brandsList);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  const setCurrentStore = useStore((s) => s.setCurrentStore);
  const logout = useStore((s) => s.logout);
  const storeGate = useStore((s) => s.storeGate);

  const [brandQuery, setBrandQuery] = React.useState('');
  const [storeQuery, setStoreQuery] = React.useState('');
  const [pickedBrandId, setPickedBrandId] = React.useState<string | null>(null);

  // `login()` preloads this for super-admins only; a regular admin reaches the
  // gate with an empty list. RLS (`brand_member_read_brands`) bounds the fetch
  // to the caller's own brand, so this is safe for every role — and a failure
  // is non-fatal, it just leaves the fallback label in place.
  React.useEffect(() => {
    if (brandsList.length === 0) {
      loadBrandsList().catch(() => { /* logged inside */ });
    }
  }, [brandsList.length, loadBrandsList]);

  const groups: BrandGroup[] = React.useMemo(() => {
    const visible = visibleStoresFor(stores, currentUser, currentBrandId);
    const byBrand = new Map<string, Store[]>();
    for (const s of visible) {
      const key = s.brandId || '';
      const bucket = byBrand.get(key);
      if (bucket) bucket.push(s);
      else byBrand.set(key, [s]);
    }
    return Array.from(byBrand.entries())
      .map(([id, list]) => ({
        id,
        name: brandNameFor(id, brand, brandsList) || T('storeGate.unnamedBrand'),
        stores: list,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [stores, currentUser, currentBrandId, brand, brandsList, T]);

  // Land on a brand as soon as one exists so the store pane is never empty on
  // open. Re-runs if `groups` arrives late (the store fetch resolves after
  // first paint) or if the picked brand drops out of the visible set.
  React.useEffect(() => {
    if (groups.length === 0) return;
    if (pickedBrandId && groups.some((g) => g.id === pickedBrandId)) return;
    const own = groups.find((g) => g.id === currentUser?.brandId) || groups[0];
    setPickedBrandId(own.id);
  }, [groups, pickedBrandId, currentUser?.brandId]);

  const filteredGroups = React.useMemo(
    () => (brandQuery.trim() ? groups.filter((g) => matchesQuery(brandQuery, [g.name])) : groups),
    [groups, brandQuery],
  );

  const visibleStores = React.useMemo(() => {
    const picked = groups.find((g) => g.id === pickedBrandId);
    const list = picked ? picked.stores : [];
    if (!storeQuery.trim()) return list;
    return list.filter((s) => matchesQuery(storeQuery, [s.name, s.address]));
  }, [groups, pickedBrandId, storeQuery]);

  // The pre-decision tick — see the header note. Deliberately BEFORE any of
  // the pane JSX so a single-store user never sees a picker frame.
  if (storeGate === 'resolving') {
    return (
      <View
        testID="store-gate-resolving"
        style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}
      >
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const fieldStyle = {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: CmdRadius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: C.fg,
    fontFamily: sans(400),
    fontSize: 13,
    backgroundColor: C.panel2,
  } as const;

  const paneStyle = {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
  } as const;

  const brandPane = (
    <View style={paneStyle} testID="store-gate-brand-pane">
      <TextInput
        testID="store-gate-brand-filter"
        value={brandQuery}
        onChangeText={setBrandQuery}
        placeholder={T('storeGate.brandFilter')}
        placeholderTextColor={C.fg3}
        style={fieldStyle}
        accessibilityLabel={T('storeGate.brandFilter')}
      />
      <ScrollView style={{ marginTop: 10 }} keyboardShouldPersistTaps="handled">
        {filteredGroups.map((g) => {
          const active = g.id === pickedBrandId;
          return (
            <TouchableOpacity
              key={g.id || '__nobrand__'}
              testID={`store-gate-brand-${g.id}`}
              onPress={() => { setPickedBrandId(g.id); setStoreQuery(''); }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 10,
                borderRadius: CmdRadius.sm,
                backgroundColor: active ? C.panel2 : 'transparent',
              }}
            >
              <Text
                style={{
                  flex: 1,
                  fontFamily: sans(active ? 600 : 400),
                  fontSize: 14,
                  color: active ? C.accent : C.fg,
                }}
                numberOfLines={1}
              >
                {g.name}
              </Text>
              <Text style={{ fontFamily: mono(400), fontSize: 12, color: active ? C.accent : C.fg3 }}>›</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  const storePane = (
    <View style={paneStyle} testID="store-gate-store-pane">
      <TextInput
        testID="store-gate-store-filter"
        value={storeQuery}
        onChangeText={setStoreQuery}
        placeholder={T('storeGate.storeFilter')}
        placeholderTextColor={C.fg3}
        style={fieldStyle}
        accessibilityLabel={T('storeGate.storeFilter')}
      />
      <ScrollView style={{ marginTop: 10 }} keyboardShouldPersistTaps="handled">
        {visibleStores.length === 0 ? (
          <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg3, padding: 10 }}>
            {T('storeGate.noMatches')}
          </Text>
        ) : (
          visibleStores.map((s) => {
            const active = s.id === currentStore.id;
            return (
              <TouchableOpacity
                key={s.id}
                testID={`store-gate-store-${s.id}`}
                onPress={() => setCurrentStore(s)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 12,
                  borderRadius: CmdRadius.sm,
                }}
              >
                <Text style={{ width: 16, fontFamily: mono(600), fontSize: 13, color: C.accent }}>
                  {active ? '✓' : ''}
                </Text>
                <Text
                  style={{
                    flex: 1,
                    fontFamily: sans(active ? 600 : 400),
                    fontSize: 14,
                    color: active ? C.accent : C.fg,
                  }}
                  numberOfLines={1}
                >
                  {s.name}
                </Text>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }} testID="store-gate-root">
      <View
        style={{
          paddingTop: isPhone ? 54 : 28,
          paddingHorizontal: 20,
          paddingBottom: 14,
          borderBottomWidth: 1,
          borderBottomColor: C.border,
        }}
      >
        <Text style={[Type.h2, { color: C.fg }]}>{T('storeGate.title')}</Text>
        <Text style={{ fontFamily: sans(400), fontSize: 13, color: C.fg2, marginTop: 4 }}>
          {T('storeGate.subtitle')}
        </Text>
      </View>

      <View style={{ flex: 1, flexDirection: isPhone ? 'column' : 'row' }}>
        {brandPane}
        {!isPhone && <View style={{ width: 1, backgroundColor: C.border }} />}
        {storePane}
      </View>

      {/* Escape hatch — without this a user who signed in as the wrong account
          is stuck here: the gate replaces the entire shell, sidebar included. */}
      <View style={{ padding: 16, borderTopWidth: 1, borderTopColor: C.border }}>
        <TouchableOpacity onPress={() => logout()} accessibilityRole="button" testID="store-gate-signout">
          <Text style={{ fontFamily: sans(500), fontSize: 13, color: C.fg2 }}>
            {T('storeGate.signOut')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
