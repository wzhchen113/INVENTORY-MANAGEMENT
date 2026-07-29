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

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../../../theme/colors';
import { mono, PhoneType } from '../../../../theme/typography';
import { useStore } from '../../../../store/useStore';
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

  const isAdmin =
    currentUser?.role === 'admin' ||
    currentUser?.role === 'master' ||
    currentUser?.role === 'super_admin';

  const accessibleStores = React.useMemo(
    () =>
      (isAdmin ? stores : stores.filter((s) => currentUser?.stores?.includes(s.id)))
        .filter((s) => currentBrandId === null || s.brandId === currentBrandId),
    [isAdmin, stores, currentUser, currentBrandId],
  );

  const pickStore = (s: Store) => {
    if (s.id !== currentStore?.id) {
      setCurrentStore(s);
      Toast.show({ type: 'info', text1: T('chrome.phone.storeSwitch.switchedToast', { name: s.name }) });
    }
    setOpen(false);
    onSwitched?.();
  };

  const pickBrand = (brandId: string | null) => {
    if (brandId !== currentBrandId) {
      setCurrentBrandId(brandId);
      Toast.show({ type: 'info', text1: T('chrome.phone.storeSwitch.brandSwitchedToast') });
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
              <Text style={[PhoneType.body, { color: C.fg3, textAlign: 'center' }]}>
                {T('chrome.phone.storeSwitch.empty')}
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
                    onPress={() => pickBrand(isAll ? null : b.id)}
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
