import React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';
import { useStore } from '../../store/useStore';
import { CANONICAL_UNITS, isCanonicalUnit } from '../../utils/unitConversion';
import { isNumericInput } from '../../utils/validators';
import type { Vendor } from '../../types';
import { useT } from '../../hooks/useT';
import { unitLabel } from '../../utils/enumLabels';
import { translateOnSave } from '../../lib/translate';

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
  // Spec 040 P3 — per-locale display-name overrides for the catalog
  // ingredient. Held as plain strings (free-form text) so the user can
  // accept the DeepL suggestion or replace it. Empty strings are
  // serialized as "no translation" on save (the key is omitted from
  // i18n_names) so the silent-English fallback kicks in.
  nameEs: string;
  nameZh: string;
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
  nameEs: '', nameZh: '',
});

// Sentinel value for the "+ new vendor" inline-add option in the vendor
// dropdown. Picked so it can never collide with a real UUID.
export const NEW_VENDOR_SENTINEL = '__new_vendor__';

// Spec 046 — sentinel for the "+ custom…" entry in the default-unit and
// pack-unit dropdowns. Picked so it can never collide with a real unit
// label. Mirrors the NEW_VENDOR_SENTINEL shape above.
export const CUSTOM_UNIT_SENTINEL = '__custom__';

// Spec 046 — max length for a free-text unit. 30 chars (not 32) so a
// pluralized canonical label like "fluid ounces" renders within the
// form's mono-font column width with a one-tick buffer. The DB column
// is plain `text` (no CHECK), so this cap is client-side only.
export const CUSTOM_UNIT_MAX_LEN = 30;

/**
 * Result shape for {@link validateCustomUnit}.
 *
 * - `ok: true, snappedToCanonical: false` — user typed a non-canonical
 *   string; preserve original casing on the value, the form's
 *   `defaultUnitOptions` / `packUnitOptions` memos surface it as a
 *   disabled-style "· custom" entry in the dropdown afterwards.
 * - `ok: true, snappedToCanonical: true` — user typed something that
 *   case-insensitively matches a canonical unit OR a known-lowercase
 *   option already in the SelectField's option list (e.g. "EACH", "Bag").
 *   We coerce to the lowercase form rather than create a near-duplicate
 *   entry whose case differs by a byte (which would miss the SelectField's
 *   byte-for-byte display lookup), per spec 046 AC6.
 * - `ok: false` — input is empty/whitespace-only (`required`) or longer
 *   than CUSTOM_UNIT_MAX_LEN (`too_long`).
 */
export type CustomUnitValidation =
  | { ok: true; normalized: string; snappedToCanonical: false }
  | { ok: true; normalized: string; snappedToCanonical: true }
  | { ok: false; error: 'required' | 'too_long' };

/**
 * Validate a user-typed custom unit and return either the normalized
 * value to commit or a structured rejection.
 *
 * Pure function — exported for jest. Resolution order matches the
 * architect's design (spec 046 §Backend / architecture design Q3) plus
 * the round-2 code-review fix C2 (snap to known-lowercase option keys):
 *   1. trim whitespace
 *   2. reject empty
 *   3. reject > 30 chars
 *   4. case-insensitively snap to CANONICAL_UNITS
 *   5. case-insensitively snap to any caller-supplied known-lowercase
 *      keys (e.g. `'each'`, or any `ingredient_conversions.purchaseUnit`
 *      already present in the dropdown). Without this, typing `EACH` or
 *      `BAG` would create a near-duplicate entry that misses the
 *      SelectField's byte-for-byte display lookup.
 *   6. otherwise pass through with original casing preserved.
 *
 * `knownLowercaseKeys` MUST already be lowercase; the helper compares
 * the lowercased user input against each entry. Callers build the array
 * at-call-time from the live options list.
 */
export function validateCustomUnit(
  raw: string,
  knownLowercaseKeys: readonly string[] = [],
): CustomUnitValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'required' };
  if (trimmed.length > CUSTOM_UNIT_MAX_LEN) return { ok: false, error: 'too_long' };
  const lower = trimmed.toLowerCase();
  if (CANONICAL_UNITS.includes(lower)) {
    return { ok: true, normalized: lower, snappedToCanonical: true };
  }
  if (knownLowercaseKeys.includes(lower)) {
    return { ok: true, normalized: lower, snappedToCanonical: true };
  }
  return { ok: true, normalized: trimmed, snappedToCanonical: false };
}

interface Props {
  mode: 'edit' | 'new';
  values: IngredientFormValues;
  /**
   * Accepts a value OR a functional updater, mirroring React's
   * `Dispatch<SetStateAction<IngredientFormValues>>`. The functional form
   * lets the spec 040 P3 translate-on-save handler patch only the i18n
   * fields without clobbering concurrent edits to other fields.
   */
  onChange: (next: IngredientFormValues | ((prev: IngredientFormValues) => IngredientFormValues)) => void;
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
  /** Spec 040 P3 — extra onBlur callback (in addition to focus-ring
   *  state). Used by the IngredientForm name field to fire the
   *  translate-on-save edge function when the user tabs out. */
  onBlur?: () => void;
}> = ({ label, value, onChangeText, placeholder, monoFont, width = '100%', help, error, readOnly, autoFocus, numericOnly, onBlur }) => {
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
          onBlur={() => { setFocus(false); onBlur?.(); }}
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

// SelectField now lives in its own file so other Cmd UI surfaces (recipe
// drawers, etc.) can reuse it without circular imports. Re-exported here
// for callers that still import it from this module.
import { SelectField } from './SelectField';
export { SelectField };

// Spec 046 — inline TextInput that replaces a SelectField when the user
// picks "+ custom…". Mirrors the InputLine visual rhythm (same height,
// border, focus ring) so the form reads as a coherent grid, plus a
// trailing `×` button that returns to the dropdown without committing.
//
// Commit triggers (round-2 code-review fix C1):
//   - blur of the TextInput (touch-out / Tab) → onCommit()
//   - onSubmitEditing (Enter on web AND native) → onCommit()
//
// Both paths fire within the same React batch on web (pressing Enter
// triggers onSubmitEditing AND a focus-loss blur back-to-back), so the
// helper guards re-entry with `committedRef` — the second call is a
// no-op until `setTimeout(…, 0)` resets the latch on the next tick.
// SF1: the previous `onKeyPress` web Enter trap was removed because RN
// Web 0.21 synthesizes `onSubmitEditing` reliably for `TextInput`; the
// trap was a third redundant commit path and contributed to the same
// double-fire symptom.
//
// Cancel trigger:
//   - press the `×` button → onCancel() — drops the draft without
//     touching `values.*`. onMouseDown also short-circuits onCommit's
//     race-with-blur by virtue of the same committedRef latch (the
//     cancel path sets the latch, then resets on next tick).
//
// Validation lives in the caller's onCommit; this component only renders
// what the parent tells it.
const CustomUnitInput: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  width?: any;
  error?: string;
  help?: string;
}> = ({ label, value, onChange, onCommit, onCancel, width = '100%', error, help }) => {
  const C = useCmdColors();
  const [focus, setFocus] = React.useState(false);
  const borderColor = focus ? C.accent : error ? C.danger : C.border;
  // Spec 046 round-2 (C1) — single-commit latch. Web's Enter key fires
  // onSubmitEditing AND a focus-loss blur in the same React batch, both
  // wired here to onCommit; without the latch the parent's onChange
  // would fire 2-3 times with stale customDraft state and re-snap the
  // value to a stale (or empty) string. Reset on next tick so a
  // subsequent legitimate edit-then-commit cycle still works.
  const committedRef = React.useRef(false);
  const handleCommit = React.useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit();
    setTimeout(() => { committedRef.current = false; }, 0);
  }, [onCommit]);
  const handleCancel = React.useCallback(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
    setTimeout(() => { committedRef.current = false; }, 0);
  }, [onCancel]);
  return (
    <View style={{ width, gap: 4 }}>
      <Text style={{ fontFamily: mono(700), fontSize: 9.5, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Text>
      <View style={{
        height: 32, paddingLeft: 11, paddingRight: 4, flexDirection: 'row', alignItems: 'center',
        backgroundColor: C.panel,
        borderWidth: 1, borderColor, borderRadius: CmdRadius.sm,
        ...(focus ? { boxShadow: `0 0 0 3px ${C.accentBg}` } as any : {}),
      }}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="e.g. case, box, tray"
          placeholderTextColor={C.fg3}
          autoFocus
          onFocus={() => setFocus(true)}
          onBlur={() => { setFocus(false); handleCommit(); }}
          onSubmitEditing={handleCommit}
          style={{
            flex: 1,
            fontFamily: mono(400),
            fontSize: 12.5,
            color: C.fg,
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : {}),
          }}
        />
        {/* `×` back-out — does NOT commit. onMouseDown fires before the
            TextInput's blur, so handleCancel runs and sets the commit
            latch, suppressing the blur-driven commit path that would
            otherwise race a stale-draft commit through. Round-2 C1: the
            latch is now the canonical single-commit guard; this comment
            previously called out only the cancel-path race. */}
        <TouchableOpacity
          onPress={handleCancel}
          {...(Platform.OS === 'web' ? ({ onMouseDown: (e: any) => { e.preventDefault?.(); handleCancel(); } } as any) : {})}
          accessibilityRole="button"
          accessibilityLabel="back to dropdown"
          hitSlop={6}
          style={{ paddingHorizontal: 8, paddingVertical: 4 }}
        >
          <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.fg3 }}>×</Text>
        </TouchableOpacity>
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

export const IngredientForm: React.FC<Props> = ({ mode, values, onChange, autoFocusName, onAddVendor }) => {
  const C = useCmdColors();
  const T = useT();
  const isNew = mode === 'new';

  // Lookup data — sourced from the live store so realtime updates propagate
  // without the form needing to remount.
  const ingredientCategories = useStore((s) => s.ingredientCategories);
  const allConversions       = useStore((s) => s.ingredientConversions);
  const vendors              = useStore((s) => s.vendors);
  const currentStore         = useStore((s) => s.currentStore);

  const set = <K extends keyof IngredientFormValues>(k: K, v: IngredientFormValues[K]) => onChange({ ...values, [k]: v });

  // Spec 040 P3 — auto-fill translation suggestions for ES + zh-CN.
  // Hybrid trigger: 600ms idle OR blur; AbortController cancels in-flight
  // requests when the user keeps typing. On DeepL error we leave the
  // override fields editable so the user can fill in manually.
  const abortRef = React.useRef<AbortController | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [translating, setTranslating] = React.useState(false);
  // Refs to the latest `values` / `onChange` so the debounced timer always
  // operates on fresh state rather than a captured stale closure.
  const valuesRef = React.useRef(values);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => { valuesRef.current = values; }, [values]);
  React.useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  React.useEffect(() => () => {
    abortRef.current?.abort();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const runTranslate = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setTranslating(true);
    try {
      // Pass ctrl.signal so a fresh keystroke aborts the in-flight fetch
      // instead of just discarding its result (saves DeepL quota).
      const { data, error } = await translateOnSave(trimmed, ['es', 'zh-CN'], ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (error || !data) return;
      // Functional-updater form so any concurrent edits the user made to
      // other fields (e.g. category) while DeepL was in-flight aren't
      // clobbered by a stale `valuesRef.current` snapshot.
      onChangeRef.current((prev: IngredientFormValues) => {
        const next = { ...prev };
        const es = data.translations?.es;
        const zh = data.translations?.['zh-CN'];
        if (typeof es === 'string' && es.trim().length > 0) next.nameEs = es;
        if (typeof zh === 'string' && zh.trim().length > 0) next.nameZh = zh;
        return next;
      });
    } finally {
      if (!ctrl.signal.aborted) setTranslating(false);
    }
  }, []);

  const scheduleTranslate = React.useCallback((text: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { runTranslate(text); }, 600);
  }, [runTranslate]);

  const handleNameBlur = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    runTranslate(valuesRef.current.name);
  }, [runTranslate]);

  // Spec 046 — local render flags for the inline "+ custom…" TextInput.
  // Component-local state only; NOT persisted to `values`. When `default`
  // / `pack` flips to true, the corresponding SelectField unmounts and
  // an inline TextInput mounts in its place. Flipped back to false when
  // the user commits a valid value (blur / Enter) or backs out via `×`.
  const [customMode, setCustomMode] = React.useState<{ default: boolean; pack: boolean }>({ default: false, pack: false });
  // Spec 046 — text the user is typing into the inline TextInput. Held
  // here (not on `values`) so a partially-typed invalid string never
  // races into the persisted form values. Mirrors the in-progress draft
  // pattern used elsewhere in Cmd UI.
  const [customDraft, setCustomDraft] = React.useState<{ default: string; pack: string }>({ default: '', pack: '' });
  // Spec 046 — inline validation error displayed under the TextInput
  // when the committed value (blur / Enter) fails validateCustomUnit.
  const [customError, setCustomError] = React.useState<{ default: string; pack: string }>({ default: '', pack: '' });

  // Default-unit options: canonical units ∪ distinct purchase_unit values
  // across all conversions. Purely client-side derivation per spec 004 §3.
  // Spec 046 — appends a "+ custom…" sentinel row at the bottom so users
  // can type a free-text unit when no canonical option fits. The stored
  // value's auto-inclusion (block below) ensures edit-mode for an
  // already-custom value renders cleanly without flipping into TextInput.
  const defaultUnitOptions = React.useMemo(() => {
    const acc = new Set<string>(CANONICAL_UNITS.map((u) => u.toLowerCase()));
    for (const c of allConversions) {
      const pu = c.purchaseUnit.toLowerCase().trim();
      if (pu) acc.add(pu);
    }
    // Always include "each" as the default tracking unit even though it's
    // not canonical and may not have a conversion row yet.
    acc.add('each');
    const curRaw = (values.unit || '').trim();
    const curLower = curRaw.toLowerCase();
    // Surface the ingredient's current unit even if it's a one-off string
    // not in either source — otherwise the dropdown would silently change
    // the value to empty on first render. Skip the dedup-set add when the
    // current value is a non-canonical custom string (case-preserved) so
    // we don't accidentally lowercase it; the special-case append below
    // handles that path explicitly.
    const isCustom = !!curLower
      && !isCanonicalUnit(curLower)
      && curLower !== 'each'
      && !allConversions.some((c) => c.purchaseUnit.toLowerCase().trim() === curLower);
    if (curLower && !isCustom) acc.add(curLower);
    const out: Array<{ value: string; label: string; disabled?: boolean }> = Array
      .from(acc)
      .sort()
      .map((u) => ({ value: u, label: unitLabel(u, T) }));
    // Spec 046 — append the stored value verbatim (case-preserved) with
    // a "· custom" suffix when it's a non-canonical custom string. The
    // option value MUST equal the stored value byte-for-byte so the
    // SelectField's display lookup `options.find((o) => o.value === value)`
    // hits. Left enabled so the user can re-pick the same value or pick
    // another option without losing the current one.
    if (isCustom) {
      out.push({ value: curRaw, label: `${curRaw} · custom` });
    }
    // Spec 046 — "+ custom…" sentinel always sits at the bottom.
    out.push({ value: CUSTOM_UNIT_SENTINEL, label: '+ custom…' });
    return out;
  }, [allConversions, values.unit, T]);

  // Pack-unit options — canonical mass/volume only per spec 004 §7. Adding
  // an ingredient's existing subUnitUnit to the option list when it's
  // canonical, else surface as "(non-canonical)" disabled item so the user
  // sees what's there but can't pick more abstract values.
  // Spec 046 — appends a "+ custom…" sentinel row at the bottom so the
  // pack-unit dropdown also accepts free-text labels like "case" or "tray",
  // and surfaces the stored value verbatim (case-preserved) so byte-for-
  // byte equality with the SelectField's display lookup holds.
  const packUnitOptions = React.useMemo(() => {
    const out: Array<{ value: string; label: string; disabled?: boolean }> = CANONICAL_UNITS.map((u) => ({ value: u, label: unitLabel(u, T) }));
    const curRaw = (values.subUnitUnit || '').trim();
    const curLower = curRaw.toLowerCase();
    if (curLower && !isCanonicalUnit(curLower)) {
      // Spec 046 — keep the entry enabled (not disabled like the pre-046
      // pattern) so a user editing an existing ingredient can re-pick
      // their custom pack unit without being forced into the canonical
      // set. The "· custom" suffix flags it as a non-canonical value.
      // Value is the raw (case-preserved) stored string so SelectField's
      // display lookup hits.
      out.push({ value: curRaw, label: `${curRaw} · custom` });
    }
    out.push({ value: CUSTOM_UNIT_SENTINEL, label: '+ custom…' });
    return out;
  }, [values.subUnitUnit, T]);

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

  // Category options. ingredient_categories is a `{ name; i18nNames }[]`
  // after spec 040 P3. The value (join key) stays English canonical;
  // the label could be localized in the future — keeping plain English
  // for now since the form is itself a string-typed control.
  const categoryOptions = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ value: string; label: string }> = [];
    for (const c of ingredientCategories) {
      if (!c?.name) continue;
      const key = c.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: c.name, label: c.name });
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
    // Round-2 (SF2) — preserve display casing in the banner. The
    // lowercased `u` is for comparison only (canonical-set lookup,
    // conversion-row lookup); the user-facing string uses `curRaw` so a
    // committed `Case` reads as `"Case"` in the banner, not `"case"`.
    const curRaw = (values.unit || '').trim();
    const u = curRaw.toLowerCase();
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
    return `No conversion defined for "${curRaw}". Recipes using this unit can't compute cost. Define on Conversions tab →`;
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
        <InputLine
          label="display name"
          value={values.name}
          onChangeText={(v) => { set('name', v); scheduleTranslate(v); }}
          onBlur={handleNameBlur}
          autoFocus={autoFocusName}
        />
        {/* Spec 040 P3 — translation override inputs. Filled by the
            translate-on-save edge function debounce + blur trigger;
            user can edit either field before saving. Empty strings serialize
            as "no translation" on save (the key is omitted from
            i18n_names) so silent-English fallback kicks in. */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <InputLine
            label="display name · español"
            value={values.nameEs}
            onChangeText={(v) => set('nameEs', v)}
            placeholder={translating ? 'translating…' : '—'}
            width="50%"
            help={translating ? 'auto-fill in progress' : 'auto-fills · editable'}
          />
          <InputLine
            label="display name · 中文"
            value={values.nameZh}
            onChangeText={(v) => set('nameZh', v)}
            placeholder={translating ? 'translating…' : '—'}
            width="50%"
            help={translating ? 'auto-fill in progress' : 'auto-fills · editable'}
          />
        </View>
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
        {/* Spec 046 — when the user picks the "+ custom…" sentinel from the
            default-unit dropdown, swap the SelectField out for an inline
            TextInput plus a `×` button that returns to the dropdown. The
            customMode flag is component-local so a partially-typed invalid
            value never races into the persisted `values.unit`. */}
        {customMode.default ? (
          <CustomUnitInput
            label="default unit"
            width="33%"
            value={customDraft.default}
            error={customError.default}
            onChange={(v) => setCustomDraft((p) => ({ ...p, default: v }))}
            onCommit={() => {
              // Round-2 (C2) — build the known-lowercase keys live from
              // the dropdown's option list so typing `EACH` or `BAG`
              // snaps to the same lowercase byte sequence that
              // SelectField uses for its display lookup, instead of
              // creating a near-duplicate "Each / each" pair where the
              // SelectField shows the placeholder.
              const knownKeys = defaultUnitOptions
                .map((o) => o.value.toLowerCase())
                .filter((v) => v !== CUSTOM_UNIT_SENTINEL.toLowerCase());
              const res = validateCustomUnit(customDraft.default, knownKeys);
              if (!res.ok) {
                setCustomError((p) => ({ ...p, default: res.error === 'required' ? 'required' : `too long (max ${CUSTOM_UNIT_MAX_LEN})` }));
                return;
              }
              set('unit', res.normalized);
              setCustomDraft((p) => ({ ...p, default: '' }));
              setCustomError((p) => ({ ...p, default: '' }));
              setCustomMode((p) => ({ ...p, default: false }));
            }}
            onCancel={() => {
              setCustomDraft((p) => ({ ...p, default: '' }));
              setCustomError((p) => ({ ...p, default: '' }));
              setCustomMode((p) => ({ ...p, default: false }));
            }}
          />
        ) : (
          <SelectField
            label="default unit"
            value={values.unit}
            options={defaultUnitOptions}
            onChange={(v) => {
              if (v === CUSTOM_UNIT_SENTINEL) {
                setCustomDraft((p) => ({ ...p, default: '' }));
                setCustomError((p) => ({ ...p, default: '' }));
                setCustomMode((p) => ({ ...p, default: true }));
                return;
              }
              set('unit', v);
            }}
            monoFont
            width="33%"
            placeholder="— pick unit —"
          />
        )}
        <InputLine label="packs / order" value={values.caseQty} onChangeText={(v) => set('caseQty', v)} monoFont width="33%" numericOnly help="how many packs at a time" />
        <InputLine label="units / pack" value={values.subUnitSize} onChangeText={(v) => set('subUnitSize', v)} monoFont width="33%" numericOnly help="how many default units in one pack" />
      </View>
      <View style={{ marginBottom: 6 }}>
        {customMode.pack ? (
          <CustomUnitInput
            label="pack unit"
            value={customDraft.pack}
            error={customError.pack}
            help={'For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
            onChange={(v) => setCustomDraft((p) => ({ ...p, pack: v }))}
            onCommit={() => {
              // Round-2 (C2) — known-lowercase keys for the pack-unit
              // dropdown. Includes:
              //   - the pack-unit dropdown's current option values
              //     (CANONICAL_UNITS + case-preserved stored value)
              //   - every `ingredient_conversions.purchaseUnit`
              //     globally, because typing a conversion-derived unit
              //     like `BAG` should snap to `bag` (the canonical
              //     lowercase form the rest of the form uses for
              //     dropdown lookups) instead of being persisted as a
              //     fresh "BAG" custom string that drifts from existing
              //     conversion rows. Matches the reviewer's spec 046
              //     code-review C2 example verbatim.
              const knownKeys = [
                ...packUnitOptions
                  .map((o) => o.value.toLowerCase())
                  .filter((v) => v !== CUSTOM_UNIT_SENTINEL.toLowerCase()),
                ...allConversions.map((c) => c.purchaseUnit.toLowerCase().trim()),
              ];
              const res = validateCustomUnit(customDraft.pack, knownKeys);
              if (!res.ok) {
                setCustomError((p) => ({ ...p, pack: res.error === 'required' ? 'required' : `too long (max ${CUSTOM_UNIT_MAX_LEN})` }));
                return;
              }
              set('subUnitUnit', res.normalized);
              setCustomDraft((p) => ({ ...p, pack: '' }));
              setCustomError((p) => ({ ...p, pack: '' }));
              setCustomMode((p) => ({ ...p, pack: false }));
            }}
            onCancel={() => {
              setCustomDraft((p) => ({ ...p, pack: '' }));
              setCustomError((p) => ({ ...p, pack: '' }));
              setCustomMode((p) => ({ ...p, pack: false }));
            }}
          />
        ) : (
          <SelectField
            label="pack unit"
            value={values.subUnitUnit}
            options={packUnitOptions}
            onChange={(v) => {
              if (v === CUSTOM_UNIT_SENTINEL) {
                setCustomDraft((p) => ({ ...p, pack: '' }));
                setCustomError((p) => ({ ...p, pack: '' }));
                setCustomMode((p) => ({ ...p, pack: true }));
                return;
              }
              set('subUnitUnit', v);
            }}
            monoFont
            placeholder="— pick pack unit —"
            allowEmpty
            help={'For abstract pack units like "case" or "tray", define their physical meaning on the Conversions tab.'}
          />
        )}
      </View>
      {(() => {
        const packs = Number(values.caseQty);
        const perPack = Number(values.subUnitSize);
        if (!Number.isFinite(packs) || !Number.isFinite(perPack) || packs <= 0 || perPack <= 0) return null;
        const unit = values.unit || 'each';
        // Simple s-suffix pluralization — handles case/tray/bag/bottle/pack
        // (seed values). Won't be right for irregular plurals but the seed
        // doesn't contain any. Empty subUnitUnit renders the literal
        // placeholder `pack(s)` per spec 045 AC line 28 — the user-facing
        // signal that no pack unit is selected yet.
        const packLabel = !values.subUnitUnit
          ? 'pack(s)'
          : packs === 1
            ? values.subUnitUnit
            : (values.subUnitUnit.toLowerCase().endsWith('s') ? values.subUnitUnit : `${values.subUnitUnit}s`);
        const total = packs * perPack;
        return (
          <View style={{ marginTop: 4, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: CmdRadius.sm, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              {`= ${packs} ${packLabel} × ${perPack} ${unit} = ${total} ${unit} per order`}
            </Text>
          </View>
        );
      })()}
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
