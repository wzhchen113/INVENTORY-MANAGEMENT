import React from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { sans, mono } from '../../theme/typography';
import { SectionCaption } from './SectionCaption';
import { useStore } from '../../store/useStore';
import { CANONICAL_UNITS, isCanonicalUnit, calcUnitCost } from '../../utils/unitConversion';
import { deriveBrandUnitPool } from '../../utils/brandUnitPool';
import { piecesPerCase } from '../../utils/perEachCost';
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
  subUnitSize: string;       // numeric — sub-units PER ONE TRACKING UNIT (e.g. a bag of 10 each). NOT the case size; the case size lives in caseQty → case_qty (spec 093).
  subUnitUnit: string;       // unit each sub-unit is measured in — restricted to canonical mass/volume units
  // STUB — no DB column yet; surfaced read-only or as labels
  sku: string;
  reorderPoint: string;
  max: string;
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
  // Spec 102 — multi-vendor link set. Each row attaches the item to ONE
  // vendor with its OWN cost + case price (per-(item, vendor) cost). The
  // `vendorId` scalar above stays the PRIMARY pointer (SD-1) and is always
  // mirrored as the row whose `vendorId === values.vendorId`. Costs held as
  // strings (cast on save in the drawer) per the form's "everything is a
  // string until save" convention. An item with zero links saves with an
  // empty array (removes all `item_vendors` rows); a single-vendor item has
  // exactly one row that mirrors the primary picker.
  //
  // Spec 114 — each row also carries `orderCode`: the vendor's own order/SKU
  // code for THIS (item, vendor) link (→ `item_vendors.order_code`), free-form
  // text held as a string like the cost fields, trimmed on save; an empty code
  // saves as SQL NULL. This is the per-vendor code the operator pastes into the
  // vendor's quick-order box. Spec 115 (W-4) removed the obsolete item-level
  // `vendorSku` stub that formerly sat below — this is now the ONLY place codes
  // live.
  vendors: Array<{ vendorId: string; costPerUnit: string; casePrice: string; orderCode: string }>;
}

export const blankValues = (): IngredientFormValues => ({
  name: '', category: '', unit: 'each',
  costPerUnit: '', parLevel: '', vendorName: '', vendorId: '',
  caseQty: '1', casePrice: '0', subUnitSize: '1', subUnitUnit: '',
  sku: 'auto',
  reorderPoint: '', max: '',
  countNightly: true, trackWaste: true, allowSubstitute: false,
  createAtAllStores: false,
  defaultShelfLifeDays: '', expiryDate: '',
  nameEs: '', nameZh: '',
  vendors: [],
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

// ─── Spec 102: multi-vendor editor helpers (pure — exported for jest) ────────
//
// The IngredientForm holds the link set as `values.vendors` (rows with
// string-typed cost/casePrice per the form convention) plus the scalar
// `values.vendorId` (the PRIMARY pointer, SD-1). These helpers are the
// add/remove/dup-guard/primary-mirror logic and the form→db payload mapping,
// factored out so the mapping (AC-C: "saving V1+V2 persists two link rows;
// removing a vendor removes its link; editing a cost updates only that link")
// is unit-tested without mounting the component.

export interface VendorLinkRow {
  vendorId: string;
  costPerUnit: string;
  casePrice: string;
  // Spec 114 — the vendor's order/SKU code for this link (→ item_vendors.order_code).
  // Free-form string, trimmed on save; empty → SQL NULL via vendorRowsToLinkPayload.
  orderCode: string;
}

/**
 * Dup-guard (AC-C "prevents attaching the same vendor twice"). True when
 * `vendorId` is already present in `rows`. Empty / sentinel ids are never
 * "duplicates" (the caller filters them out before commit).
 */
export function vendorAlreadyLinked(rows: readonly VendorLinkRow[], vendorId: string): boolean {
  if (!vendorId) return false;
  return rows.some((r) => r.vendorId === vendorId);
}

/**
 * Append a vendor link row. No-op (returns the same array reference) when the
 * vendor is already linked (dup-guard) or the id is empty — so a caller can
 * branch on identity to surface a toast. Seeds the new row's cost / case price
 * from the optional `seed` (e.g. the item's last cost) so a freshly-attached
 * vendor isn't $0 by default; the user can override.
 */
export function addVendorLink(
  rows: readonly VendorLinkRow[],
  vendorId: string,
  seed?: { costPerUnit?: string; casePrice?: string },
): VendorLinkRow[] {
  if (!vendorId || vendorAlreadyLinked(rows, vendorId)) return rows as VendorLinkRow[];
  // Spec 114 — a freshly-attached vendor has NO order code yet (the admin types
  // it into the new per-vendor input); seed it empty. The `seed` bag stays
  // cost-only — attach never carries a code.
  return [
    ...rows,
    { vendorId, costPerUnit: seed?.costPerUnit ?? '', casePrice: seed?.casePrice ?? '', orderCode: '' },
  ];
}

/**
 * Remove the link row for `vendorId` (AC-C "removing a vendor removes its
 * link row").
 */
export function removeVendorLink(rows: readonly VendorLinkRow[], vendorId: string): VendorLinkRow[] {
  return rows.filter((r) => r.vendorId !== vendorId);
}

/**
 * Patch exactly one link's cost or case price (AC-C "editing a vendor's cost
 * updates only that link"). Returns a new array; other rows are untouched.
 */
export function updateVendorLinkField(
  rows: readonly VendorLinkRow[],
  vendorId: string,
  field: 'costPerUnit' | 'casePrice' | 'orderCode',
  value: string,
): VendorLinkRow[] {
  return rows.map((r) => (r.vendorId === vendorId ? { ...r, [field]: value } : r));
}

/**
 * Map the form's vendor rows to the db link-set payload shape
 * (`{ vendorId, costPerUnit, casePrice, orderCode? }` with numeric costs).
 * Drops rows with an empty / sentinel vendorId. Costs that don't parse coerce
 * to 0 (matches the rest of the form's `parseFloat(...) || 0` convention). This
 * is the array threaded to `db.createInventoryItem` / `db.updateInventoryItem`,
 * which reconciles `item_vendors` (upsert present, delete de-selected). An
 * empty result removes ALL links for the item.
 *
 * Spec 114 — `orderCode` is trimmed on save; an empty / all-whitespace code
 * becomes `undefined`, which `db.ts` coalesces to SQL NULL (`order_code:
 * l.orderCode || null`) — so a blank input clears the code rather than saving
 * `''` or the string `"undefined"` (AC-4's empty→null contract). A present code
 * is passed through trimmed.
 */
export function vendorRowsToLinkPayload(
  rows: readonly VendorLinkRow[],
): Array<{ vendorId: string; costPerUnit: number; casePrice: number; orderCode?: string }> {
  return rows
    .filter((r) => r.vendorId && r.vendorId !== NEW_VENDOR_SENTINEL)
    .map((r) => ({
      vendorId: r.vendorId,
      costPerUnit: parseFloat(r.costPerUnit) || 0,
      casePrice: parseFloat(r.casePrice) || 0,
      orderCode: (r.orderCode || '').trim() || undefined,
    }));
}

/**
 * Spec 104 — the per-unit cost is DERIVED, never hand-entered, and is now the
 * true per-EACH (smallest-unit) cost: `case_price / (case_qty × sub_unit_size)`
 * = `case_price / piecesPerCase`. `calcUnitCost` is the single source of that
 * formula (it divides by `piecesPerCase`), so this string wrapper just forwards
 * all three args and drops any divide of its own. The editor calls it whenever
 * case price, units/case, OR sub-unit size changes — and on load — so the
 * read-only cost/unit stays live. Returns a STRING for the text inputs, rounded
 * to 6 dp so genuinely sub-cent per-each costs (e.g. $0.0165/piece for a
 * 2000-count cup) survive while binary-float noise never reaches the saved
 * value; an empty string (→ the "0" placeholder) when there is no positive cost
 * yet (blank/zero/unparseable case price, units/case, or sub-unit size).
 */
export function derivedUnitCost(casePrice: string, caseQty: string, subUnitSize: string): string {
  const per = calcUnitCost(parseFloat(casePrice) || 0, parseFloat(caseQty) || 0, parseFloat(subUnitSize) || 0);
  return per > 0 ? String(Number(per.toFixed(6))) : '';
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
  /**
   * Spec 119 — fired by the SEPARATE "Apply vendors to all stores" action in
   * the VENDORS section. Provided ONLY in EDIT mode (a catalog ingredient must
   * already exist to fan out across the brand); undefined in NEW mode, in which
   * case the button is not rendered. The host (IngredientFormDrawer) owns the
   * confirm + store-action call + summary toast — this component just renders
   * the affordance and calls back. DISTINCT from Save (AC-1).
   */
  onApplyToAllStores?: () => void;
  /** Spec 119 — true while the brand-wide apply is in flight; disables the button. */
  applyingToAllStores?: boolean;
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
      {help ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
          {help}
        </Text>
      ) : null}
      {error ? (
        <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.danger }}>
          {error}
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

export const IngredientForm: React.FC<Props> = ({ mode, values, onChange, autoFocusName, onAddVendor, onApplyToAllStores, applyingToAllStores }) => {
  const C = useCmdColors();
  const T = useT();
  const isNew = mode === 'new';

  // Lookup data — sourced from the live store so realtime updates propagate
  // without the form needing to remount.
  const ingredientCategories = useStore((s) => s.ingredientCategories);
  const allConversions       = useStore((s) => s.ingredientConversions);
  const catalogIngredients   = useStore((s) => s.catalogIngredients);
  const vendors              = useStore((s) => s.vendors);
  const currentStore         = useStore((s) => s.currentStore);

  // Spec 096 (Issue 1) — the brand-scoped pool of custom unit NAMES, derived
  // at read time from data already in the store (no brand_custom_units table;
  // §Q-C = (ii)). Sourced from `catalogIngredients` — brand-level data the
  // store scopes to the active brand — NOT `inventory`, which is flat-mapped
  // across every visible store and leaks unit names across brands for an
  // unpinned admin/master (the spec 096 security finding; see brandUnitPool.ts).
  // Unioned into BOTH the default-unit AND pack-unit dropdowns below so a custom
  // name committed on any sibling ingredient (in its `unit` OR `subUnitUnit`)
  // appears here.
  const brandUnitPool = React.useMemo(
    () => deriveBrandUnitPool({ catalogIngredients, conversions: allConversions }),
    [catalogIngredients, allConversions],
  );

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
    //
    // Spec 096 — `isCustom` stays defined on the ORIGINAL sources (canonical
    // ∪ conversions ∪ 'each'), NOT the brand pool, so the spec-046 case-
    // preserved verbatim append for THIS ingredient's own value is unchanged
    // (AC4). The pool fold below skips that value's lowercase key to avoid a
    // "pack" + "Pack · custom" near-duplicate.
    const isCustom = !!curLower
      && !isCanonicalUnit(curLower)
      && curLower !== 'each'
      && !allConversions.some((c) => c.purchaseUnit.toLowerCase().trim() === curLower);
    if (curLower && !isCustom) acc.add(curLower);
    // Spec 096 (AC1, AC4) — union the brand pool ON TOP of canonical ∪
    // conversions ∪ 'each' ∪ stored value. Folded lowercase into `acc` the
    // same way conversion units are, so a name committed on a sibling
    // ingredient's `unit`/`subUnitUnit` becomes a pickable default-unit
    // option here. Skip the current custom value's key so its case-preserved
    // verbatim entry (appended below) stays the sole representation.
    for (const name of brandUnitPool) {
      const n = name.toLowerCase().trim();
      if (!n) continue;
      if (isCustom && n === curLower) continue;
      acc.add(n);
    }
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
      // Spec 096 (AC1) — when the current custom value is a recognized brand-
      // pool name (shared from a sibling ingredient), render it as a clean,
      // first-class option WITHOUT the misleading "· custom" suffix. We keep
      // the verbatim case-preserved option (rather than dropping it into the
      // lowercase pool fold) so the SelectField's byte-for-byte display lookup
      // still hits for legacy mixed-case values AND the type-custom snap (which
      // normalizes to lowercase, see validateCustomUnit) round-trips — both
      // would break if the option value's casing were forced. The suffix stays
      // only for a genuinely novel one-off string not shared anywhere.
      const inPool = brandUnitPool.some((n) => n.trim().toLowerCase() === curLower);
      out.push({ value: curRaw, label: inPool ? curRaw : `${curRaw} · custom` });
    }
    // Spec 046 — "+ custom…" sentinel always sits at the bottom.
    out.push({ value: CUSTOM_UNIT_SENTINEL, label: '+ custom…' });
    return out;
  }, [allConversions, brandUnitPool, values.unit, T]);

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
    const isCustom = !!curLower && !isCanonicalUnit(curLower);
    // Spec 096 (AC1) — insert the brand pool between the canonical seed and
    // the stored-value/sentinel tail. THIS is the line that makes a shared
    // name (e.g. "Pack" committed on a sibling) appear in the PACK-UNIT
    // dropdown — pre-096 this list unioned NOTHING derived, so a custom name
    // never reached here. Skip canonicals already present and skip the
    // current custom value's key (its case-preserved verbatim entry is
    // appended below as the sole representation).
    const seen = new Set<string>(CANONICAL_UNITS.map((u) => u.toLowerCase()));
    for (const name of brandUnitPool) {
      const n = name.toLowerCase().trim();
      if (!n || seen.has(n)) continue;
      if (isCustom && n === curLower) continue;
      seen.add(n);
      out.push({ value: n, label: unitLabel(n, T) });
    }
    if (isCustom) {
      // Spec 046 — keep the entry enabled (not disabled like the pre-046
      // pattern) so a user editing an existing ingredient can re-pick
      // their custom pack unit without being forced into the canonical
      // set. Value is the raw (case-preserved) stored string so SelectField's
      // display lookup hits.
      // Spec 096 (AC1) — drop the "· custom" suffix when the value is a
      // recognized brand-pool name so a shared pack unit reads as first-class,
      // not a one-off. Same rationale as defaultUnitOptions: the verbatim
      // case-preserved option is retained for display/snap round-trip safety.
      const inPool = brandUnitPool.some((n) => n.trim().toLowerCase() === curLower);
      out.push({ value: curRaw, label: inPool ? curRaw : `${curRaw} · custom` });
    }
    out.push({ value: CUSTOM_UNIT_SENTINEL, label: '+ custom…' });
    return out;
  }, [values.subUnitUnit, brandUnitPool, T]);

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

  // Spec 102 — vendor options NOT yet linked, for the "+ attach vendor"
  // picker. Excludes already-attached vendors (dup-guard at the UI layer)
  // and keeps the "+ new vendor" sentinel so a brand-new vendor can be
  // created inline and attached.
  const unlinkedVendorOptions = React.useMemo(() => {
    const linked = new Set(values.vendors.map((r) => r.vendorId));
    return vendorOptions.filter(
      (o) => o.value === NEW_VENDOR_SENTINEL || !linked.has(o.value),
    );
  }, [vendorOptions, values.vendors]);

  // Spec 102 — attach a vendor from the "+ attach vendor" picker. The
  // sentinel routes to inline vendor-create; a real id appends a link row
  // (seeded from the item's last cost). Dup-guard is enforced both by the
  // filtered options above AND by addVendorLink (defense in depth).
  const handleAttachVendor = (next: string) => {
    if (next === NEW_VENDOR_SENTINEL) {
      onAddVendor?.();
      return;
    }
    if (!next) return;
    const rows = addVendorLink(values.vendors, next, {
      costPerUnit: values.costPerUnit,
      casePrice: values.casePrice,
    });
    // If this is the first vendor attached, make it the primary so the item
    // has a primary pointer (SD-1); otherwise leave primary untouched.
    const v = vendors.find((vv) => vv.id === next);
    if (!values.vendorId) {
      onChange({ ...values, vendors: rows, vendorId: next, vendorName: v?.name || '' });
    } else {
      onChange({ ...values, vendors: rows });
    }
  };

  // Spec 102 — remove a link row. If the removed vendor WAS the primary,
  // re-point the primary to the first remaining link (or clear it when none
  // remain) so the scalar never dangles at a vendor with no link (SD-1).
  const handleRemoveVendor = (vendorId: string) => {
    const rows = removeVendorLink(values.vendors, vendorId);
    if (values.vendorId === vendorId) {
      const nextPrimary = rows[0];
      const v = nextPrimary ? vendors.find((vv) => vv.id === nextPrimary.vendorId) : undefined;
      onChange({
        ...values,
        vendors: rows,
        vendorId: nextPrimary?.vendorId || '',
        vendorName: v?.name || '',
      });
    } else {
      onChange({ ...values, vendors: rows });
    }
  };

  // Spec 102 — make a linked vendor the primary (SD-1: writes the scalar).
  const handleSetPrimary = (vendorId: string) => {
    const v = vendors.find((vv) => vv.id === vendorId);
    onChange({ ...values, vendorId, vendorName: v?.name || '' });
  };

  // Spec 104 — cost/unit is DERIVED (read-only) per-EACH, so the only editable
  // per-vendor field is case price; changing it recomputes that ONE link's
  // per-each cost = case_price / (units/case × sub-unit size). AC-C: patches
  // only the targeted link.
  const handleVendorCasePriceChange = (vendorId: string, value: string) => {
    if (value !== '' && !isNumericInput(value)) return;
    const withPrice = updateVendorLinkField(values.vendors, vendorId, 'casePrice', value);
    const withCost = updateVendorLinkField(withPrice, vendorId, 'costPerUnit', derivedUnitCost(value, values.caseQty, values.subUnitSize));
    onChange({ ...values, vendors: withCost });
  };

  // Spec 114 — the per-vendor order code is FREE TEXT (no numeric guard, no
  // derived sibling to recompute), so this is a plain single-link patch keyed on
  // vendorId. Mirrors handleVendorCasePriceChange minus the cost recompute;
  // updateVendorLinkField guarantees per-card isolation (only that vendorId's
  // row changes). (Spec 115 (W-4) removed the obsolete item-level vendorSku stub.)
  const handleVendorOrderCodeChange = (vendorId: string, value: string) => {
    onChange({ ...values, vendors: updateVendorLinkField(values.vendors, vendorId, 'orderCode', value) });
  };

  // Spec 104 — the top-level case price drives the headline per-each cost/unit
  // (same formula). cost/unit is read-only; case price is the only input.
  const handleCasePriceChange = (value: string) => {
    if (value !== '' && !isNumericInput(value)) return;
    onChange({ ...values, casePrice: value, costPerUnit: derivedUnitCost(value, values.caseQty, values.subUnitSize) });
  };

  // Spec 104 — units/case is a DENOMINATOR of every per-each cost/unit, so a
  // change recomputes the headline cost AND every vendor link's cost in lockstep.
  const handleCaseQtyChange = (value: string) => {
    if (value !== '' && !isNumericInput(value)) return;
    const vendors = values.vendors.map((r) => ({ ...r, costPerUnit: derivedUnitCost(r.casePrice, value, values.subUnitSize) }));
    onChange({ ...values, caseQty: value, costPerUnit: derivedUnitCost(values.casePrice, value, values.subUnitSize), vendors });
  };

  // Spec 104 — sub-unit size is the OTHER denominator of the per-each cost, so a
  // change must recompute the headline cost AND every vendor link's cost too
  // (mirrors handleCaseQtyChange). Without this, editing sub-unit size would
  // leave a stale derived cost. (This axis is also the recipe-costing sub-unit
  // count spec 093 defined; see the sub-unit input's inline note.)
  const handleSubUnitSizeChange = (value: string) => {
    if (value !== '' && !isNumericInput(value)) return;
    const vendors = values.vendors.map((r) => ({ ...r, costPerUnit: derivedUnitCost(r.casePrice, values.caseQty, value) }));
    onChange({ ...values, subUnitSize: value, costPerUnit: derivedUnitCost(values.casePrice, values.caseQty, value), vendors });
  };

  const vendorNameFor = (vendorId: string) =>
    vendors.find((vv) => vv.id === vendorId)?.name || vendorId;

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
            help="the smallest unit you count one of (each, lb, oz, mL)"
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
            help="the smallest unit you count one of (each, lb, oz, mL)"
          />
        )}
        {/* Spec 093 — CASE-SIZE input. Binds the canonical `caseQty`
            (→ case_qty), which reorder (088) and EOD (086) read as
            UNITS-PER-CASE. Previously this input was labeled "units / pack"
            and (wrongly) bound to subUnitSize, so "1 case = 20 lbs" landed the
            20 in sub_unit_size and left case_qty=1 — invisible to those
            features. The form key stays `caseQty` so db.ts:278-280 needs no
            change. */}
        <InputLine label="units / case" value={values.caseQty} onChangeText={handleCaseQtyChange} monoFont width="33%" numericOnly help="how many tracking units come in one case (e.g. 20 lbs per case)" />
        {/* Spec 093 — SUB-UNIT breakdown input. Binds `subUnitSize`
            (→ sub_unit_size): how many sub-units make up ONE tracking unit (per
            unitConversion's documented meaning). Distinct from the case size
            above. Spec 104 makes this a co-denominator of the per-EACH cost/unit
            (case_price ÷ (units/case × sub-units)), so editing it recomputes the
            read-only cost via handleSubUnitSizeChange. */}
        <InputLine label="sub-unit / unit" value={values.subUnitSize} onChangeText={handleSubUnitSizeChange} monoFont width="33%" numericOnly help="how many sub-units make up ONE tracking unit (e.g. a bag of 10 each)" />
      </View>
      <View style={{ marginBottom: 6 }}>
        {customMode.pack ? (
          <CustomUnitInput
            label="pack unit"
            value={customDraft.pack}
            error={customError.pack}
            help={'the unit each sub-unit is measured in — each, lb, oz. For abstract units like "case" or "tray", define their physical meaning on the Conversions tab.'}
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
            help={'the unit each sub-unit is measured in — each, lb, oz. For abstract units like "case" or "tray", define their physical meaning on the Conversions tab.'}
          />
        )}
      </View>
      {(() => {
        // Spec 093 — plain CASE-SIZE conversion readback. Reads as
        // "1 case = {N} {contentsUnit}". The noun before "=" is the literal
        // wrapper "case"; the unit after is the case CONTENTS — the pack unit
        // (subUnitUnit) when set, else the tracking/default unit.
        //
        // Spec 096 (AC9) — the NUMBER is now the REAL per-case piece count
        // `piecesPerCase = caseQty × subUnitSize`, not `caseQty` alone. For
        // the Cup (caseQty=1, subUnitSize=2000) this reads "2000" instead of
        // the misleading "1"; for a bulk item (caseQty=20, subUnitSize=1) it
        // still reads "20" (spec-093 behavior preserved). The same
        // `piecesPerCase` helper feeds the catalog-row per-each derivation so
        // the two surfaces can never drift. Contents-unit selection is
        // UNCHANGED per the architect's design (only the number changes).
        //
        // The guard stays on the RAW caseQty (not `pieces`, which always
        // defaults >= 1) so an empty/zero case size still renders NOTHING —
        // the spec-093 behavior the architect said to keep.
        const caseSize = Number(values.caseQty);
        if (!Number.isFinite(caseSize) || caseSize <= 0) return null;
        const pieces = piecesPerCase(caseSize, Number(values.subUnitSize));
        // contentsUnit = what's inside one case: the pack-contents unit
        // (subUnitUnit) when set, else fall back to `unit` (the tracking/DEFAULT
        // unit). The "case" noun on the left stays literal (per §9 + the note above).
        const contentsUnit = values.subUnitUnit || values.unit || 'each';
        return (
          <View style={{ marginTop: 4, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: CmdRadius.sm, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              {`1 case = ${pieces} ${contentsUnit}`}
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
        {/* Spec 104 (OQ-3) — per-EACH (smallest-unit) cost. Label + help make it
            read as per-each and expose the full divisor (units/case × sub-units). */}
        <InputLine label="cost / each" value={values.costPerUnit} monoFont width="50%" readOnly placeholder="0" help="auto · case price ÷ (units/case × sub-units)" />
        <InputLine label="avg cost / each" value={isNew ? '—' : values.costPerUnit} monoFont width="50%" readOnly
          help={isNew ? 'available after first receipt' : 'auto-computed · per-each'} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 0, marginBottom: 6 }}>
        <InputLine label="case price" value={values.casePrice} onChangeText={handleCasePriceChange} monoFont width="50%" numericOnly />
        <View style={{ width: '50%' }} />
      </View>

      {/* Spec 102 — multi-vendor editor. Replaces the single "primary vendor"
          picker: one ingredient can be attached to MULTIPLE vendors, each with
          its own cost + case price (per-(item,vendor) cost). One vendor is the
          PRIMARY (SD-1 — mirrors inventory_items.vendor_id); reorder/EOD
          surface the item under EACH attached vendor. The composite-unique
          (item_id, vendor_id) is the DB dup-guard backstop; the picker filters
          out already-attached vendors so the same vendor can't be added
          twice. */}
      <SectionCaption tone="fg3" size={9.5}>VENDORS · order from one or more</SectionCaption>
      <View style={{ marginTop: 8, marginBottom: 6, gap: 8 }}>
        {values.vendors.length === 0 ? (
          <View style={{ paddingVertical: 10, paddingHorizontal: 11, borderRadius: CmdRadius.sm, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.border, borderStyle: 'dashed' }}>
            <Text style={{ fontFamily: mono(400), fontSize: 10.5, color: C.fg3 }}>
              No vendors attached · this item won't appear in any vendor's count or reorder list. Attach one below.
            </Text>
          </View>
        ) : (
          values.vendors.map((row) => {
            const isPrimary = row.vendorId === values.vendorId;
            return (
              <View
                key={row.vendorId}
                style={{ padding: 10, borderRadius: CmdRadius.sm, backgroundColor: C.panel, borderWidth: 1, borderColor: isPrimary ? C.accent : C.border, gap: 8 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ flex: 1, fontFamily: mono(600), fontSize: 12, color: C.fg }} numberOfLines={1}>
                    {vendorNameFor(row.vendorId)}
                  </Text>
                  {isPrimary ? (
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, backgroundColor: C.accentBg }}>
                      <Text style={{ fontFamily: mono(700), fontSize: 9, color: C.accent, textTransform: 'uppercase', letterSpacing: 0.5 }}>primary</Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      onPress={() => handleSetPrimary(row.vendorId)}
                      accessibilityRole="button"
                      accessibilityLabel={`make ${vendorNameFor(row.vendorId)} primary`}
                      hitSlop={4}
                      style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1, borderColor: C.border }}
                    >
                      <Text style={{ fontFamily: mono(600), fontSize: 9, color: C.fg3, textTransform: 'uppercase', letterSpacing: 0.5 }}>make primary</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={() => handleRemoveVendor(row.vendorId)}
                    accessibilityRole="button"
                    accessibilityLabel={`remove ${vendorNameFor(row.vendorId)}`}
                    hitSlop={6}
                    style={{ paddingHorizontal: 6, paddingVertical: 2 }}
                  >
                    <Text style={{ fontFamily: mono(700), fontSize: 14, color: C.fg3 }}>×</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <InputLine
                    label="cost / each"
                    value={row.costPerUnit}
                    monoFont
                    width="50%"
                    readOnly
                    placeholder="0"
                    help="auto · case price ÷ (units/case × sub-units)"
                  />
                  <InputLine
                    label="case price"
                    value={row.casePrice}
                    onChangeText={(v) => handleVendorCasePriceChange(row.vendorId, v)}
                    monoFont
                    width="50%"
                    numericOnly
                    placeholder="0"
                  />
                </View>
                {/* Spec 114 — per-vendor order/SKU code, keyed on row.vendorId,
                    isolated per card. Free-form text (NOT numericOnly, NOT
                    readOnly) — the code the operator pastes into THIS vendor's
                    quick-order box. Spec 115 (W-4) removed the obsolete item-level
                    vendorSku stub that formerly sat below this vendor block; this
                    is now the only place codes live. */}
                <InputLine
                  label={T('section.inventory.orderCodeLabel')}
                  value={row.orderCode}
                  onChangeText={(v) => handleVendorOrderCodeChange(row.vendorId, v)}
                  monoFont
                  placeholder="—"
                  help={T('section.inventory.orderCodeHelp')}
                />
              </View>
            );
          })
        )}
        <SelectField
          label="+ attach vendor"
          value=""
          options={unlinkedVendorOptions}
          onChange={handleAttachVendor}
          placeholder={values.vendors.length === 0 ? '— pick a vendor —' : '— attach another vendor —'}
          allowEmpty
          help={values.vendors.length > 0 ? 'first vendor attached is the primary · tap "make primary" to change' : undefined}
        />

        {/* Spec 119 — SEPARATE, explicit "Apply vendors to all stores" action.
            DISTINCT from Save (owner decision: brand-wide propagation is always a
            deliberate button press, never a Save side effect). Rendered ONLY in
            EDIT mode (the host passes onApplyToAllStores only when a catalog
            ingredient exists to fan out). Applies the CURRENT submitted vendor
            set — attached vendors + primary + order codes — to this ingredient
            across every store of the brand; the host confirms first (brand-wide)
            and toasts the updated/skipped summary. Non-destructive on price:
            existing per-store prices are kept (see help text) — prices change on
            Save only. */}
        {onApplyToAllStores ? (
          <View style={{ marginTop: 4, gap: 6 }}>
            <TouchableOpacity
              onPress={onApplyToAllStores}
              disabled={applyingToAllStores}
              accessibilityRole="button"
              accessibilityLabel={T('section.inventory.applyVendorsAllStores')}
              activeOpacity={0.85}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: CmdRadius.sm,
                borderWidth: 1,
                borderColor: C.border,
                backgroundColor: C.panel2,
                alignItems: 'center',
                opacity: applyingToAllStores ? 0.5 : 1,
              }}
            >
              <Text style={{ fontFamily: mono(700), fontSize: 11, color: C.fg, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {applyingToAllStores ? '…' : T('section.inventory.applyVendorsAllStores')}
              </Text>
            </TouchableOpacity>
            <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3, lineHeight: 14 }}>
              {T('section.inventory.applyVendorsHelp')}
            </Text>
          </View>
        ) : null}
      </View>

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
        sku, reorder pt, max, avg cost. Editable fields save
        end-to-end via inventory_items.
      </Text>
    </ScrollView>
  );
};
