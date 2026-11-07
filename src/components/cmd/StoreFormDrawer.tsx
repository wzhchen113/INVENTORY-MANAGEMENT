import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { parsePostalCode } from '../../utils/postalCode';
import { plural, type StoreCreatedReport } from '../../utils/stockResult';
import type { StockSourceOption } from '../../lib/db';
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
  /** Spec 184 — create mode only; fired after the insert resolved, and after the
   *  stock run if one was chosen, whether or not that run succeeded (AC-41). */
  onCreated?: (report: StoreCreatedReport) => void;
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
//
// Spec 184 — CREATE mode also asks which store to stock from. The uncarried-rows
// list stays in the STOCK dialog (AC-39), and EDIT mode is unchanged.
export const StoreFormDrawer: React.FC<Props> = ({
  visible,
  onClose,
  brandId,
  brandName,
  store,
  onSaved,
  onCreated,
}) => {
  const C = useCmdColors();
  const isPhone = useIsPhone();
  const addStore = useStore((s) => s.addStore);
  const updateStore = useStore((s) => s.updateStore);
  const loadStoreStockPreview = useStore((s) => s.loadStoreStockPreview);
  const stockStoreFromStore = useStore((s) => s.stockStoreFromStore);
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
  // AC-40 — state only flips on the next render, so a second ⌘⏎ in the same tick
  // would still read `submitting === false` and insert a duplicate store.
  const inFlight = React.useRef(false);
  // Spec 184 AC-38 — `null` is "hasn't chosen", which keeps CREATE disabled.
  const [previewStatus, setPreviewStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [stockSources, setStockSources] = React.useState<StockSourceOption[]>([]);
  const [uncarriedCount, setUncarriedCount] = React.useState(0);
  const [stockChoice, setStockChoice] = React.useState<'none' | string | null>(null);

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

  // Spec 184 AC-38 — create mode only. Edit mode never calls it.
  React.useEffect(() => {
    if (!visible || isEdit) return;
    let cancelled = false;
    setPreviewStatus('loading');
    setStockSources([]);
    setUncarriedCount(0);
    setStockChoice(null);
    loadStoreStockPreview(brandId).then((preview) => {
      if (cancelled) return;
      setStockSources(preview?.sources ?? []);
      setUncarriedCount(preview?.uncarried.length ?? 0);
      setPreviewStatus(preview ? 'ready' : 'failed');
    });
    return () => { cancelled = true; };
  }, [visible, isEdit, brandId, loadStoreStockPreview]);

  // Spec 162 (rev 2) — the ADDRESS is now required, alongside the name. It is
  // the shipping address the cart-filler extension's auto-place picker offers,
  // so a blank one means that store simply cannot be ordered for. The DB backs
  // this with `stores_address_present` (NOT VALID, so pre-existing addressless
  // stores are grandfathered at rest) — which means an EDIT of a grandfathered
  // store would otherwise fail at the constraint with an opaque error. Gating
  // it here turns that into "fill in the address to save", which is the same
  // outcome the operator can actually act on.
  //
  // Spec 184 AC-38 — "Stock from" is a third required field when the brand has a
  // store to copy from. While the list is pending, CREATE stays disabled so a press
  // can't race it, and the footer stays at n/2. A failed read hides the field: it
  // mustn't block creating a store, and STOCK can still run afterward.
  const stockFieldShown = !isEdit && stockSources.length > 0;
  const stockChoiceValid = isEdit
    || previewStatus === 'failed'
    || (previewStatus === 'ready' && (stockSources.length === 0 || stockChoice !== null));
  const requiredValid = name.trim().length > 0 && address.trim().length > 0 && stockChoiceValid;
  const REQUIRED_FIELDS = stockFieldShown ? 3 : 2;
  const requiredDone = [
    name.trim().length > 0,
    address.trim().length > 0,
    ...(stockFieldShown ? [stockChoice !== null] : []),
  ].filter(Boolean).length;

  // AC-43 — a close during an in-flight create would run StoresTab's refresh ahead
  // of the insert. Create mode only: edit mode's close paths are unchanged.
  const close = () => {
    if (!isEdit && inFlight.current) return;
    onClose();
  };
  const closeRef = React.useRef(close);
  closeRef.current = close;

  const handleSave = async () => {
    if (!requiredValid || submitting || inFlight.current) return;
    // Spec 155 AC-3 — ONE shared validator, BOTH paths. An invalid ZIP refuses
    // the save with an inline field error and issues NO write. Deliberately NOT
    // folded into the `n/2 required valid` counter.
    const zip = parsePostalCode(postalCode);
    if (!zip.ok) {
      setPostalError(true);
      return;
    }
    setPostalError(false);
    inFlight.current = true;
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
        // AC-40 — `addStore` resolves null after its own revert + notifyBackendError,
        // and never rejects. On failure the drawer stays open with the input intact
        // and the stock RPC isn't called. The temporary id never reaches this far.
        const storeName = name.trim();
        const id = await addStore({
          name: storeName,
          address: address.trim(),
          postalCode: zip.value,
          brandId,
          status: 'active',
        });
        if (!id) return;
        Toast.show({ type: 'success', text1: 'Created store', text2: storeName });
        const source = stockSources.find((s) => s.storeId === stockChoice) ?? null;
        const result = source ? await stockStoreFromStore(id, source.storeId) : null;
        // AC-41 — the store stays either way, and the drawer closes because a second
        // CREATE would make a duplicate. The result panel says what happened.
        const canStockLater = previewStatus === 'failed' || stockSources.length > 0;
        onCreated?.({
          storeId: id,
          storeName,
          sourceName: source?.name ?? null,
          result,
          stockFailed: !!source && !result,
          canStockLater,
          uncarriedCount: result ? result.uncarriedRemaining : uncarriedCount,
        });
        onClose();
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const handleSaveRef = React.useRef(handleSave);
  handleSaveRef.current = handleSave;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeRef.current(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSaveRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible]);

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
        <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={6}>
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
        {`${requiredDone}/${REQUIRED_FIELDS} required valid`}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={close}
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
      onClose={close}
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
            Address
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

        {/* Spec 184 AC-38 — no store is preselected, so the admin has to choose. */}
        {stockFieldShown ? (
          <View testID="store-stock-from" style={{ gap: 6 }}>
            <Text
              style={{
                fontFamily: mono(700),
                fontSize: 9.5,
                color: C.fg3,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              Stock from
            </Text>
            {[
              ...stockSources.map((s) => ({
                key: s.storeId,
                label: s.name,
                detail: plural(s.itemCount, 'item'),
                // Same marker the STOCK dialog shows, so an inactive source isn't
                // picked by mistake.
                inactive: s.status !== 'active',
              })),
              { key: 'none', label: 'Don’t stock yet', detail: '', inactive: false },
            ].map((option) => {
              const selected = stockChoice === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  testID={`store-stock-from-${option.key}`}
                  onPress={() => setStockChoice(option.key)}
                  disabled={submitting}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  accessibilityLabel={
                    [option.label, option.inactive ? 'inactive' : '', option.detail].filter(Boolean).join(', ')
                  }
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    borderRadius: CmdRadius.sm,
                    borderWidth: 1,
                    borderColor: selected ? C.accent : C.border,
                    backgroundColor: selected ? C.accentBg : C.panel2,
                  }}
                >
                  <View
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: selected ? C.accent : C.borderStrong,
                      backgroundColor: selected ? C.accent : 'transparent',
                    }}
                  />
                  <Text style={{ fontFamily: sans(600), fontSize: 13, color: C.fg, flex: 1 }} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.inactive ? (
                    <Text
                      testID={`store-stock-from-${option.key}-inactive`}
                      style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3 }}
                    >
                      INACTIVE
                    </Text>
                  ) : null}
                  {option.detail ? (
                    <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg2 }}>{option.detail}</Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
            <Text style={{ fontFamily: sans(400), fontSize: 11.5, color: C.fg3 }}>
              Copies the items that store carries, with their par, cost and vendor links. Stock starts at
              0. Other stores may carry items it doesn’t, and STOCK can add those afterward.
            </Text>
          </View>
        ) : null}
        {!isEdit && previewStatus === 'failed' ? (
          <Text testID="store-stock-preview-failed" style={{ fontFamily: sans(400), fontSize: 11.5, color: C.warn }}>
            Could not load the stores to stock from. Create this store, then use STOCK on its row.
          </Text>
        ) : null}
      </ScrollView>
    </ResponsiveSheet>
  );
};
