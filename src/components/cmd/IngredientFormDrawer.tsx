import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { IngredientForm, IngredientFormValues, blankValues } from './IngredientForm';
import { VendorFormDrawer } from './VendorFormDrawer';
import { JsonPreview } from './JsonPreview';
import { AuditHistory } from './AuditHistory';
import { InventoryItem } from '../../types';

type Mode = 'edit' | 'new';

interface Props {
  visible: boolean;
  mode: Mode;
  /** EDIT mode: the item to edit. Required when mode='edit'. */
  item?: InventoryItem;
  onClose: () => void;
}

const fromItem = (it: InventoryItem): IngredientFormValues => ({
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
});

// Right-anchored drawer, 760w. Header (mode pill + name + status indicator)
// + body (form + side pane) + footer (DISCARD / SAVE | CREATE).
// Uses Modal with a click-outside backdrop.
export const IngredientFormDrawer: React.FC<Props> = ({ visible, mode, item, onClose }) => {
  const C = useCmdColors();
  const addItem = useStore((s) => s.addItem);
  const updateItem = useStore((s) => s.updateItem);
  const stores = useStore((s) => s.stores);
  const currentStore = useStore((s) => s.currentStore);
  const vendors = useStore((s) => s.vendors);

  // Initial values snapshot — used for dirty-tracking + DISCARD reset.
  const initial = React.useMemo<IngredientFormValues>(
    () => (mode === 'edit' && item ? fromItem(item) : blankValues()),
    [mode, item],
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

  return (
    <>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* Backdrop click-outside */}
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 760, height: '100%', backgroundColor: C.bg, borderLeftWidth: 1, borderLeftColor: C.borderStrong, ...(Platform.OS === 'web' ? ({ boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{isNew ? 'NEW' : 'EDIT'}</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>{title}</Text>
            {!isNew && item ? (
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>· {item.id.slice(0, 11)}</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: statusPill.bg }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: statusPill.fg }}>{statusPill.label}</Text>
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          {/* Body — form + side pane */}
          <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
            <IngredientForm mode={mode} values={values} onChange={setValues} autoFocusName={isNew} onAddVendor={handleAddVendor} />
            {isNew
              ? <JsonPreview values={values} valid={requiredValid} />
              : <AuditHistory itemName={item?.name || ''} />}
          </View>

          {/* Footer */}
          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
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
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
    {/* Inline-add vendor — opened from the form's vendor dropdown's
        "+ new vendor" sentinel. Rendered as a sibling Modal so it stacks
        cleanly on top; on save, handleVendorDrawerClose finds the new
        vendor and auto-selects it. */}
    {vendorDrawerSibling}
    </>
  );
};
