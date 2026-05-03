import React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';

// Form values held by IngredientFormDrawer. A subset persists to
// inventory_items today — fields commented `STUB` are read-only displays
// awaiting a schema migration (see Phase 12 plan, "Stub at component layer"
// decision). Adding a field on this type adds it on both EDIT and + NEW.
export interface IngredientFormValues {
  // Bound to inventory_items columns
  name: string;
  category: string;
  unit: string;
  costPerUnit: string;       // text for input control; cast to number on save
  parLevel: string;
  vendorName: string;
  vendorId: string;
  caseQty: string;
  casePrice: string;
  subUnitSize: string;
  subUnitUnit: string;
  // STUB — no DB column yet; surfaced read-only or as labels
  sku: string;
  packSize: string;
  packUnit: string;
  altUnits: string;
  reorderPoint: string;
  max: string;
  vendorSku: string;
  countNightly: boolean;
  trackWaste: boolean;
  allowSubstitute: boolean;
  // Multi-store create-time toggle (NEW mode only)
  createAtAllStores: boolean;
}

export const blankValues = (): IngredientFormValues => ({
  name: '', category: '', unit: 'each',
  costPerUnit: '', parLevel: '', vendorName: '', vendorId: '',
  caseQty: '1', casePrice: '0', subUnitSize: '1', subUnitUnit: '',
  sku: 'auto', packSize: '', packUnit: '', altUnits: '',
  reorderPoint: '', max: '', vendorSku: '',
  countNightly: true, trackWaste: true, allowSubstitute: false,
  createAtAllStores: false,
});

interface Props {
  mode: 'edit' | 'new';
  values: IngredientFormValues;
  onChange: (next: IngredientFormValues) => void;
  /** True when the field name should pull the focus ring on mount (NEW mode). */
  autoFocusName?: boolean;
}

const InputLine: React.FC<{
  label: string;
  value: string;
  onChangeText?: (v: string) => void;
  placeholder?: string;
  monoFont?: boolean;
  width?: any;
  help?: string;
  error?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
}> = ({ label, value, onChangeText, placeholder, monoFont, width = '100%', help, error, readOnly, autoFocus }) => {
  const C = useCmdColors();
  const [focus, setFocus] = React.useState(false);
  const borderColor = focus ? C.accent : error ? C.danger : C.border;
  return (
    <View style={{ width, gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Text>
      <View style={{
        height: 32, paddingHorizontal: 11, justifyContent: 'center',
        backgroundColor: readOnly ? C.panel2 : C.panel,
        borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
        ...(focus ? { boxShadow: `0 0 0 3px ${C.accentBg}` } as any : {}),
      }}>
        <TextInput
          value={value}
          onChangeText={readOnly ? undefined : onChangeText}
          placeholder={placeholder}
          placeholderTextColor={C.fg3}
          editable={!readOnly}
          autoFocus={autoFocus}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            fontFamily: monoFont ? mono(400) : sans(500),
            fontSize: 12.5,
            color: readOnly ? C.fg3 : C.fg,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
      </View>
      {(help || error) ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
          {error || help}
        </Text>
      ) : null}
    </View>
  );
};

const FlagRow: React.FC<{ label: string; desc: string; on: boolean; onToggle: () => void }> = ({ label, desc, on, onToggle }) => {
  const C = useCmdColors();
  return (
    <TouchableOpacity onPress={onToggle} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border, borderStyle: 'dashed' }}>
      <View style={{ width: 28, height: 16, borderRadius: 99, backgroundColor: on ? C.accent : C.panel2, borderWidth: 1, borderColor: C.border, position: 'relative' }}>
        <View style={{ position: 'absolute', top: 1, left: on ? 13 : 1, width: 12, height: 12, borderRadius: 99, backgroundColor: C.bg }} />
      </View>
      <Text style={{ fontFamily: mono(600), fontSize: 11.5, color: C.fg }}>{label}</Text>
      <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>· {desc}</Text>
    </TouchableOpacity>
  );
};

export const IngredientForm: React.FC<Props> = ({ mode, values, onChange, autoFocusName }) => {
  const C = useCmdColors();
  const isNew = mode === 'new';
  const set = <K extends keyof IngredientFormValues>(k: K, v: IngredientFormValues[K]) => onChange({ ...values, [k]: v });

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 0 }}>
      <SectionCaption tone="fg3" size={9.5}>IDENTITY · required</SectionCaption>
      <View style={{ gap: 12, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="display name" value={values.name} onChangeText={(v) => set('name', v)} autoFocus={autoFocusName} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <InputLine label="sku" value={values.sku} monoFont width="50%"
            help={isNew ? 'generated on save' : undefined} readOnly />
          <InputLine label="category" value={values.category} onChangeText={(v) => set('category', v)} width="50%" />
        </View>
      </View>

      <SectionCaption tone="fg3" size={9.5}>UNITS &amp; PACK</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 8 }}>
        <InputLine label="default unit" value={values.unit} onChangeText={(v) => set('unit', v)} monoFont width="33%" />
        <InputLine label="pack size"   value={values.caseQty} onChangeText={(v) => set('caseQty', v)} monoFont width="33%" />
        <InputLine label="pack unit"   value={values.packUnit} onChangeText={(v) => set('packUnit', v)} monoFont width="33%" />
      </View>
      <InputLine label="alt units" value={values.altUnits} onChangeText={(v) => set('altUnits', v)} placeholder="oz, kg, g" monoFont readOnly help="comma-separated; auto-converted from default (schema pending)" />

      <View style={{ height: 14 }} />
      <SectionCaption tone="fg3" size={9.5}>THRESHOLDS · par-based reorder</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="par"        value={values.parLevel} onChangeText={(v) => set('parLevel', v)} monoFont width="33%" />
        <InputLine label="reorder pt" value={values.reorderPoint} placeholder={isNew ? 'optional' : ''} monoFont width="33%" readOnly help={isNew ? '' : 'schema pending'} />
        <InputLine label="max"        value={values.max} placeholder={isNew ? 'optional' : ''} monoFont width="33%" readOnly />
      </View>

      <SectionCaption tone="fg3" size={9.5}>{isNew ? 'COSTING · snapshot' : 'COSTING · auto-computed'}</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="last cost" value={values.costPerUnit} onChangeText={(v) => set('costPerUnit', v)} monoFont width="50%" />
        <InputLine label="avg cost (30d)" value={isNew ? '—' : values.costPerUnit} monoFont width="50%" readOnly
          help={isNew ? 'available after first receipt' : 'auto-computed'} />
      </View>

      <SectionCaption tone="fg3" size={9.5}>VENDOR DEFAULT · optional</SectionCaption>
      <View style={{ marginTop: 8, marginBottom: 8 }}>
        <InputLine label="primary vendor" value={values.vendorName} onChangeText={(v) => set('vendorName', v)} />
      </View>
      <InputLine label="vendor sku" value={values.vendorSku} monoFont readOnly help="schema pending" />

      <View style={{ height: 14 }} />
      <SectionCaption tone="fg3" size={9.5}>FLAGS</SectionCaption>
      <View style={{ marginTop: 4 }}>
        <FlagRow label="count_nightly"    desc="include in EOD count"            on={values.countNightly}    onToggle={() => set('countNightly', !values.countNightly)} />
        <FlagRow label="track_waste"      desc="show in waste log"               on={values.trackWaste}      onToggle={() => set('trackWaste', !values.trackWaste)} />
        <FlagRow label="allow_substitute" desc="OK for chefs to swap in recipes" on={values.allowSubstitute} onToggle={() => set('allowSubstitute', !values.allowSubstitute)} />
      </View>

      {isNew ? (
        <>
          <View style={{ height: 14 }} />
          <SectionCaption tone="fg3" size={9.5}>STORE SCOPE</SectionCaption>
          <View style={{ marginTop: 4 }}>
            <FlagRow label="create_at_all_stores" desc="loop addItem over every store"
              on={values.createAtAllStores} onToggle={() => set('createAtAllStores', !values.createAtAllStores)} />
          </View>
        </>
      ) : null}

      <Text style={{ marginTop: 18, fontFamily: mono(400), fontSize: 9.5, color: C.fg3, lineHeight: 14 }}>
        Fields shaded grey are read-only stubs awaiting a schema migration —
        sku, alt units, reorder pt, max, vendor sku, avg cost. Editable fields
        save end-to-end via inventory_items.
      </Text>
    </ScrollView>
  );
};
