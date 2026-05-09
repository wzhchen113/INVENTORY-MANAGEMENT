import React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';
import { useStore } from '../../store/useStore';
import { CANONICAL_UNITS, isCanonicalUnit } from '../../utils/unitConversion';
import { isNumericInput } from '../../utils/validators';
import type { Vendor } from '../../types';

// Form values held by IngredientFormDrawer. A subset persists to
// inventory_items today — fields commented `STUB` are read-only displays
// awaiting a schema migration (see Phase 12 plan, "Stub at component layer"
// decision). Adding a field on this type adds it on both EDIT and + NEW.
//
// Spec 004 (2026-05-06): the `packUnit` form-side field has been renamed
// to `subUnitUnit` to match the column it persists to (closes the silent
// save-bug from `IngredientFormDrawer.toUpdates()` dropping `packUnit`).
// The user-facing label "pack unit" stays. `packSize` and `altUnits` were
// dead stubs and are dropped entirely.
export interface IngredientFormValues {
  // Bound to inventory_items columns
  name: string;
  category: string;
  unit: string;
  costPerUnit: string;       // text for input control; cast to number on save
  parLevel: string;
  vendorName: string;        // derived display only — vendorId is the source of truth
  vendorId: string;
  caseQty: string;
  casePrice: string;
  subUnitSize: string;       // numeric — "default unit size" (e.g. 40 lbs per case)
  subUnitUnit: string;       // pack unit — restricted to canonical mass/volume units
  // STUB — no DB column yet; surfaced read-only or as labels
  sku: string;
  reorderPoint: string;
  max: string;
  vendorSku: string;
  countNightly: boolean;
  trackWaste: boolean;
  allowSubstitute: boolean;
  // Multi-store create-time toggle (NEW mode only)
  createAtAllStores: boolean;
  // Spec 010 — expiry tracking
  // `defaultShelfLifeDays` writes through to catalog_ingredients (brand-
  // level); `expiryDate` writes through to inventory_items (per row). Held
  // as text on the form per the existing "everything is a string until
  // save" convention; cast in IngredientFormDrawer's save handler.
  defaultShelfLifeDays: string;  // numeric int days; '' = no auto-compute
  expiryDate: string;            // 'YYYY-MM-DD' or '' for none
}

export const blankValues = (): IngredientFormValues => ({
  name: '', category: '', unit: 'each',
  costPerUnit: '', parLevel: '', vendorName: '', vendorId: '',
  caseQty: '1', casePrice: '0', subUnitSize: '1', subUnitUnit: '',
  sku: 'auto',
  reorderPoint: '', max: '', vendorSku: '',
  countNightly: true, trackWaste: true, allowSubstitute: false,
  createAtAllStores: false,
  defaultShelfLifeDays: '', expiryDate: '',
});

// Sentinel value for the "+ new vendor" inline-add option in the vendor
// dropdown. Picked so it can never collide with a real UUID.
export const NEW_VENDOR_SENTINEL = '__new_vendor__';

interface Props {
  mode: 'edit' | 'new';
  values: IngredientFormValues;
  onChange: (next: IngredientFormValues) => void;
  /** True when the field name should pull the focus ring on mount (NEW mode). */
  autoFocusName?: boolean;
  /** Fired when user picks the "+ new vendor" sentinel — host opens VendorFormDrawer. */
  onAddVendor?: () => void;
}

// Numeric-only validation is centralized in `src/utils/validators.ts` —
// shared with the catalog conversions tab so both surfaces accept and
// reject the same keystrokes (spec 004 §6).

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
  numericOnly?: boolean;
}> = ({ label, value, onChangeText, placeholder, monoFont, width = '100%', help, error, readOnly, autoFocus, numericOnly }) => {
  const C = useCmdColors();
  const [focus, setFocus] = React.useState(false);
  const borderColor = focus ? C.accent : error ? C.danger : C.border;
  const handleChange = (next: string) => {
    if (!onChangeText) return;
    if (numericOnly && next !== '' && !isNumericInput(next)) return;
    onChangeText(next);
  };
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
          onChangeText={readOnly ? undefined : handleChange}
          placeholder={placeholder}
          placeholderTextColor={C.fg3}
          editable={!readOnly}
          autoFocus={autoFocus}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          keyboardType={numericOnly ? 'decimal-pad' : 'default'}
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

// ─── SelectField — minimal dropdown for the form's lookup fields ──────
// Renders a styled trigger that toggles a panel of options. Matches the
// InputLine visual rhythm (same height, border, focus ring) so the form
// reads as a coherent grid.
//
// Web: native <select> for accessibility + correctness inside the modal
// drawer (avoids z-index headaches with the existing two-modal stack).
// Native: a TouchableOpacity that opens an inline list panel beneath the
// trigger. The native variant is intentionally simple — it's good enough
// for the small option counts here (a few dozen at most).
export const SelectField: React.FC<{
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean; group?: string }>;
  onChange: (next: string) => void;
  placeholder?: string;
  width?: any;
  help?: string;
  error?: string;
  monoFont?: boolean;
  /** When true, treats the empty value as "not yet picked" and renders the placeholder. */
  allowEmpty?: boolean;
}> = ({ label, value, options, onChange, placeholder, width = '100%', help, error, monoFont, allowEmpty }) => {
  const C = useCmdColors();
  const [open, setOpen] = React.useState(false);
  const borderColor = open ? C.accent : error ? C.danger : C.border;
  const display = options.find((o) => o.value === value)?.label || (allowEmpty ? placeholder || '— select —' : value || placeholder || '— select —');

  if (Platform.OS === 'web') {
    // Use a native <select> rendered through a regular DOM element so the
    // browser handles dropdown stacking (works fine inside the form drawer
    // modal). Styled to match InputLine.
    return (
      <View style={{ width, gap: 4 }}>
        <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </Text>
        <View style={{
          height: 32, paddingHorizontal: 8, justifyContent: 'center',
          backgroundColor: C.panel,
          borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
        }}>
          {React.createElement('select', {
            value: value || '',
            onChange: (e: any) => onChange(e.target.value),
            style: {
              fontFamily: monoFont ? mono(400) : sans(500),
              fontSize: 12.5,
              color: !value && allowEmpty ? C.fg3 : C.fg,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              width: '100%',
              cursor: 'pointer',
              appearance: 'none' as any,
              WebkitAppearance: 'none' as any,
              MozAppearance: 'none' as any,
              backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23${(C.fg3 || '#888').replace('#','')}' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 6px center',
              paddingRight: 18,
            },
          },
            allowEmpty ? React.createElement('option', { key: '__empty', value: '' }, placeholder || '— select —') : null,
            ...options.map((o) =>
              React.createElement('option', {
                key: o.value,
                value: o.value,
                disabled: o.disabled,
              }, o.label),
            ),
          )}
        </View>
        {(help || error) ? (
          <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
            {error || help}
          </Text>
        ) : null}
      </View>
    );
  }

  // Native fallback — TouchableOpacity that opens an inline list.
  return (
    <View style={{ width, gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Text>
      <TouchableOpacity
        onPress={() => setOpen((p) => !p)}
        activeOpacity={0.85}
        style={{
          height: 32, paddingHorizontal: 11, justifyContent: 'center',
          backgroundColor: C.panel,
          borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
          flexDirection: 'row', alignItems: 'center',
        }}
      >
        <Text style={{
          flex: 1,
          fontFamily: monoFont ? mono(400) : sans(500),
          fontSize: 12.5,
          color: !value && allowEmpty ? C.fg3 : C.fg,
        }} numberOfLines={1}>
          {display}
        </Text>
        <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.fg3 }}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: C.borderStrong, borderRadius: CmdRadius.sm, backgroundColor: C.panel }}>
          {options.map((o) => (
            <TouchableOpacity
              key={o.value}
              disabled={o.disabled}
              onPress={() => { onChange(o.value); setOpen(false); }}
              style={{
                paddingVertical: 7, paddingHorizontal: 10,
                borderBottomWidth: 1, borderBottomColor: C.border,
                opacity: o.disabled ? 0.5 : 1,
                backgroundColor: o.value === value ? C.accentBg : 'transparent',
              }}
            >
              <Text style={{ fontFamily: monoFont ? mono(400) : sans(500), fontSize: 12, color: C.fg }}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
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

export const IngredientForm: React.FC<Props> = ({ mode, values, onChange, autoFocusName, onAddVendor }) => {
  const C = useCmdColors();
  const isNew = mode === 'new';

  // Lookup data — sourced from the live store so realtime updates propagate
  // without the form needing to remount.
  const ingredientCategories = useStore((s) => s.ingredientCategories);
  const allConversions       = useStore((s) => s.ingredientConversions);
  const vendors              = useStore((s) => s.vendors);
  const currentStore         = useStore((s) => s.currentStore);

  const set = <K extends keyof IngredientFormValues>(k: K, v: IngredientFormValues[K]) => onChange({ ...values, [k]: v });

  // Default-unit options: canonical units ∪ distinct purchase_unit values
  // across all conversions. Purely client-side derivation per spec 004 §3.
  const defaultUnitOptions = React.useMemo(() => {
    const acc = new Set<string>(CANONICAL_UNITS.map((u) => u.toLowerCase()));
    for (const c of allConversions) {
      const pu = c.purchaseUnit.toLowerCase().trim();
      if (pu) acc.add(pu);
    }
    // Always include "each" as the default tracking unit even though it's
    // not canonical and may not have a conversion row yet.
    acc.add('each');
    // Surface the ingredient's current unit even if it's a one-off string
    // not in either source — otherwise the dropdown would silently change
    // the value to empty on first render.
    const cur = (values.unit || '').toLowerCase().trim();
    if (cur) acc.add(cur);
    return Array.from(acc).sort().map((u) => ({ value: u, label: u }));
  }, [allConversions, values.unit]);

  // Pack-unit options — canonical mass/volume only per spec 004 §7. Adding
  // an ingredient's existing subUnitUnit to the option list when it's
  // canonical, else surface as "(non-canonical)" disabled item so the user
  // sees what's there but can't pick more abstract values.
  const packUnitOptions = React.useMemo(() => {
    const out: Array<{ value: string; label: string; disabled?: boolean }> = CANONICAL_UNITS.map((u) => ({ value: u, label: u }));
    const cur = (values.subUnitUnit || '').toLowerCase().trim();
    if (cur && !isCanonicalUnit(cur)) {
      out.push({ value: cur, label: `${cur} · non-canonical`, disabled: true });
    }
    return out;
  }, [values.subUnitUnit]);

  // Vendor options — brand-scoped. The "+ new vendor" sentinel sits at the
  // bottom and routes to the host's onAddVendor handler.
  const vendorOptions = React.useMemo(() => {
    const brandId = currentStore?.brandId || '';
    const filtered: Vendor[] = brandId ? vendors.filter((v) => v.brandId === brandId) : vendors;
    const opts: Array<{ value: string; label: string }> = filtered
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => ({ value: v.id, label: v.name }));
    if (onAddVendor) opts.push({ value: NEW_VENDOR_SENTINEL, label: '+ new vendor…' });
    return opts;
  }, [vendors, currentStore?.brandId, onAddVendor]);

  // Category options. ingredient_categories is a global string list today.
  const categoryOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ value: string; label: string }> = [];
    for (const c of ingredientCategories) {
      if (!c) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: c, label: c });
    }
    // If the ingredient's current category is not registered (legacy free
    // text), surface it as a selectable option so the displayed value
    // matches what's stored.
    const cur = values.category;
    if (cur && !seen.has(cur.toLowerCase())) out.push({ value: cur, label: `${cur} · unregistered` });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [ingredientCategories, values.category]);

  // Yellow-warning trigger: default unit is non-canonical (= abstract)
  // AND no conversion row exists for it on this ingredient. Per spec 004
  // §6, prompts the user to define the conversion on the Conversions tab.
  // We don't know the ingredient's catalog/inventory id from inside the
  // form (the host does), so the warning condition is the lighter "any
  // conversion globally for this purchase_unit string". That matches the
  // dropdown derivation and avoids false positives.
  const abstractUnitWarning = React.useMemo(() => {
    const u = (values.unit || '').toLowerCase().trim();
    // `each` is intentionally exempt: it is a tracking unit (count of
    // physical items) that does not need a `g` / `fl_oz` conversion to
    // function — the cost-calc resolves it via `subUnitSize` × `subUnitUnit`
    // when a recipe asks for a different unit. Per spec 004 §7 + architect
    // N1, suppressing the yellow warning here avoids flagging the most
    // common ingredient unit on the system.
    if (!u || isCanonicalUnit(u) || u === 'each') return null;
    const hasAnyConv = allConversions.some(
      (c) => c.purchaseUnit.toLowerCase().trim() === u,
    );
    if (hasAnyConv) return null;
    return `No conversion defined for "${u}". Recipes using this unit can't compute cost. Define on Conversions tab →`;
  }, [values.unit, allConversions]);

  // Vendor pick handler — selecting the sentinel value fires onAddVendor;
  // selecting a real vendor stores both id and a derived display name.
  const handleVendorChange = (next: string) => {
    if (next === NEW_VENDOR_SENTINEL) {
      onAddVendor?.();
      return;
    }
    const v = vendors.find((vv) => vv.id === next);
    onChange({ ...values, vendorId: next, vendorName: v?.name || '' });
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 0 }}>
      <SectionCaption tone="fg3" size={9.5}>IDENTITY · required</SectionCaption>
      <View style={{ gap: 12, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="display name" value={values.name} onChangeText={(v) => set('name', v)} autoFocus={autoFocusName} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <InputLine label="sku" value={values.sku} monoFont width="50%"
            help={isNew ? 'generated on save' : undefined} readOnly />
          <SelectField
            label="category"
            value={values.category}
            options={categoryOptions}
            onChange={(v) => set('category', v)}
            placeholder="— select category —"
            allowEmpty
            width="50%"
            help={categoryOptions.length === 0 ? 'No categories defined yet · add some on the Categories tab' : undefined}
          />
        </View>
      </View>

      <SectionCaption tone="fg3" size={9.5}>UNITS &amp; PACK</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 8 }}>
        <SelectField
          label="default unit"
          value={values.unit}
          options={defaultUnitOptions}
          onChange={(v) => set('unit', v)}
          monoFont
          width="33%"
          placeholder="— pick unit —"
        />
        <InputLine label="pack size" value={values.caseQty} onChangeText={(v) => set('caseQty', v)} monoFont width="33%" numericOnly help="e.g. 1 (case)" />
        <InputLine label="default unit size" value={values.subUnitSize} onChangeText={(v) => set('subUnitSize', v)} monoFont width="33%" numericOnly help="e.g. 40 (per case)" />
      </View>
      <View style={{ marginBottom: 6 }}>
        <SelectField
          label="pack unit"
          value={values.subUnitUnit}
          options={packUnitOptions}
          onChange={(v) => set('subUnitUnit', v)}
          monoFont
          placeholder="— pick pack unit —"
          allowEmpty
          help={'For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
        />
      </View>
      {abstractUnitWarning ? (
        <View style={{ marginTop: 6, padding: 10, borderRadius: CmdRadius.sm, backgroundColor: C.warnBg, borderWidth: 1, borderColor: C.warn }}>
          <Text style={{ fontFamily: mono(500), fontSize: 11, color: C.warn, lineHeight: 15 }}>
            {abstractUnitWarning}
          </Text>
        </View>
      ) : null}

      <View style={{ height: 14 }} />
      <SectionCaption tone="fg3" size={9.5}>THRESHOLDS · par-based reorder</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="par"        value={values.parLevel} onChangeText={(v) => set('parLevel', v)} monoFont width="33%" numericOnly />
        <InputLine label="reorder pt" value={values.reorderPoint} placeholder={isNew ? 'optional' : ''} monoFont width="33%" readOnly help={isNew ? '' : 'schema pending'} />
        <InputLine label="max"        value={values.max} placeholder={isNew ? 'optional' : ''} monoFont width="33%" readOnly />
      </View>

      {/* Spec 010 §6 — EXPIRY block. defaultShelfLifeDays writes to
          catalog_ingredients (brand-level); expiryDate writes to
          inventory_items (per row). On NEW mode the per-row expiry input
          is hidden because the row doesn't exist yet — the auto-stamp
          path applies on first receipt. */}
      <SectionCaption tone="fg3" size={9.5}>EXPIRY · spec 010</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
        <InputLine
          label="default shelf life (days)"
          value={values.defaultShelfLifeDays}
          onChangeText={(v) => set('defaultShelfLifeDays', v)}
          monoFont
          width="50%"
          numericOnly
          placeholder="—"
          help="brand-wide · auto-applied on receipt when row has no expiry"
        />
        {isNew ? (
          <View style={{ width: '50%' }} />
        ) : (
          <InputLine
            label="this row · expires"
            value={values.expiryDate}
            onChangeText={(v) => set('expiryDate', v)}
            monoFont
            width="50%"
            placeholder="YYYY-MM-DD"
            help="per-row override · blank to clear"
          />
        )}
      </View>

      <SectionCaption tone="fg3" size={9.5}>{isNew ? 'COSTING · snapshot' : 'COSTING · auto-computed'}</SectionCaption>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8, marginBottom: 14 }}>
        <InputLine label="last cost" value={values.costPerUnit} onChangeText={(v) => set('costPerUnit', v)} monoFont width="50%" numericOnly />
        <InputLine label="avg cost (30d)" value={isNew ? '—' : values.costPerUnit} monoFont width="50%" readOnly
          help={isNew ? 'available after first receipt' : 'auto-computed'} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 0, marginBottom: 6 }}>
        <InputLine label="case price" value={values.casePrice} onChangeText={(v) => set('casePrice', v)} monoFont width="50%" numericOnly />
        <View style={{ width: '50%' }} />
      </View>

      <SectionCaption tone="fg3" size={9.5}>VENDOR DEFAULT · optional</SectionCaption>
      <View style={{ marginTop: 8, marginBottom: 8 }}>
        <SelectField
          label="primary vendor"
          value={values.vendorId}
          options={vendorOptions}
          onChange={handleVendorChange}
          placeholder="— pick vendor —"
          allowEmpty
        />
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
        sku, reorder pt, max, vendor sku, avg cost. Editable fields save
        end-to-end via inventory_items.
      </Text>
    </ScrollView>
  );
};
