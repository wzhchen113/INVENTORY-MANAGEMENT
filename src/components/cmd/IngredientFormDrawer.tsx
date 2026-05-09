import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
// Note: Modal is intentionally not imported — ResponsiveSheet wraps it.
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { IngredientForm, IngredientFormValues, blankValues } from './IngredientForm';
import { VendorFormDrawer } from './VendorFormDrawer';
import { JsonPreview } from './JsonPreview';
import { AuditHistory } from './AuditHistory';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsCompact, useIsPhone } from '../../theme/breakpoints';
import { InventoryItem } from '../../types';

type Mode = 'edit' | 'new';

interface Props {
  visible: boolean;
  mode: Mode;
  /** EDIT mode: the item to edit. Required when mode='edit'. */
  item?: InventoryItem;
  onClose: () => void;
}

// Spec 010 §6 — `defaultShelfLifeDays` is brand-level (catalog_ingredients);
// callers must resolve it via the InventoryItem.catalogId → catalog row
// lookup. Pass through here so the drawer can populate the form on edit.
const fromItem = (it: InventoryItem, defaultShelfLifeDays: number | null | undefined): IngredientFormValues => ({
  ...blankValues(),
  name: it.name,
  category: it.category,
  unit: it.unit,
  costPerUnit: it.costPerUnit ? String(it.costPerUnit) : '',
  parLevel: it.parLevel != null ? String(it.parLevel) : '',
  vendorName: it.vendorName || '',
  vendorId: it.vendorId || '',
  caseQty: String(it.caseQty || 1),
  casePrice: String(it.casePrice || 0),
  subUnitSize: String(it.subUnitSize || 1),
  subUnitUnit: it.subUnitUnit || '',
  sku: it.id.slice(0, 11), // STUB until real sku column lands; show item id prefix
  // Spec 010 — expiry fields. defaultShelfLifeDays from catalog row;
  // expiryDate from the inventory_items row.
  defaultShelfLifeDays:
    defaultShelfLifeDays == null ? '' : String(defaultShelfLifeDays),
  expiryDate: it.expiryDate || '',
});

const toUpdates = (v: IngredientFormValues): Partial<InventoryItem> => ({
  name: v.name,
  category: v.category,
  unit: v.unit,
  costPerUnit: parseFloat(v.costPerUnit) || 0,
  parLevel: parseFloat(v.parLevel) || 0,
  // vendorId is the source of truth (drives FK joins); vendorName is
  // derived from the picked vendor and stays in sync for legacy display.
  vendorId: v.vendorId,
  vendorName: v.vendorName,
  caseQty: parseFloat(v.caseQty) || 1,
  casePrice: parseFloat(v.casePrice) || 0,
  subUnitSize: parseFloat(v.subUnitSize) || 1,
  subUnitUnit: v.subUnitUnit,
  // Spec 010 §6 — per-row expiry override. Empty input must clear the
  // column, so coalesce to null (undefined would be skipped by the PATCH
  // mapper in db.ts and silently keep the old value).
  expiryDate: v.expiryDate || null,
});

// Spec 011 — drawer adapts via `ResponsiveSheet`:
//   - desktop: right-anchored 760w drawer (pre-Spec-011 behavior)
//   - tablet : bottom sheet @ 85% viewport
//   - phone  : full-screen modal
// On compact tiers (phone/tablet) the form body flips to a vertical
// stack and the side pane (JsonPreview / AuditHistory) is suppressed
// on phone — it's a power-user assist that doesn't fit thumb width.
export const IngredientFormDrawer: React.FC<Props> = ({ visible, mode, item, onClose }) => {
  const C = useCmdColors();
  const isCompact = useIsCompact();
  const isPhone = useIsPhone();
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const vendors = useStore((s) => s.vendors);
  // Spec 010 §6 — catalog read for defaultShelfLifeDays population on edit,
  // and write path for save.
  const catalogIngredients = useStore((s) => s.catalogIngredients);
  const updateCatalogIngredient = useStore((s) => s.updateCatalogIngredient);

  // Resolve the ingredient's catalog row up front so fromItem() can hydrate
  // defaultShelfLifeDays. Recomputes when item changes.
  const catalogRow = React.useMemo(
    () => (item ? catalogIngredients.find((c) => c.id === item.catalogId) : undefined),
    [catalogIngredients, item],
  );

  // Initial values snapshot — used for dirty-tracking + DISCARD reset.
  const initial = React.useMemo<IngredientFormValues>(
    () =>
      mode === 'edit' && item
        ? fromItem(item, catalogRow?.defaultShelfLifeDays ?? null)
        : blankValues(),
    [mode, item, catalogRow],
  );
  const [values, setValues] = React.useState<IngredientFormValues>(initial);
  const [vendorDrawerOpen, setVendorDrawerOpen] = React.useState(false);
  const vendorIdsBeforeAddRef = React.useRef<Set<string>>(new Set());

  // Reset form when the drawer reopens or the host item changes.
  React.useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

  // Inline vendor-add: when the form's "+ new vendor" sentinel fires,
  // snapshot the current vendor ids, open the VendorFormDrawer. When the
  // drawer closes, find the newly-added vendor (id not in the snapshot)
  // and auto-select it.
  const handleAddVendor = React.useCallback(() => {
    vendorIdsBeforeAddRef.current = new Set(vendors.map((v) => v.id));
    setVendorDrawerOpen(true);
  }, [vendors]);

  const handleVendorDrawerClose = React.useCallback(() => {
    setVendorDrawerOpen(false);
    // Find the vendor whose id wasn't in the snapshot. If found, auto-select.
    const added = vendors.find((v) => !vendorIdsBeforeAddRef.current.has(v.id));
    if (added) {
      setValues((prev) => ({ ...prev, vendorId: added.id, vendorName: added.name }));
    }
  }, [vendors]);

  const dirty = React.useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const requiredValid = values.name.trim().length > 0 && values.category.trim().length > 0 && values.unit.trim().length > 0;

  const handleSave = () => {
    if (!requiredValid) {
      Toast.show({ type: 'error', text1: 'Required field missing', text2: 'Name, category, and unit are required' });
      return;
    }
    if (mode === 'edit' && item) {
      updateItem(item.id, toUpdates(values));
      // Spec 010 §6 — brand-level catalog write for defaultShelfLifeDays.
      // Only fires when (a) we know the catalog id and (b) the value
      // changed. parseInt('') is NaN → coerce to null. Empty input clears
      // the brand-wide default.
      const catalogId = item.catalogId;
      if (catalogId) {
        const parsed = parseInt(values.defaultShelfLifeDays, 10);
        const newShelf: number | null =
          values.defaultShelfLifeDays.trim() === '' || Number.isNaN(parsed) ? null : parsed;
        const oldShelf =
          catalogRow?.defaultShelfLifeDays == null ? null : Number(catalogRow.defaultShelfLifeDays);
        if (newShelf !== oldShelf) {
          updateCatalogIngredient(catalogId, { defaultShelfLifeDays: newShelf });
        }
      }
      Toast.show({ type: 'success', text1: 'Saved', text2: values.name });
      onClose();
      return;
    }
    // NEW mode — create across one or all stores
    const targets = values.createAtAllStores ? stores : [currentStore];
    targets.forEach((s) => {
      addItem({
        ...toUpdates(values) as Omit<InventoryItem, 'id'>,
        currentStock: 0,
        averageDailyUsage: 0,
        safetyStock: 0,
        usagePerPortion: 0,
        lastUpdatedBy: '',
        lastUpdatedAt: new Date().toISOString(),
        eodRemaining: 0,
        storeId: s.id,
        vendorId: values.vendorId || '',
      } as Omit<InventoryItem, 'id'>);
    });
    Toast.show({ type: 'success', text1: targets.length > 1 ? `Created at ${targets.length} stores` : 'Created', text2: values.name });
    onClose();
  };

  const handleDiscard = () => {
    setValues(initial);
    onClose();
  };

  // Keyboard: Cmd+S / Cmd+Enter saves, Esc closes
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSave();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, values, mode, item]);

  // Render the inline VendorFormDrawer as a sibling so it stacks on top
  // of (rather than inside) the ingredient drawer's Modal — avoids
  // backdrop-click-out / z-index battles on web. The vendor drawer keeps
  // visible=false until the form's "+ new vendor" sentinel fires.
  const vendorDrawerSibling = (
    <VendorFormDrawer
      visible={vendorDrawerOpen}
      mode="new"
      onClose={handleVendorDrawerClose}
    />
  );

  if (!visible) return vendorDrawerSibling;

  const isNew = mode === 'new';
  const title = isNew ? 'untitled-ingredient' : (item?.name || 'ingredient');
  const statusPill = isNew
    ? { label: '● unsaved', fg: C.warn, bg: C.warnBg }
    : dirty
      ? { label: '● modified', fg: C.warn, bg: C.warnBg }
      : { label: '● saved', fg: C.fg3, bg: C.panel2 };

  // Header / footer JSX — passed as ResponsiveSheet slots so they sit
  // sticky above/below the scrollable body on every tier.
  const header = (
    <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{isNew ? 'NEW' : 'EDIT'}</Text>
      </View>
      <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }} numberOfLines={1}>{title}</Text>
      {!isNew && item ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>· {item.id.slice(0, 11)}</Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: statusPill.bg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: statusPill.fg }}>{statusPill.label}</Text>
      </View>
      {/* Phone has no Esc key — show an explicit ✕ close affordance.
          Desktop/tablet keep the "esc" hint since the keydown handler
          fires for them. */}
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
    <View style={{ minHeight: 54, paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel, flexWrap: 'wrap' }}>
      <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
        {isNew
          ? `${requiredValid ? '3/3' : '0/3'} required valid · creates audit entry`
          : (dirty ? 'unsaved changes' : 'no changes')}
      </Text>
      <View style={{ flex: 1 }} />
      <TouchableOpacity onPress={handleDiscard} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg2 }}>{isNew ? 'CANCEL' : 'DISCARD'}</Text>
      </TouchableOpacity>
      {/* SAVE is always enabled; required-field validation runs
          inside `handleSave` and surfaces a Toast on miss. The "0/3
          required valid" footer text below already communicates
          form state — spec 004 fix-pass item 2. */}
      <TouchableOpacity onPress={handleSave} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 11, color: '#000' }}>
          {isNew ? 'CREATE  ⌘⏎' : 'SAVE  ⌘S'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  // Body — form + side pane. On compact tiers stack vertically; on
  // phone hide the side pane entirely (it's a power-user assist that
  // doesn't fit thumb width). On tablet bottom-sheet, the side pane
  // drops below the form so the user can scroll down to it.
  const sidePane = isPhone
    ? null
    : isNew
      ? <JsonPreview values={values} valid={requiredValid} />
      : <AuditHistory itemName={item?.name || ''} />;

  const body = isCompact ? (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flexDirection: 'column', gap: 0 }}>
        <IngredientForm mode={mode} values={values} onChange={setValues} autoFocusName={isNew} onAddVendor={handleAddVendor} />
        {sidePane}
      </View>
    </ScrollView>
  ) : (
    <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
      <IngredientForm mode={mode} values={values} onChange={setValues} autoFocusName={isNew} onAddVendor={handleAddVendor} />
      {sidePane}
    </View>
  );

  return (
    <>
      <ResponsiveSheet
        visible={visible}
        onClose={onClose}
        desktopWidth={760}
        header={header}
        footer={footer}
        accessibilityLabel={isNew ? 'New ingredient' : 'Edit ingredient'}
      >
        {body}
      </ResponsiveSheet>
      {/* Inline-add vendor — opened from the form's vendor dropdown's
          "+ new vendor" sentinel. Rendered as a sibling so it stacks
          cleanly on top; on save, handleVendorDrawerClose finds the new
          vendor and auto-selects it. */}
      {vendorDrawerSibling}
    </>
  );
};
