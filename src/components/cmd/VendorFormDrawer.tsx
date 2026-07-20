import React from 'react';
import { View, Text, TouchableOpacity, Platform, TextInput, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono, sans } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { ResponsiveSheet } from './ResponsiveSheet';
import { useIsPhone } from '../../theme/breakpoints';
import { useT } from '../../hooks/useT';
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
  // Spec 115 (W-2) — the vendor's quick-order counting unit. 'case' (default) →
  // the quick-order builder divides counted units by the item's case_qty and
  // rounds UP to whole cases; 'unit' → counted units verbatim. Held as the total
  // union directly (not a free-text string) since the control can only emit these.
  orderUnit: 'case' | 'unit';
  // Spec 131 — per-vendor opt-in for the browser-extension cart-filler (spec 132)
  // + the vendor's order page URL. The toggle emits the boolean directly; the URL
  // is a free-text field (empty → clears to NULL on save).
  extensionOrdering: boolean;
  orderPageUrl: string;
  // 2026-07 — vendor-specific "Import Order" file export. '' = none (generic
  // reorder export only), 'us_foods' = US Foods CSV, 'sysco' = SYSCO H/F/P file.
  // Per-store CUSTOMER NUMBER feeds both; distributor/department are US-Foods-only.
  orderImportFormat: '' | 'us_foods' | 'sysco';
  importDistributorNumber: string;
  importDepartment: string;
  // Per-store US Foods customer number, keyed by store id.
  importCustomerNumbers: Record<string, string>;
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
  orderUnit: 'case', // R-2 — 'case' is the safe default on a new vendor.
  extensionOrdering: false, // Spec 131 — opt-in is OFF by default.
  orderPageUrl: '',
  orderImportFormat: '',
  importDistributorNumber: '',
  importDepartment: '',
  importCustomerNumbers: {},
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
  orderUnit: v.orderUnit ?? 'case', // defensive default for a pre-migration row.
  extensionOrdering: v.extensionOrdering ?? false, // Spec 131 — defensive default.
  orderPageUrl: v.orderPageUrl || '',
  orderImportFormat:
    v.orderImportFormat === 'us_foods' || v.orderImportFormat === 'sysco' ? v.orderImportFormat : '',
  importDistributorNumber: v.importDistributorNumber || '',
  importDepartment: v.importDepartment || '',
  importCustomerNumbers: { ...(v.importCustomerNumbers || {}) },
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
  orderUnit: v.orderUnit,
  extensionOrdering: v.extensionOrdering, // Spec 131 — persists via createVendor / updateVendor.
  orderPageUrl: v.orderPageUrl.trim(),
  orderImportFormat: v.orderImportFormat,
  importDistributorNumber: v.importDistributorNumber.trim(),
  importDepartment: v.importDepartment.trim(),
  // Drop blank per-store entries so an emptied input clears that store's number.
  importCustomerNumbers: Object.fromEntries(
    Object.entries(v.importCustomerNumbers)
      .map(([k, val]) => [k, (val || '').trim()])
      .filter(([, val]) => val.length > 0),
  ),
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

// ─── Segmented control (two options) ───────────────────────────
// Spec 115 (W-2) — the order-unit control. Same label idiom as `Field` (uppercase
// mono caption + hint) with a two-button segment underneath; the selected option
// gets the accent treatment. Generic over a two-value union.
function SegmentField<T extends string>({
  label, hint, value, options, onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</Text>
        {hint ? <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>· {hint}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <TouchableOpacity
              key={o.value}
              testID={`vendor-order-unit-${o.value}`}
              onPress={() => onChange(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: on ? C.accent : C.border,
                backgroundColor: on ? C.accentBg : C.panel2,
                alignItems: 'center',
              }}
            >
              <Text style={{ fontFamily: mono(on ? 700 : 500), fontSize: 12, color: on ? C.accent : C.fg2 }}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─── Toggle control (boolean) ──────────────────────────────────
// Spec 131 — the extension-ordering opt-in. Same label idiom as `Field` /
// `SegmentField` (uppercase mono caption + hint) with a pill toggle underneath.
function ToggleField({
  label, hint, value, onChange, testID,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID?: string;
}) {
  const C = useCmdColors();
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</Text>
        {hint ? <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>· {hint}</Text> : null}
      </View>
      <TouchableOpacity
        testID={testID}
        onPress={() => onChange(!value)}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        style={{
          alignSelf: 'flex-start',
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: CmdRadius.sm,
          borderWidth: 1,
          borderColor: value ? C.accent : C.border,
          backgroundColor: value ? C.accentBg : C.panel2,
        }}
      >
        <Text style={{ fontFamily: mono(value ? 700 : 500), fontSize: 12, color: value ? C.accent : C.fg2 }}>
          {value ? 'ON' : 'OFF'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── VendorFormDrawer ──────────────────────────────────────────
// Spec 011 — drawer adapts via `ResponsiveSheet`:
//   - desktop: right-anchored 540w drawer (pre-Spec-011 behavior)
//   - tablet : bottom sheet @ 85% viewport
//   - phone  : full-screen modal
// NEW: brand-scoped vendor with categories/schedule. EDIT: prefilled
// from selected vendor. Save → addVendor or updateVendor in the store.
export const VendorFormDrawer: React.FC<Props> = ({ visible, mode, vendor, onClose }) => {
  const C = useCmdColors();
  const T = useT();
  const isPhone = useIsPhone();
  const addVendor = useStore((s) => s.addVendor);
  const updateVendor = useStore((s) => s.updateVendor);
  // Stores in THIS vendor's brand — for the per-store US Foods customer-number
  // inputs. In 'new' mode the vendor has no brandId yet, so the list is empty
  // and the section is hidden until the vendor is saved.
  const allStores = useStore((s) => s.stores);
  const brandStores = React.useMemo(
    () => (vendor?.brandId ? (allStores || []).filter((s) => s.brandId === vendor.brandId) : []),
    [allStores, vendor?.brandId],
  );

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

  const header = (
    <View style={{ height: 44, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.panel }}>
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accent }}>
        <Text style={{ fontFamily: mono(700), fontSize: 10, color: '#000' }}>{isNew ? 'NEW' : 'EDIT'}</Text>
      </View>
      <Text style={{ fontWeight: '600', fontSize: 13.5, color: C.fg }} numberOfLines={1}>{title}</Text>
      {!isNew && vendor ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }} numberOfLines={1}>· {vendor.id.slice(0, 11)}</Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, backgroundColor: statusPill.bg }}>
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: statusPill.fg }}>{statusPill.label}</Text>
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
    <View style={{ minHeight: 54, paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.panel, flexWrap: 'wrap' }}>
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
  );

  return (
    <ResponsiveSheet
      visible={visible}
      onClose={onClose}
      desktopWidth={540}
      header={header}
      footer={footer}
      accessibilityLabel={isNew ? 'New vendor' : 'Edit vendor'}
    >
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
        {/* Spec 115 (W-2) — per-vendor quick-order counting unit. 'case' default
            (R-2). The quick-order builder divides counted units into whole cases
            for a 'case' vendor; a 'unit' vendor pastes counted units verbatim. */}
        <SegmentField<'case' | 'unit'>
          label={T('section.vendors.orderUnitLabel')}
          hint={T('section.vendors.orderUnitHint')}
          value={values.orderUnit}
          options={[
            { value: 'case', label: T('section.vendors.orderUnitCase') },
            { value: 'unit', label: T('section.vendors.orderUnitUnit') },
          ]}
          onChange={(v) => setValues((p) => ({ ...p, orderUnit: v }))}
        />
        {/* Spec 131 — browser-extension cart-filler opt-in (spec 132). ON → this
            vendor's draft POs are picked up by the extension. The order page URL
            is where the extension lands (BJ's / Sam's). */}
        <ToggleField
          testID="vendor-extension-ordering-toggle"
          label={T('section.vendors.extensionOrderingLabel')}
          hint={T('section.vendors.extensionOrderingHelp')}
          value={values.extensionOrdering}
          onChange={(v) => setValues((p) => ({ ...p, extensionOrdering: v }))}
        />
        {values.extensionOrdering ? (
          <Field
            label={T('section.vendors.orderPageUrlLabel')}
            hint={T('section.vendors.orderPageUrlHelp')}
            value={values.orderPageUrl}
            onChange={set('orderPageUrl')}
            placeholder="https://www.samsclub.com/orders"
          />
        ) : null}
        {/* 2026-07 — vendor-specific "Import Order" file export. 'US Foods' /
            'SYSCO' unlock the per-store CUSTOMER NUMBER inputs; US Foods also
            has DISTRIBUTOR / DEPARTMENT (division-level). When set, the reorder
            CSV button emits this vendor's Import-Order file instead of the
            generic CSV. */}
        <SegmentField<'' | 'us_foods' | 'sysco'>
          label={T('section.vendors.importFormatLabel')}
          hint={T('section.vendors.importFormatHint')}
          value={values.orderImportFormat}
          options={[
            { value: '', label: T('section.vendors.importFormatNone') },
            { value: 'us_foods', label: T('section.vendors.importFormatUsFoods') },
            { value: 'sysco', label: T('section.vendors.importFormatSysco') },
          ]}
          onChange={(v) => setValues((p) => ({ ...p, orderImportFormat: v }))}
        />
        {values.orderImportFormat !== '' ? (
          <>
            {values.orderImportFormat === 'us_foods' ? (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Field label={T('section.vendors.importDistributor')} hint="US Foods" value={values.importDistributorNumber} onChange={set('importDistributorNumber')} placeholder="4147" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label={T('section.vendors.importDepartment')} value={values.importDepartment} onChange={set('importDepartment')} placeholder="0" />
                </View>
              </View>
            ) : null}
            {brandStores.length > 0 ? (
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                  <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{T('section.vendors.importCustomerByStore')}</Text>
                  <Text style={{ fontFamily: mono(400), fontSize: 9.5, color: C.fg3 }}>· {T('section.vendors.importCustomerHint')}</Text>
                </View>
                {brandStores.map((s) => (
                  <Field
                    key={s.id}
                    label={s.name}
                    value={values.importCustomerNumbers[s.id] || ''}
                    onChange={(val) =>
                      setValues((p) => ({ ...p, importCustomerNumbers: { ...p.importCustomerNumbers, [s.id]: val } }))
                    }
                    placeholder="12345678"
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </ResponsiveSheet>
  );
};
