import React from 'react';
import { View, Text, TouchableOpacity, Platform, ScrollView } from 'react-native';
// Note: Modal is intentionally not imported — ResponsiveSheet wraps it.
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { IngredientForm, IngredientFormValues, blankValues, vendorRowsToLinkPayload, addVendorLink, derivedUnitCost } from './IngredientForm';
import { VendorFormDrawer } from './VendorFormDrawer';
import { JsonPreview } from './JsonPreview';
import { AuditHistory } from './AuditHistory';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsCompact, useIsPhone } from '../../theme/breakpoints';
import { InventoryItem, LocalizedNames } from '../../types';

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
  // Spec 104 — cost/unit is DERIVED, never hand-entered: always the per-EACH
  // cost = case_price / (case_qty × sub_unit_size) (derivedUnitCost), so it
  // opens showing the formula result rather than a possibly-stale stored scalar.
  costPerUnit: derivedUnitCost(String(it.casePrice || 0), String(it.caseQty || 1), String(it.subUnitSize || 1)),
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
  // Spec 040 P3 — populate translation override fields from the joined
  // catalog i18n_names. Empty strings = no override; silent fallback applies.
  nameEs: it.i18nNames?.es ?? '',
  nameZh: it.i18nNames?.['zh-CN'] ?? '',
  // Spec 102 — hydrate the multi-vendor link rows from the item's
  // `item_vendors` embed. Each row carries its OWN case price; cost/unit is
  // DERIVED (spec 104: per-EACH = case price ÷ (units/case × sub-unit size),
  // never the stored per-vendor scalar). Back-compat: an item with no embed (or
  // a legacy single-vendor row) falls back to a single row synthesized from the
  // scalar vendorId + the item's case price — so it opens showing that one
  // vendor and saves with no drift (AC-C). The PRIMARY pointer stays `vendorId`
  // above; the matching row renders with the "primary" badge.
  vendors:
    it.vendors && it.vendors.length > 0
      ? it.vendors.map((v) => ({
          vendorId: v.vendorId,
          costPerUnit: derivedUnitCost(String(v.casePrice || 0), String(it.caseQty || 1), String(it.subUnitSize || 1)),
          casePrice: v.casePrice ? String(v.casePrice) : '',
          // Spec 114 — hydrate the per-vendor order code from the item_vendors
          // embed (mapItem defaults NULL/absent → ''). Reopening the drawer
          // shows each card's saved code (AC-5).
          orderCode: v.orderCode || '',
        }))
      : it.vendorId
        ? [{
            vendorId: it.vendorId,
            costPerUnit: derivedUnitCost(String(it.casePrice || 0), String(it.caseQty || 1), String(it.subUnitSize || 1)),
            casePrice: it.casePrice ? String(it.casePrice) : '',
            // Spec 114 — a legacy single-vendor item (no embed) has no code
            // until the admin types one.
            orderCode: '',
          }]
        : [],
});

// Spec 040 P3 — build a LocalizedNames map from the form's translation
// overrides. Empty strings are omitted so they don't shadow the silent-
// English fallback with an "empty translation" sentinel.
function buildI18nNames(v: IngredientFormValues): LocalizedNames {
  const out: LocalizedNames = {};
  const es = (v.nameEs ?? '').trim();
  const zh = (v.nameZh ?? '').trim();
  if (es) out.es = es;
  if (zh) out['zh-CN'] = zh;
  return out;
}

// Spec 102 — the return type widens to carry the multi-vendor `vendors`
// link-set payload (the shape db.createInventoryItem / db.updateInventoryItem
// reconcile against item_vendors). `vendors` is ALWAYS present (possibly an
// empty array, which removes all links) so an edit that detaches the last
// vendor is honored — omitting the key would leave the links untouched.
// `Omit<…, 'vendors'>` overrides InventoryItem's `vendors?: ItemVendorLink[]`
// with the db-payload shape (no vendorName/isPrimary — those are derived by
// the db reconcile / next fetch). Without the Omit the intersection would be
// `ItemVendorLink[] & {payload}` (uninhabitable).
type ItemUpdatesWithVendors = Omit<Partial<InventoryItem>, 'vendors'> & {
  // Spec 114 — the link-set payload gains the optional per-vendor `orderCode`
  // (trimmed; empty→undefined→SQL NULL in db.ts). Matches
  // vendorRowsToLinkPayload's return shape and the db create/update `vendors?`
  // payload types.
  vendors: Array<{ vendorId: string; costPerUnit: number; casePrice: number; orderCode?: string }>;
};

const toUpdates = (v: IngredientFormValues): ItemUpdatesWithVendors => ({
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
  // Spec 102 — the multi-vendor link set. Empty-vendorId / sentinel rows are
  // dropped; costs cast to numbers. db reconciles item_vendors: upsert each
  // present link (cost/case_price + is_primary mirror of vendorId), delete
  // links not in this set. An empty array removes ALL links for the item.
  vendors: vendorRowsToLinkPayload(v.vendors),
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
  // Spec 040 P3 — write path for the catalog's i18n_names. Fires on
  // save after the regular updateItem call so the brand-shared
  // translation map persists; setCatalogI18nNames patches both the
  // catalogIngredients slice and any joined inventory rows optimistically.
  const setCatalogI18nNames = useStore((s) => s.setCatalogI18nNames);

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
      // Spec 102 fix — mirror handleAttachVendor: an inline-created vendor must
      // be added to the `values.vendors` link-set ROW LIST, not just the scalar
      // primary pointer. Without this, `toUpdates(values).vendors` stayed `[]`
      // in EDIT mode and `updateInventoryItem` with `vendors: []` DELETED every
      // existing item_vendors link — leaving a dangling scalar vendor_id with
      // zero junction rows (item vanishes from every vendor tab + reorder).
      // Seed the new link's cost/case price from the form's current values
      // (same as handleAttachVendor). `addVendorLink` is idempotent (returns the
      // same array reference when the vendor is already present), so a re-close
      // never double-adds. The scalar still mirrors the new vendor as PRIMARY
      // (SD-1) so the row renders with the "primary" badge.
      setValues((prev) => ({
        ...prev,
        vendors: addVendorLink(prev.vendors, added.id, {
          costPerUnit: prev.costPerUnit,
          casePrice: prev.casePrice,
        }),
        vendorId: added.id,
        vendorName: added.name,
      }));
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
        // Spec 040 P3 — persist the translation overrides on the catalog
        // row. setCatalogI18nNames patches the brand-shared catalog row
        // and all joined inventory rows so list/detail views render the
        // new translations immediately.
        const nextI18n = buildI18nNames(values);
        const prevI18n = catalogRow?.i18nNames ?? {};
        if (JSON.stringify(nextI18n) !== JSON.stringify(prevI18n)) {
          setCatalogI18nNames(catalogId, nextI18n);
        }
      }
      Toast.show({ type: 'success', text1: 'Saved', text2: values.name });
      onClose();
      return;
    }
    // NEW mode — create across one or all stores.
    // "Create at all stores" applies only within the CURRENT brand. RLS
    // already rejects cross-brand inserts on inventory_items, but
    // filtering client-side keeps the loop honest for super-admin users
    // whose `stores` slice spans multiple brands.
    const targets = values.createAtAllStores
      ? stores.filter((s) => s.brandId === currentStore.brandId)
      : [currentStore];
    const i18n = buildI18nNames(values);
    // Spec 102 — `toUpdates` carries the `vendors` link-set payload; pull it
    // out so it's threaded EXPLICITLY through addItem (rather than relying on
    // the spread surviving the `as Omit<InventoryItem,'id'>` cast) and the
    // new item gets its item_vendors links written on create.
    const { vendors: vendorLinks, ...base } = toUpdates(values);
    targets.forEach((s) => {
      addItem({
        ...(base as Omit<InventoryItem, 'id'>),
        currentStock: 0,
        averageDailyUsage: 0,
        safetyStock: 0,
        usagePerPortion: 0,
        lastUpdatedBy: '',
        lastUpdatedAt: new Date().toISOString(),
        eodRemaining: 0,
        storeId: s.id,
        vendorId: values.vendorId || '',
        // Spec 040 P3 — write through; the InventoryItem type carries
        // i18nNames hydrated from the joined catalog row. `db.createInventoryItem`
        // accepts the new field per the backend dev's RPC re-creation
        // (`create_inventory_item_with_catalog` gained a `p_i18n_names`
        // jsonb default '{}' param).
        i18nNames: i18n,
        // Spec 102 — multi-vendor link set for the new item.
        vendors: vendorLinks,
      });
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
