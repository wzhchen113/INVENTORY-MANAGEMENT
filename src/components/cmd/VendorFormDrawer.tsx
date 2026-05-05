import React from 'react';
import { View, Text, TouchableOpacity, Modal, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { Vendor } from '../../types';

type Mode = 'edit' | 'new';

interface Props {
  visible: boolean;
  mode: Mode;
  vendor?: Vendor;
  onClose: () => void;
}

interface FormValues {
  name: string;
  contactName: string;
  phone: string;
  email: string;
  accountNumber: string;
  leadTimeDays: string;
  categories: string;        // comma-separated
  deliveryDays: string;      // space-separated days
  orderCutoffTime: string;   // HH:MM
  eodDeadlineTime: string;   // HH:MM
}

const blank = (): FormValues => ({
  name: '',
  contactName: '',
  phone: '',
  email: '',
  accountNumber: '',
  leadTimeDays: '1',
  categories: '',
  deliveryDays: '',
  orderCutoffTime: '',
  eodDeadlineTime: '',
});

const fromVendor = (v: Vendor): FormValues => ({
  name: v.name,
  contactName: v.contactName || '',
  phone: v.phone || '',
  email: v.email || '',
  accountNumber: v.accountNumber || '',
  leadTimeDays: String(v.leadTimeDays ?? 1),
  categories: (v.categories || []).join(', '),
  deliveryDays: (v.deliveryDays || []).join(' '),
  orderCutoffTime: v.orderCutoffTime || '',
  eodDeadlineTime: v.eodDeadlineTime || '',
});

const toUpdates = (v: FormValues): Partial<Vendor> => ({
  name: v.name.trim(),
  contactName: v.contactName.trim(),
  phone: v.phone.trim(),
  email: v.email.trim(),
  accountNumber: v.accountNumber.trim(),
  leadTimeDays: parseInt(v.leadTimeDays, 10) || 1,
  categories: v.categories.split(',').map((s) => s.trim()).filter(Boolean),
  deliveryDays: v.deliveryDays.split(/\s+/).map((s) => s.trim()).filter(Boolean),
  orderCutoffTime: v.orderCutoffTime.trim() || undefined,
  eodDeadlineTime: v.eodDeadlineTime.trim() || undefined,
});

// ─── Form field row ────────────────────────────────────────────
function Field({
  label, hint, value, onChange, placeholder, autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</Text>
        {hint ? <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>· {hint}</Text> : null}
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.fg3}
        autoFocus={autoFocus}
        style={{
          fontFamily: sans(400),
          fontSize: 13,
          color: C.fg,
          backgroundColor: C.panel2,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: CmdRadius.sm,
          paddingHorizontal: 10,
          paddingVertical: 7,
          ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
        }}
      />
    </View>
  );
}

// ─── VendorFormDrawer ──────────────────────────────────────────
// Right-anchored 540w drawer. NEW: brand-scoped vendor with categories/
// schedule. EDIT: prefilled from selected vendor. Save → addVendor or
// updateVendor in the store.
export const VendorFormDrawer: React.FC<Props> = ({ visible, mode, vendor, onClose }) => {
  const C = useCmdColors();
  const addVendor = useStore((s) => s.addVendor);
  const updateVendor = useStore((s) => s.updateVendor);

  const initial = React.useMemo<FormValues>(
    () => (mode === 'edit' && vendor ? fromVendor(vendor) : blank()),
    [mode, vendor],
  );
  const [values, setValues] = React.useState<FormValues>(initial);

  React.useEffect(() => {
    if (visible) setValues(initial);
  }, [visible, initial]);

  const dirty = React.useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const requiredValid = values.name.trim().length > 0;

  const handleSave = () => {
    if (!requiredValid) {
      Toast.show({ type: 'error', text1: 'Name is required' });
      return;
    }
    if (mode === 'edit' && vendor) {
      updateVendor(vendor.id, toUpdates(values));
      Toast.show({ type: 'success', text1: 'Saved', text2: values.name });
    } else {
      addVendor({
        ...toUpdates(values),
        brandId: '',
      } as Omit<Vendor, 'id'>);
      Toast.show({ type: 'success', text1: 'Created', text2: values.name });
    }
    onClose();
  };

  const set = (k: keyof FormValues) => (v: string) => setValues((p) => ({ ...p, [k]: v }));

  // Cmd+S / Cmd+Enter saves, Esc closes
  React.useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); e.preventDefault(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
        handleSave();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, values, mode, vendor]);

  if (!visible) return null;

  const isNew = mode === 'new';
  const title = isNew ? 'untitled-vendor' : (vendor?.name || 'vendor');
  const statusPill = isNew
    ? { label: '● unsaved', fg: C.warn, bg: C.warnBg }
    : dirty
      ? { label: '● modified', fg: C.warn, bg: C.warnBg }
      : { label: '● saved', fg: C.fg3, bg: C.panel2 };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', flexDirection: 'row', justifyContent: 'flex-end' }}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={{ width: 540, height: '100%', backgroundColor: C.bg, borderLeftWidth: 1, borderLeftColor: C.borderStrong, ...(Platform.OS === 'web' ? ({ boxShadow: '-12px 0 40px rgba(0,0,0,0.18)' } as any) : {}) }}>
          {/* Header */}
          <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
              <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{isNew ? 'NEW' : 'EDIT'}</Text>
            </View>
            <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }}>{title}</Text>
            {!isNew && vendor ? (
              <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>· {vendor.id.slice(0, 11)}</Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: statusPill.bg }}>
              <Text style={{ fontFamily: mono(400), fontSize: 10, color: statusPill.fg }}>{statusPill.label}</Text>
            </View>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>esc</Text>
          </View>

          {/* Body */}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 22, gap: 14 }}>
            <Field label="Name" value={values.name} onChange={set('name')} placeholder="BJs Wholesale" autoFocus={isNew} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field label="Contact" value={values.contactName} onChange={set('contactName')} placeholder="Jane Doe" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Phone" value={values.phone} onChange={set('phone')} placeholder="(555) 555-1212" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field label="Email" value={values.email} onChange={set('email')} placeholder="orders@vendor.com" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Account #" value={values.accountNumber} onChange={set('accountNumber')} placeholder="A12345" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field label="Lead time" hint="days" value={values.leadTimeDays} onChange={set('leadTimeDays')} placeholder="1" />
              </View>
              <View style={{ flex: 2 }}>
                <Field label="Categories" hint="comma-separated" value={values.categories} onChange={set('categories')} placeholder="Produce, Dairy, Dry Goods" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field label="Order cutoff" hint="HH:MM" value={values.orderCutoffTime} onChange={set('orderCutoffTime')} placeholder="14:00" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="EOD deadline" hint="HH:MM" value={values.eodDeadlineTime} onChange={set('eodDeadlineTime')} placeholder="22:00" />
              </View>
            </View>
            <Field label="Delivery days" hint="space-separated" value={values.deliveryDays} onChange={set('deliveryDays')} placeholder="Mon Wed Fri" />
          </ScrollView>

          {/* Footer */}
          <View style={{ height: 54, paddingHorizontal: 18, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
              {isNew ? `${requiredValid ? '1/1' : '0/1'} required valid` : (dirty ? 'unsaved changes' : 'no changes')}
            </Text>
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: CmdRadius.sm, borderWidth: 1, borderColor: C.border }}>
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
