import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { IngredientForm, IngredientFormValues, blankValues } from './IngredientForm';
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

  // Initial values snapshot — used for dirty-tracking + DISCARD reset.
  const initial = React.useMemo<IngredientFormValues>(
    () => (mode === 'edit' && item ? fromItem(item) : blankValues()),
    [mode, item],
  );
  const [values, setValues] = React.useState<IngredientFormValues>(initial);

  // Reset form when the drawer reopens or the host item changes.
  React.useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

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

  if (!visible) return null;

  const isNew = mode === 'new';
  const title = isNew ? 'untitled-ingredient' : (item?.name || 'ingredient');
  const statusPill = isNew
    ? { label: '● unsaved', fg: C.warn, bg: C.warnBg }
    : dirty
      ? { label: '● modified', fg: C.warn, bg: C.warnBg }
      : { label: '● saved', fg: C.fg3, bg: C.panel2 };

  return (
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
            <IngredientForm mode={mode} values={values} onChange={setValues} autoFocusName={isNew} />
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
            <TouchableOpacity onPress={handleSave} disabled={!requiredValid} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, backgroundColor: requiredValid ? C.accent : C.panel2, opacity: requiredValid ? 1 : 0.6 }}>
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: requiredValid ? '#000' : C.fg3 }}>
                {isNew ? 'CREATE  ⌘⏎' : 'SAVE  ⌘S'}
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};
