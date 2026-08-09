import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { parsePostalCode } from '../../utils/postalCode';
import type { Store } from '../../types';

/** Spec 155 §5.3 — the saved values, handed to the parent only AFTER the
 *  write resolved successfully so it can patch the row and sequence its
 *  reconciling re-read. Edit mode only. */
export interface StoreFormSavedPatch {
  id: string;
  name: string;
  address: string;
  postalCode: string | null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Required — the new store is created under this brand. */
  brandId: string;
  /** Optional display label for the brand (shown in the drawer chrome). */
  brandName?: string;
  /** Spec 155 — present ⇒ EDIT mode; absent/null ⇒ CREATE mode (unchanged). */
  store?: Store | null;
  /** Spec 155 — edit mode only; fired after a RESOLVED successful write. */
  onSaved?: (patch: StoreFormSavedPatch) => void;
}

// Store drawer used from the Brands section's StoresTab.
//
// CREATE mode (no `store` prop) is the spec-149 shape, unchanged: mirrors
// BrandFormDrawer (right-anchored 480w on desktop, bottom sheet on tablet,
// full-screen on phone); name + address + postal code, with the brand_id
// captive (passed by the parent — required by RLS).
//
// EDIT mode (spec 155 DG-2) reuses the exact same three fields against an
// EXISTING store, because until this spec there was no way to set
// `stores.postal_code` on a store that already existed — only hand-SQL.
// It is deliberately NOT a general store-settings surface: eodDeadlineTime,
// weeklyCountDueDow and brand transfer stay out (brandId is not writable
// through db.updateStore at all — auth_can_see_brand WITH CHECK).
export const StoreFormDrawer: React.FC<Props> = ({
  visible,
  onClose,
  brandId,
  brandName,
  store,
  onSaved,
}) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const addStore = useStore((s) => s.addStore);
  const updateStore = useStore((s) => s.updateStore);
  const isEdit = !!store;
  const [name, setName] = React.useState('');
  const [address, setAddress] = React.useState('');
  // Spec 149 (§7.6) — the store's ZIP, used SERVER-SIDE by the
  // `instacart-cart-link` edge function for the IDP retailer-availability
  // lookup (OQ-2). `address` is free text and is deliberately never parsed for
  // it. Blank ⇒ NULL. Spec 155 demoted that probe to ADVISORY, so a blank ZIP
  // no longer refuses a mint — it only costs the market warning.
  const [postalCode, setPostalCode] = React.useState('');
  const [postalError, setPostalError] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Spec 155 — seed from `store` in edit mode, blank in create mode. `store?.id`
  // joins the dependency array so re-opening the drawer on a DIFFERENT row
  // re-seeds instead of showing the previous row's values.
  React.useEffect(() => {
    if (visible) {
      setName(store?.name ?? '');
      setAddress(store?.address ?? '');
      setPostalCode(store?.postalCode ?? '');
      setPostalError(false);
      setSubmitting(false);
    }
  }, [visible, store?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const requiredValid = name.trim().length > 0;

  const handleSave = async () => {
    if (!requiredValid || submitting) return;
    // Spec 155 AC-3 — ONE shared validator, BOTH paths. An invalid ZIP refuses
    // the save with an inline field error and issues NO write. Deliberately NOT
    // folded into the `n/1 required valid` counter (that string is pinned).
    const zip = parsePostalCode(postalCode);
    if (!zip.ok) {
      setPostalError(true);
      return;
    }
    setPostalError(false);
    setSubmitting(true);
    try {
      if (store) {
        // AC-4 / AC-6 — `updateStore` resolves false after its optimistic
        // revert + notifyBackendError, and NEVER rejects. On failure the drawer
        // stays open with the operator's input intact and no success toast.
        const saved = await updateStore(store.id, {
          name: name.trim(),
          address: address.trim(),
          postalCode: zip.value,
        });
        if (!saved) return;
        Toast.show({ type: 'success', text1: 'Saved store', text2: name.trim() });
        onSaved?.({
          id: store.id,
          name: name.trim(),
          address: address.trim(),
          postalCode: zip.value,
        });
        onClose();
      } else {
        addStore({
          name: name.trim(),
          address: address.trim(),
          postalCode: zip.value,
          brandId,
          status: 'active',
        });
        Toast.show({ type: 'success', text1: 'Created store', text2: name.trim() });
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveRef = React.useRef(handleSave);
  handleSaveRef.current = handleSave;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSaveRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  const header = (
    <View
      style={{
        height: 44,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
        borderBottomColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>
          {isEdit ? 'EDIT' : 'NEW'}
        </Text>
      </View>
      <Text style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }} numberOfLines={1}>
        {isEdit ? store?.name || store?.id : 'new-store'}
      </Text>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.warnBg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.warn }}>● unsaved</Text>
      </View>
      {isPhone ? (
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
          <Text style={{ fontFamily: mono(400), fontSize: 16, color: C.fg2 }}>✕</Text>
        </TouchableOpacity>
      ) : (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
      )}
    </View>
  );

  const footer = (
    <View
      style={{
        minHeight: 54,
        paddingHorizontal: 18,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: C.border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: C.panel,
        flexWrap: 'wrap',
      }}
    >
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {requiredValid ? '1/1 required valid' : '0/1 required valid'}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>CANCEL</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleSave}
        disabled={!requiredValid || submitting}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: requiredValid && !submitting ? C.accent : C.panel2,
          opacity: requiredValid && !submitting ? 1 : 0.6,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid && !submitting ? C.accentFg : C.fg3 }}>
          {submitting ? 'SAVING…' : isEdit ? 'SAVE  ⌘⏎' : 'CREATE  ⌘⏎'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={480}
      tabletSheetHeight={0.5}
      header={header}
      footer={footer}
      accessibilityLabel={isEdit ? 'Edit store' : 'New store'}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View
          style={{
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            padding: 12,
            gap: 2,
          }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Brand
          </Text>
          <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg }}>
            {brandName || brandId}
          </Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Store name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Towson"
            placeholderTextColor={C.fg3}
            autoFocus
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
        </View>

        <View style={{ gap: 4 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Address (optional)
          </Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="e.g. 1234 York Rd, Towson MD 21204"
            placeholderTextColor={C.fg3}
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
        </View>

        {/* Spec 149 — ZIP for the Instacart retailer-availability lookup. Kept
            separate from `address` (free text, never parsed). Blank is fine:
            the store simply has no Instacart channel. */}
        <View style={{ gap: 4 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Postal code (optional)
          </Text>
          <TextInput
            testID="store-postal-code"
            value={postalCode}
            onChangeText={(t) => {
              setPostalCode(t);
              if (postalError) setPostalError(false);
            }}
            placeholder="e.g. 21204"
            placeholderTextColor={C.fg3}
            style={{
              fontFamily: sans(400),
              fontSize: 14,
              color: C.fg,
              backgroundColor: C.panel2,
              borderWidth: 1,
              borderColor: postalError ? C.danger : C.border,
              borderRadius: CmdRadius.sm,
              paddingHorizontal: 10,
              paddingVertical: 9,
              ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
            }}
          />
          {/* Spec 155 AC-3 — inline field error. Hardcoded English to match its
              neighbours in this drawer (no i18n keys here by design). */}
          {postalError ? (
            <Text testID="store-postal-code-error" style={{ fontFamily: sans(400), fontSize: 11.5, color: C.danger }}>
              Enter a 5-digit ZIP (optionally +4), or leave blank.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};
