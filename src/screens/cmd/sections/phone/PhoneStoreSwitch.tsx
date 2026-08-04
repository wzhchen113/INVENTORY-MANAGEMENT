// src/screens/cmd/sections/phone/PhoneStoreSwitch.tsx — Spec 148.
//
// Phone-tier store & brand switcher (README §21). The store chip in the phone
// drawer header opens a ResponsiveSheet: store rows (✓ CURRENT / SWITCH →) that
// the caller has access to, plus a BRAND · SUPER-ADMIN section (gated on
// useIsSuperAdmin, reusing the brandsList data the desktop BrandPicker reads).
//
// Picking a different store calls the EXISTING setCurrentStore action (which
// escalates `switching` → the production spec-111 full-screen takeover painted
// by the shell) and shows a toast; picking a brand calls setCurrentBrandId
// (→ the 'brand' takeover). Both close the sheet AND the drawer via onSwitched
// so the shell-root takeover — which sits BEHIND the drawer Modal — is visible.
//
// Access filtering mirrors TitleBar's store switcher verbatim (admin/master/
// super-admin see all stores; regular users see their user_stores grants; then
// narrow to the active brand). Frontend-only; no db.ts contract change.
//
// Spec 150 — the brand narrowing above used to be able to hide EVERY row: an
// active brand with no visible store rendered a bare "No stores available"
// with no way back except the brand rows, and the choice is persisted per
// device, so a phone stayed stuck across reloads while desktop (different
// cached brand) looked fine. The root fix lives in the store
// (`reconcileActiveBrand` + the `setCurrentBrandId` guard); this file keeps
// the predicate byte-identical to desktop and only makes the residual empty
// state name the brand it is scoped to.

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
import { visibleStoresFor } from '../../../../lib/storeVisibility';
import { useT } from '../../../../hooks/useT';
import { useIsSuperAdmin } from '../../../../hooks/useRole';
import { ResponsiveSheet } from '../../../../components/cmd/ResponsiveSheet';
import type { Store } from '../../../../types';

interface Props {
  /** Close the surrounding drawer so the shell-root switch takeover is visible. */
  onSwitched?: () => void;
}

export const PhoneStoreSwitch: React.FC<Props> = ({ onSwitched }) => {
  const C = useCmdColors();
  const T = useT();
  const isSuperAdmin = useIsSuperAdmin();
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const currentUser = useStore((s) => s.currentUser);
  const currentBrandId = useStore((s) => s.currentBrandId);
  const brand = useStore((s) => s.brand);
  const setCurrentStore = useStore((s) => s.setCurrentStore);
  const brandsList = useStore((s) => s.brandsList);
  const setCurrentBrandId = useStore((s) => s.setCurrentBrandId);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  const [open, setOpen] = React.useState(false);

  // Defensive brand re-fetch on open (login race may have left it empty) —
  // same idiom as BrandPicker. Cheap SELECT, RLS-gated to super-admin.
  React.useEffect(() => {
    if (open && isSuperAdmin && brandsList.length === 0) {
      loadBrandsList().catch(() => { /* logged inside */ });
    }
  }, [open, isSuperAdmin, brandsList.length, loadBrandsList]);

  // Spec 150 — shared with TitleBar's desktop switcher (this used to be a
  // byte-for-byte copy of it). Same inputs → same list, by construction.
  const accessibleStores = React.useMemo(
    () => visibleStoresFor(stores, currentUser, currentBrandId),
    [stores, currentUser, currentBrandId],
  );

  // Spec 150 (C) — when the list is empty BECAUSE an active brand narrowed it
  // away, say so and point at the brand rows below instead of the bare "No
  // stores available", which reads as "you have no access". The store slice
  // now falls back to All-brands before this state can persist (spec 150 D),
  // so this is defense-in-depth for the transient window where the store set
  // isn't known yet (cold boot, pre-fetchStores) and the brand can't be
  // validated. `brandsList` is super-admin-only; `brand` covers the window
  // before it loads.
  const activeBrandName = currentBrandId
    ? (brandsList.find((b) => b.id === currentBrandId)?.name
      ?? (brand?.id === currentBrandId ? brand.name : null))
    : null;

  const pickStore = (s: Store) => {
    if (s.id !== currentStore?.id) {
      setCurrentStore(s);
      Toast.show({ type: 'info', text1: T('chrome.phone.storeSwitch.switchedToast', { name: s.name }) });
    }
    setOpen(false);
    onSwitched?.();
  };

  const pickBrand = (brandId: string | null, brandName: string) => {
    if (brandId !== currentBrandId) {
      // Spec 150 — the store OWNS the "does this brand have anything I can
      // open?" decision and reports the brand actually in effect. A diverted
      // pick (requested a brand, got "All brands" back) must not claim a
      // switch that didn't happen, so read the outcome instead of
      // re-deriving the guard's condition here.
      const applied = setCurrentBrandId(brandId);
      const diverted = brandId !== null && applied === null;
      // Two-line shape (text1 + text2, as notifyBackendError uses) because a
      // single line truncates at phone width — verified in the browser.
      Toast.show(
        diverted
          ? {
            type: 'info',
            text1: T('chrome.phone.storeSwitch.brandNoStoresToast', { brand: brandName }),
            text2: T('chrome.phone.storeSwitch.brandNoStoresDetail'),
          }
          : { type: 'info', text1: T('chrome.phone.storeSwitch.brandSwitchedToast') },
      );
    }
    setOpen(false);
    onSwitched?.();
  };

  const chipLabel = currentStore?.name || T('chrome.store');

  return (
    <>
      <TouchableOpacity
        testID="phone-store-chip"
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={T('chrome.phone.storeSwitch.aria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 5,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.borderStrong,
          backgroundColor: C.panel2,
          minHeight: 28,
          maxWidth: 180,
        }}
      >
        <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.fg2 }} numberOfLines={1}>
          {chipLabel}
        </Text>
        <Text style={{ fontFamily: mono(400), fontSize: 9, color: C.fg3 }}>▾</Text>
      </TouchableOpacity>

      <ResponsiveSheet
        visible={open}
        onClose={() => setOpen(false)}
        presentation={{ phone: 'bottom-sheet' }}
        tabletSheetHeight={0.7}
        accessibilityLabel={T('chrome.phone.storeSwitch.title')}
        header={
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: C.border,
            }}
          >
            <Text style={{ fontFamily: mono(600), fontSize: 11, color: C.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {T('chrome.phone.storeSwitch.title')}
            </Text>
            <TouchableOpacity
              testID="phone-store-close"
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={T('common.closeAria')}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={{ width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: mono(400), fontSize: 18, color: C.fg2 }}>✕</Text>
            </TouchableOpacity>
          </View>
        }
      >
        <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
          {accessibleStores.length === 0 ? (
            <View style={{ padding: 28, alignItems: 'center' }}>
              <Text testID="phone-store-empty" style={[PhoneType.body, { color: C.fg3, textAlign: 'center' }]}>
                {activeBrandName
                  ? T('chrome.phone.storeSwitch.emptyInBrand', { brand: activeBrandName })
                  : T('chrome.phone.storeSwitch.empty')}
              </Text>
            </View>
          ) : (
            accessibleStores.map((s) => {
              const isCurrent = s.id === currentStore?.id;
              return (
                <TouchableOpacity
                  key={s.id}
                  testID={`phone-store-row-${s.id}`}
                  onPress={() => pickStore(s)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 56,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    backgroundColor: isCurrent ? C.accentBg : 'transparent',
                    borderBottomWidth: 1,
                    borderBottomColor: C.border,
                  }}
                >
                  <Text style={[PhoneType.itemName, { flex: 1, color: isCurrent ? C.accent : C.fg }]} numberOfLines={1}>
                    {s.name}
                  </Text>
                  {isCurrent ? (
                    <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent, letterSpacing: 0.5 }}>
                      ✓ {T('chrome.phone.storeSwitch.current')}
                    </Text>
                  ) : (
                    <Text style={{ fontFamily: mono(600), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5 }}>
                      {T('chrome.phone.storeSwitch.switch')}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })
          )}

          {isSuperAdmin ? (
            <View style={{ marginTop: 12 }}>
              <Text
                style={[PhoneType.caption, { color: C.fg3, paddingHorizontal: 16, paddingVertical: 8 }]}
              >
                {T('chrome.phone.storeSwitch.brandSection')}
              </Text>
              {[{ id: '__all_brands__', name: T('chrome.phone.storeSwitch.allBrands') }, ...brandsList.map((b) => ({ id: b.id, name: b.name }))].map((b) => {
                const isAll = b.id === '__all_brands__';
                const isCurrent = isAll ? currentBrandId === null : b.id === currentBrandId;
                return (
                  <TouchableOpacity
                    key={b.id}
                    testID={`phone-brand-row-${b.id}`}
                    onPress={() => pickBrand(isAll ? null : b.id, b.name)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: 52,
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      backgroundColor: isCurrent ? C.accentBg : 'transparent',
                      borderBottomWidth: 1,
                      borderBottomColor: C.border,
                    }}
                  >
                    <Text style={[PhoneType.itemName, { flex: 1, color: isCurrent ? C.accent : C.fg }]} numberOfLines={1}>
                      {b.name}
                    </Text>
                    {isCurrent ? (
                      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.accent, letterSpacing: 0.5 }}>
                        ✓ {T('chrome.phone.storeSwitch.current')}
                      </Text>
                    ) : (
                      <Text style={{ fontFamily: mono(600), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5 }}>
                        {T('chrome.phone.storeSwitch.switch')}
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
      </ResponsiveSheet>
    </>
  );
};
