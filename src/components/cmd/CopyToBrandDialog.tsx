import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { copyCatalogRows, CatalogCopyTable, CopyCatalogResult } from '../../lib/db';
import { useT } from '../../hooks/useT';

interface Props {
  visible: boolean;
  /** Brand id of the source — the brand the user is currently viewing. */
  sourceBrandId: string;
  /** Table to copy rows for. Limits the result envelope toast text. */
  table: CatalogCopyTable;
  /** Source-side row ids to copy. */
  sourceIds: string[];
  /** Names of the rows being copied, for the in-dialog preview. The
   *  RPC re-derives names server-side; this is purely UI sugar so the
   *  user sees what they selected without joining back to the source
   *  list. Bounded to ~5 visible + "+ N more" suffix. */
  sourceNames: string[];
  onClose: () => void;
  /** Fires after a successful copy. Caller may clear selection state. */
  onSuccess?: (result: CopyCatalogResult) => void;
}

// Spec 049 — reusable cross-brand copy dialog. Super-admin only at the
// call sites; this component does NOT enforce the role gate itself
// (callers already short-circuit on `useIsSuperAdmin()`).
//
// Shape:
//   - Filename pill header in mono ("copy-to-brand.tsv" idiom)
//   - Subtitle showing the count being copied
//   - Item preview (first 5 names + "+ N more")
//   - Target brand picker: chips of every brand the caller can see,
//     minus the current source brand. Single-select.
//   - Skip-on-conflict caption ("Existing items in the target brand
//     will be skipped.")
//   - Confirm button: disabled until target picked AND not submitting.
//
// Toasts:
//   - Success: "{N} copied, {M} skipped" — same shape across
//     ingredients and vendors. The caller's onSuccess hook may add a
//     section-specific suffix if it wants.
//   - Failure: inline "Copy failed" with the backend message. Pattern
//     mirrors BrandFormDrawer.tsx:53-57.
//
// Per architect §I (Risks): the destination brand may not be in the
// user's currently-loaded scope. We do NOT optimistically update local
// state — the realtime subscriber in the target brand's `brand-{id}`
// channel picks up the new rows after the RPC commits. Cmd UI users
// viewing the source brand see no local change; that's correct.
export const CopyToBrandDialog: React.FC<Props> = ({
  visible,
  sourceBrandId,
  table,
  sourceIds,
  sourceNames,
  onClose,
  onSuccess,
}) => {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  const brandsList = useStore((s) => s.brandsList);
  const loadBrandsList = useStore((s) => s.loadBrandsList);
  const [targetBrandId, setTargetBrandId] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset state on each open so a previous failed attempt doesn't leak.
  React.useEffect(() => {
    if (visible) {
      setTargetBrandId(null);
      setSubmitting(false);
    }
  }, [visible]);

  // Defensive — if the super-admin opens the dialog before brandsList
  // hydrates (e.g., login race), prime the list. The picker is keyed
  // on the live list so it re-renders when the fetch resolves.
  React.useEffect(() => {
    if (visible && brandsList.length === 0) {
      loadBrandsList().catch(() => { /* logged inside */ });
    }
  }, [visible, brandsList.length, loadBrandsList]);

  // Eligible targets = visible-to-caller brands minus the source brand,
  // minus any soft-deleted brand. The visibility filter is enforced
  // server-side too (auth_can_see_brand on both source and target), so
  // this is purely UX — don't show targets the user can't actually use.
  const eligibleBrands = React.useMemo(
    () => brandsList.filter((b) => !b.deletedAt && b.id !== sourceBrandId),
    [brandsList, sourceBrandId],
  );

  const tableLabel = table === 'catalog_ingredients'
    ? T('dialog.copyToBrand.tableIngredients')
    : T('dialog.copyToBrand.tableVendors');

  const handleConfirm = React.useCallback(async () => {
    if (!targetBrandId || submitting || sourceIds.length === 0) return;
    setSubmitting(true);
    try {
      const result = await copyCatalogRows(sourceBrandId, targetBrandId, table, sourceIds);
      Toast.show({
        type: 'success',
        text1: T('dialog.copyToBrand.successToast', {
          copied: result.copied,
          skipped: result.skipped,
        }),
        text2: tableLabel,
      });
      onSuccess?.(result);
      onClose();
    } catch (e: any) {
      Toast.show({
        type: 'error',
        text1: T('dialog.copyToBrand.errorToast'),
        text2: e?.message || 'See console for details.',
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    sourceBrandId, targetBrandId, table, sourceIds, onClose, onSuccess, T, tableLabel, submitting,
  ]);

  // Esc closes, Cmd+Enter confirms when valid. Held in a ref to dodge
  // stale-closure issues — mirrors BrandFormDrawer / TypeToConfirmModal.
  const handleConfirmRef = React.useRef(handleConfirm);
  handleConfirmRef.current = handleConfirm;
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's' || e.key === 'S')) {
        handleConfirmRef.current();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  if (!visible) return null;

  const subtitleKey = table === 'catalog_ingredients'
    ? 'dialog.copyToBrand.subtitleIngredients'
    : 'dialog.copyToBrand.subtitleVendors';
  const subtitle = T(subtitleKey, { count: sourceIds.length });

  const previewNames = sourceNames.slice(0, 5);
  const moreCount = sourceNames.length - previewNames.length;
  const canConfirm = !!targetBrandId && !submitting && sourceIds.length > 0;

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
      <View
        style={{
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: 3,
          backgroundColor: C.accent,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: C.accentFg }}>
          {T('dialog.copyToBrand.headerLabel')}
        </Text>
      </View>
      <Text
        style={{ fontFamily: sans(600), fontSize: 13.5, color: C.fg }}
        numberOfLines={1}
      >
        {T('dialog.copyToBrand.title')}
      </Text>
      <View style={{ flex: 1 }} />
      {isPhone ? (
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
        >
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
        {targetBrandId
          ? T('dialog.copyToBrand.readyToCopy', { count: sourceIds.length })
          : T('dialog.copyToBrand.pickFirst')}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={T('dialog.copyToBrand.cancel')}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: C.border,
        }}
      >
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>
          {T('dialog.copyToBrand.cancel')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleConfirm}
        disabled={!canConfirm}
        accessibilityRole="button"
        accessibilityLabel={T('dialog.copyToBrand.confirm')}
        accessibilityState={{ disabled: !canConfirm }}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: CmdRadius.sm,
          backgroundColor: canConfirm ? C.accent : C.panel2,
          opacity: canConfirm ? 1 : 0.6,
        }}
      >
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 11,
            color: canConfirm ? C.accentFg : C.fg3,
          }}
        >
          {submitting ? T('dialog.copyToBrand.copying') : T('dialog.copyToBrand.confirm')}
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={520}
      tabletSheetHeight={0.7}
      presentation={{ desktop: 'center-modal' }}
      header={header}
      footer={footer}
      accessibilityLabel={T('dialog.copyToBrand.title')}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 22, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Subtitle: count + table */}
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
            {T('dialog.copyToBrand.itemsHeader')}
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 12.5, color: C.fg2, lineHeight: 18 }}>
            {subtitle}
          </Text>
        </View>

        {/* Item preview */}
        {previewNames.length > 0 ? (
          <View
            style={{
              backgroundColor: C.panel2,
              borderRadius: CmdRadius.sm,
              borderWidth: 1,
              borderColor: C.border,
              padding: 12,
              gap: 4,
            }}
          >
            {previewNames.map((name) => (
              <Text
                key={name}
                style={{ fontFamily: mono(400), fontSize: 11.5, color: C.fg2 }}
                numberOfLines={1}
              >
                · {name}
              </Text>
            ))}
            {moreCount > 0 ? (
              <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, marginTop: 4 }}>
                {T('dialog.copyToBrand.moreCount', { count: moreCount })}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Target brand picker */}
        <View style={{ gap: 6 }}>
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {T('dialog.copyToBrand.pickBrandHeader')}
          </Text>
          {eligibleBrands.length === 0 ? (
            <Text style={{ fontFamily: mono(400), fontSize: 11, color: C.fg3, paddingVertical: 6 }}>
              {T('dialog.copyToBrand.noBrandsAvailable')}
            </Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {eligibleBrands.map((b) => {
                const sel = targetBrandId === b.id;
                return (
                  <TouchableOpacity
                    key={b.id}
                    onPress={() => setTargetBrandId(b.id)}
                    accessibilityRole="button"
                    accessibilityLabel={b.name}
                    accessibilityState={{ selected: sel }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: CmdRadius.sm,
                      borderWidth: 1,
                      borderColor: sel ? C.accent : C.border,
                      backgroundColor: sel ? C.accentBg : C.panel2,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: mono(sel ? 700 : 500),
                        fontSize: 11,
                        color: sel ? C.accent : C.fg2,
                      }}
                    >
                      {b.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* Skip-on-conflict notice — fixed copy per spec AC */}
        <View
          style={{
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.sm,
            borderWidth: 1,
            borderColor: C.border,
            padding: 12,
            gap: 4,
          }}
        >
          <Text
            style={{
              fontFamily: mono(700),
              fontSize: 9.5,
              color: C.fg3,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {T('dialog.copyToBrand.skipNoticeHeader')}
          </Text>
          <Text style={{ fontFamily: sans(400), fontSize: 12, color: C.fg2, lineHeight: 18 }}>
            {T('dialog.copyToBrand.skipNotice')}
          </Text>
        </View>
      </ScrollView>
    </ResponsiveSheet>
  );
};
