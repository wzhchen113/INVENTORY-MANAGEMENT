# Spec 046: Custom-unit input on the ingredient form

Status: READY_FOR_REVIEW

## User story

As a store manager creating or editing an ingredient in the catalog form,
I want to type a custom unit (e.g. `case`, `box`, `can`, `bottle`, `tray`)
when none of the canonical mass/volume units fit my delivery container,
so that the ingredient row reflects how my vendor actually ships the item
instead of forcing me into an ill-fitting `lbs` / `gal` / `each` choice.

## Acceptance criteria

- [ ] AC1 — Both the `default unit` and `pack unit` SelectFields in
  `src/components/cmd/IngredientForm.tsx` show a `'+ custom…'` row as the
  last option, identified by the constant `CUSTOM_UNIT_SENTINEL = '__custom__'`.
- [ ] AC2 — Picking the sentinel on either field replaces the SelectField
  with an inline TextInput plus a back/clear control that returns to the
  dropdown without committing.
- [ ] AC3 — Typing a value and blurring (or pressing Enter) sets
  `values.unit` (resp. `values.subUnitUnit`) to the trimmed string verbatim
  and persists to `catalog_ingredients.unit` /
  `catalog_ingredients.sub_unit_unit` on save with no other code path
  rewriting the value.
- [ ] AC4 — Empty / whitespace-only inputs are rejected client-side: the
  TextInput shows a `required` error and the form's save button is blocked
  until the field is filled or the user returns to the dropdown.
- [ ] AC5 — When EDIT-ing an existing ingredient whose stored unit is not
  in `defaultUnitOptions` / `packUnitOptions`, the field renders the stored
  value as the selected display (does NOT show the `— pick unit —`
  placeholder, does NOT silently overwrite to empty on first render).
- [ ] AC6 — Typing a string that case-insensitively matches a canonical
  unit (e.g. `LBS`, `lbs`, ` lbs `) snaps to that canonical option instead
  of creating a duplicate non-canonical entry. Decision rationale recorded
  in spec for posterity.
- [ ] AC7 — Existing yellow `abstractUnitWarning` banner (file line ~326)
  continues to fire for custom units that lack a Conversions-tab row,
  preserving the current "Define on Conversions tab →" prompt.
- [ ] AC8 — No regression on `unitLabel(unit, T)` rendering: custom strings
  flow through the existing fallback branch unchanged (spec 039 contract).

## In scope

- Frontend-only changes inside `src/components/cmd/IngredientForm.tsx`.
- Sentinel constant export so tests / sibling components can import it.
- The "snap to canonical" normalization on save (AC6).
- The edit-mode display detection for unrecognized stored units (AC5).

## Out of scope (explicitly)

- New table or new DB column. The columns already accept arbitrary `text`
  (verified: `catalog_ingredients.unit text not null`,
  `sub_unit_unit text default ''`, no CHECK or domain constraint, no
  enforcement in any migration). Rationale: stored verbatim, per-ingredient.
- New RPC / edge function. The existing `create_inventory_item_with_catalog`
  and update RPCs already take `p_unit` / `p_sub_unit_unit` as `text`.
- Translation of `'+ custom…'` label. Per spec 038's IngredientForm
  English-only decision, the form stays English; defer i18n key add to
  a future translation pass.
- Auto-creating an `ingredient_conversions` row for the custom unit. The
  user is still expected to define physical meaning on the Conversions
  tab if they want recipe-cost math to work (yellow warning surfaces this).
- Renaming or restructuring `CANONICAL_UNITS` / `isCanonicalUnit`.
- Touching the staff app / customer PWA. They consume the same column
  with no parsing assumption — verified via grep against `staff-*` and
  `pwa-catalog` edge functions during PM walk.

## Open questions resolved

- Q: New table or per-row free text? → A: Per-row free text. Stored
  verbatim on `catalog_ingredients.unit` / `sub_unit_unit`. No new table.
- Q: UI pattern? → A: `'+ custom…'` sentinel in the SelectField that
  flips to inline TextInput, mirroring `NEW_VENDOR_SENTINEL` shape at
  `IngredientForm.tsx:77`.
- Q: Does this need a translation key for `'+ custom…'`? → A: No, per
  spec 038's English-only IngredientForm decision.
- Q: Should typing `lbs` create a non-canonical duplicate? → A: No.
  Snap to the canonical option (AC6) to avoid `lbs` / `LBS` / `Lbs`
  drifting in the data.
- Q: Should the new flow also push to the Conversions tab? → A: Defer
  to architect's Q2 audit below. PM's lean is "use the existing yellow
  warning banner; don't auto-redirect — that's a heavier UX change."

## Open questions for the architect

These are flagged for the architect to resolve in the design doc:

- **Q1 · unit-conversion math impact.** `toBaseUnit` and `fromBaseUnit`
  in `src/utils/unitConversion.ts` already return `null` for non-canonical
  units (lines 60-80). Walk the call sites and document which paths
  degrade gracefully (cost-calc returns `null` → host shows `—`) vs.
  which paths crash or display garbage. PM grep found zero callers of
  `toBaseUnit` / `fromBaseUnit` outside the file itself today, but
  there may be indirect usage via cost-rollup helpers — verify.
- **Q2 · Conversions-tab integration.** The form's help text says
  `For abstract pack units like "case" or "tray", define their physical
  meaning on the Conversions tab.` Decide if `+ custom…` should ALSO
  open the Conversions tab post-save, or if the existing yellow warning
  banner (`abstractUnitWarning`, line 326) is sufficient. PM leans
  toward "banner only; no auto-redirect."
- **Q3 · validation contract.** Specify exact reject rules: max length
  (PM suggests 32 chars), allowed characters (PM suggests
  `^[a-zA-Z][a-zA-Z0-9 .\-]*$` to keep it human-readable and reject
  XSS-y / control chars), case-folding on save (PM suggests lowercase
  trim, matching the existing `defaultUnitOptions` `.toLowerCase()`
  normalization on line 257).
- **Q4 · DB column constraint re-check.** PM verified
  `catalog_ingredients.unit` and `sub_unit_unit` are plain `text` with
  no CHECK in migrations
  `20260504060452_brand_catalog_p1_additive.sql` (lines 38, 42). No
  domain type, no trigger validation. Architect to spot-check
  `inventory_items.unit` (mirrored column, same constraint shape) and
  the related `_v2` RPCs in case any reject non-canonical strings.
- **Q5 · edit-mode display strategy** (referenced by AC5). Two options:
  (a) add the stored value to the options list as a `{ value, label,
  disabled: true }`-style item so the SelectField shows it but rejects
  re-pick — mirrors the existing `non-canonical` pattern on line 279;
  (b) auto-flip into TextInput mode when the stored value isn't in the
  options. Architect picks the cleaner option; PM leans (a) for
  consistency with line 279.
- **Q6 · jest test scope.** Test the sentinel-replacement reducer / pure
  logic if a test seam exists, OR defer to manual smoke if the logic
  is too entangled with the form's render tree. Architect decides
  whether to call for a test. If yes, name the jest track per spec 022.

## Dependencies

- None — no migration, no RPC change, no new edge function expected
  pending architect Q4 confirmation.
- Touches existing form file:
  `src/components/cmd/IngredientForm.tsx`.
- Reads from existing utility:
  `src/utils/unitConversion.ts` (`CANONICAL_UNITS`, `isCanonicalUnit`).
- Reads from existing label helper: `src/utils/enumLabels.ts`
  (`unitLabel` — graceful-fallback verified, lines 134-139).

## Project-specific notes

- **Cmd UI section.** `src/components/cmd/IngredientForm.tsx` — shared
  drawer component used from the CatalogSection drawer host.
- **Per-store or admin-global.** Brand-global. Writes through to
  `catalog_ingredients` (brand-scoped, not per-store).
- **Realtime channels touched.** `brand-{id}` already broadcasts
  `catalog_ingredients` UPDATE/INSERT today via the existing realtime
  subscription. No new channel; no publication change needed.
- **Migrations needed.** Probably no — pending architect Q4. If Q4
  surfaces an unexpected CHECK constraint, the migration timestamp slot
  is `20260518000000_*.sql` or later.
- **Edge functions touched.** None expected. `pwa-catalog` and
  `staff-*` consume the same column as raw text and don't parse it.
- **Web/native scope.** Both. `TextInput` is cross-platform; the
  sentinel pattern is already cross-platform via the existing
  `NEW_VENDOR_SENTINEL` precedent.
- **Test track.** Optional jest only, per architect Q6 decision. No
  pgTAP needed (no DB change). No shell smoke needed.
- **`app.json` slug.** Untouched.

## Backend / architecture design

UI-only spec. **No migrations, no RPCs, no edge functions, no `src/lib/db.ts`
helpers, no realtime channels.** All work happens inside
`src/components/cmd/IngredientForm.tsx` plus one new pure validator. The
backing columns (`catalog_ingredients.unit`, `catalog_ingredients.sub_unit_unit`)
are already `text` with no CHECK or domain constraint, and the upsert RPC
already takes `p_unit` / `p_sub_unit_unit` as `text`. Stored verbatim, end
of story.

### Resolution to PM's open questions

**Q1 — unit-math call-site audit (graceful-degradation confirmed).**
`toBaseUnit` and `fromBaseUnit` have no external callers; both are only
reached through `smartToBase` / `smartFromBase` / `convertToItemUnit` /
`getConversionFactor`. Walk:

1. `usageCalculations.ts:52` → `convertToItemUnit(rawQty, ing.unit, item, conversions)`.
   Returns `null` for unresolved abstract units. Caller (lines 53–69) sets
   `unitMismatch: true` and accumulates `qty = 0`. Display layer paints the
   row as mismatched, doesn't crash. Graceful.
2. `useStore.ts:2390 getPrepRecipeCost` → `getConversionFactor` returns
   `null` for non-canonical units. Line 2401 falls through to
   `ing.quantity` unmodified (treats as 1:1). Not ideal for a custom unit,
   but does not crash; cost math becomes an estimate the user can correct
   on the Conversions tab. Pre-existing behavior, not regressed by this
   spec.
3. `useStore.ts:2454 getIngredientLineCost` → tries
   `getConversionFactor(ing.unit, item.subUnitUnit || item.unit)`; if
   `null`, falls through to `ingredient_conversions` row lookup; if no
   row, returns `0`. Graceful.
4. `useStore.ts:2427 getPrepRecipeCostPerUnit` (legacy yield fallback) →
   `smartToBase` on an abstract unit hits the explicit `1:1 grams`
   fallback at line 124 ("better than losing data"). Pre-existing
   behavior. Not regressed.

**Conclusion:** custom units flow through existing `null`-aware paths.
Recipe cost-rollup either resolves via an `ingredient_conversions` row
(the user's job — surfaced by `abstractUnitWarning`) or degrades to
`0` / 1:1, with no crash. AC8 (no regression) holds. No defensive code
changes required outside the form.

**Q2 — Conversions-tab integration: banner-only, no auto-redirect.**
Take PM's lean. Reasons: (a) `abstractUnitWarning` (line 326–339)
already nags the user with `Define on Conversions tab →`; (b) the
Conversions tab is a sibling tab inside the same drawer, not a separate
screen — auto-switching tabs mid-form is jarring and clobbers in-progress
edits; (c) the form supports per-ingredient draft state via Zustand's
`pendingIngredient` slice, but tab-switch state is hosted by the drawer
parent and is not exposed to `IngredientForm` props today. Plumbing a
new prop just to switch tabs is heavier than the warning banner buys.
AC7 stands as-is.

**Q3 — Validation contract.** Override PM's regex suggestion. Keep it
simple — only what acceptance criteria require, no more:

```ts
// src/utils/validators.ts (additive — co-locate with existing isNumericInput)
export const CUSTOM_UNIT_MAX_LEN = 30;

export type CustomUnitValidation =
  | { ok: true; normalized: string; snappedToCanonical: false }
  | { ok: true; normalized: string; snappedToCanonical: true }
  | { ok: false; error: 'required' | 'too_long' };

export function validateCustomUnit(raw: string): CustomUnitValidation;
```

Rules (in this order):

1. `trimmed = raw.trim()`.
2. If `trimmed.length === 0` → `{ ok: false, error: 'required' }`.
3. If `trimmed.length > 30` → `{ ok: false, error: 'too_long' }`.
   30 not 32 — pluralized canonical labels render at ~28 chars in the
   form's mono font column and 30 gives the user a one-tick buffer
   without blowing the layout.
4. If `CANONICAL_UNITS.includes(trimmed.toLowerCase())` →
   `{ ok: true, normalized: trimmed.toLowerCase(), snappedToCanonical: true }`.
   AC6.
5. Otherwise → `{ ok: true, normalized: trimmed, snappedToCanonical: false }`.
   Preserve user's original case (vendor labels like "Case" or "Tray"
   are easier to read capitalized; lowercase coercion is a code smell
   when the column is free text).

**Explicitly rejected:** regex character-class filter. (a) Adds noise
to the validation surface for negligible safety gain — XSS is escaped
at render time by React Native's `Text` component, not at input time;
(b) the column is `text`, the RPC takes `text`, and downstream
consumers (`pwa-catalog`, `staff-*`) display the string raw. Lifting
character restrictions is a future call when we see actual abuse, not a
pre-emptive guard.

**Q4 — DB constraint spot-check (no migration needed).** Grepped:
- `catalog_ingredients.unit text not null` (migration
  `20260504060452_brand_catalog_p1_additive.sql:38`) — no CHECK.
- `catalog_ingredients.sub_unit_unit text default ''`
  (`20260504060452_brand_catalog_p1_additive.sql:42`) — no CHECK.
- `inventory_items.unit` was **dropped** in P3 lockdown
  (`20260504072830_brand_catalog_p3_lockdown.sql:60`); per-store rows no
  longer carry a unit column. The PM's spot-check note in Q4 is
  outdated against current schema — confirm with the developer there is
  nothing to migrate on `inventory_items`.
- RPCs `create_inventory_item_with_catalog` and the v2 catalog-upsert
  variants take `p_unit text default ''` / `p_sub_unit_unit text default ''`
  — accept arbitrary strings.
- No `ingredient_conversions.purchase_unit` CHECK either (also `text`).

**No migration. Confirms spec's "Out of scope: new DB column" line.**

**Q5 — Edit-mode display: option (a), disabled-option-in-list.**
Take PM's lean. The existing pattern at `IngredientForm.tsx:279` already
surfaces stored non-canonical pack units as
`{ value, label: '… · non-canonical', disabled: true }`. Mirror it for
the default-unit dropdown — the `defaultUnitOptions` memo at
line 254–269 already auto-includes `values.unit` into the option set
(line 266–268), so the value renders in the closed dropdown by name.
The change is: when `values.unit` is set AND it is neither in
`CANONICAL_UNITS` nor in any `c.purchaseUnit`, append it with a
`· custom` label suffix (parallel to `· non-canonical` on line 279) and
**leave it enabled** so the user can re-select / keep it.

Rationale for (a) over (b): consistent with line 279's existing
treatment, avoids the rendering flicker of auto-flipping the field into
TextInput on form mount, and keeps the back-out path
(pick a canonical from the same dropdown) one click away.

**Q6 — jest test scope: yes, narrow.** Write one test file:
`src/utils/validators.test.ts` (or extend the existing file if it
exists — developer to check) covering `validateCustomUnit`. Cases:
empty → `required`; whitespace-only → `required`; 31 chars →
`too_long`; `'LBS'`, `'lbs'`, `' lbs '` → snap with
`snappedToCanonical: true, normalized: 'lbs'`; `'case'`, `'Tray'`,
`'12oz can'` → pass through with `snappedToCanonical: false`, original
case preserved on the non-canonical path.

**No** jest test on the form's render tree. The sentinel-flip behavior
is render-tree-coupled (state in `useState`, paths into
`SelectField` / `TextInput` swap), and per spec 022 §9 the project
keeps jest scoped to pure-logic helpers — the renderer paths are
covered by manual smoke. Track: jest unit (the same track that holds
`relativeTime.test.ts`).

### Frontend contract (no backend surface)

**SelectField behavior.** The two existing SelectFields (default unit
at line 405, pack unit at line 418) gain a sentinel option `'+ custom…'`
with value `CUSTOM_UNIT_SENTINEL = '__custom__'`. Exported from
`IngredientForm.tsx` next to `NEW_VENDOR_SENTINEL` (line 77) so the
test file and any future sibling can import it. Position: last item in
the option array, **after** any disabled non-canonical / custom edit-
mode entry, so the visual order is `canonical → user's stored value →
+ custom…`.

`onChange` handler dispatch:

```
on default-unit SelectField onChange(v):
  if v === CUSTOM_UNIT_SENTINEL → setCustomMode('default', true)
  else                          → set('unit', v)

on pack-unit SelectField onChange(v):
  if v === CUSTOM_UNIT_SENTINEL → setCustomMode('pack', true)
  else                          → set('subUnitUnit', v)
```

`customMode` is a new component-local `useState<{ default: boolean; pack: boolean }>` (or two booleans). NOT
persisted to `values`; it's purely a render flag. When it flips to
`true`, the SelectField unmounts and an inline `<TextInput>` mounts in
its place, with a small "← back to list" button (mirror the visual
shape used by the existing form for paired control + tertiary action).

**TextInput inline-replacement shape.**

```
Visible component when customMode.default === true:
  [TextInput · custom unit] [✕ back]
  on blur OR Enter:
    res = validateCustomUnit(currentText)
    if !res.ok:
      setError('required' | 'too long (max 30)')
      stay in customMode
    else:
      set('unit', res.normalized)
      setCustomMode('default', false)   // flip back to SelectField; the
                                         // value is now visible there via
                                         // the auto-included edit-mode
                                         // option from Q5
      if res.snappedToCanonical: optional one-shot toast
        'Matched canonical lbs — using the standard option.'
        (nice-to-have, not required by AC)
  on ✕ back press:
    setCustomMode('default', false)     // no value commit
```

The Q5-style auto-inclusion in the option list (already in place at
line 254–269 for default-unit; new for pack-unit) ensures the
SelectField immediately shows the new string after flip-back; no
flicker.

**Save-button gate.** Add to the existing required-field check that
disables Save: if any `customMode.*` flag is `true` (the user opened
the inline TextInput but hasn't committed via blur/Enter or backed
out), disable Save. AC4. The dirty-text in the inline TextInput is
component-local; treat unclosed custom-entry as a pending edit.

### Realtime / store / RLS impact

- **Realtime:** none. `catalog_ingredients` UPDATE/INSERT already
  fans out on `brand-{id}`; the column value is opaque text and is
  already replayed.
- **Zustand store:** none. The form already writes `values.unit` and
  `values.subUnitUnit` through the existing `saveIngredient` /
  `updateIngredient` paths in `useStore`; no new action.
- **RLS:** none. No new tables, no policy edits. `catalog_ingredients`
  policies (admin-write, `auth_can_see_store` for cross-brand reads
  via the per-store brand mapping) are unaffected.
- **`src/lib/db.ts` surface:** none. Existing helpers
  (`upsertCatalogIngredient`, `updateCatalogIngredient`) already accept
  arbitrary `unit` / `subUnitUnit` strings and pass them through to
  the `text`-typed RPC parameters.

### Risks and tradeoffs

- **Cost-math degrades for custom units without a conversion row.**
  Pre-existing — the yellow `abstractUnitWarning` is the user's
  reminder. Not introduced by this spec; called out for the developer
  so the test plan reflects "no regression vs. current `case` /
  `tray` behavior."
- **Case-preservation on non-canonical (Q3 §5) is a small drift from
  the line 257 lowercase normalization of conversion-derived
  options.** Mitigation: the option-list memoization (line 254–269)
  lowercases its keys for dedup; the user's displayed value is fed
  through `unitLabel(u, T)` which renders raw. Cosmetic only.
- **30-char cap is judgment, not data-driven.** If a real vendor needs
  longer, raise the cap. Don't bake max into a future DB CHECK; keep
  it client-side.
- **No DOM-id collision for the inline TextInput.** Both inline inputs
  are rendered conditionally — they never coexist (default vs. pack
  are separate state flags but only one of each shows at a time). No
  `id` / `accessibilityLabel` collision risk worth a guard.
- **Custom strings flow into vendor reports / waste reports as-is.**
  Verified the report RPCs do not parse `unit` — they pass it through
  as a result column. Custom string `"case of 24"` will show up
  verbatim in the report. Acceptable, matches PM intent.

### Files the developer will touch

- `src/components/cmd/IngredientForm.tsx` — sentinel const,
  `customMode` state, conditional render of SelectField vs.
  TextInput, save-button gate, Q5 disabled-option list extension for
  default-unit (mirror of the pack-unit line 279 block).
- `src/utils/validators.ts` — append `CUSTOM_UNIT_MAX_LEN`,
  `validateCustomUnit`, and the result-shape type.
- `src/utils/validators.test.ts` — Q6 jest tests.

## Handoff
next_agent: frontend-developer
prompt: Implement Spec 046 against the design in this file. UI-only,
  inside `src/components/cmd/IngredientForm.tsx` plus a pure
  `validateCustomUnit` helper in `src/utils/validators.ts` plus its
  jest tests. No backend, no migration, no `src/lib/db.ts` change.
  Mirror the existing `NEW_VENDOR_SENTINEL` shape for the new
  `CUSTOM_UNIT_SENTINEL`. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/046-custom-unit-input.md

## Implementation notes (frontend-developer · 2026-05-18)

- Per the user's override to the architect's file plan, the
  `validateCustomUnit` helper, `CUSTOM_UNIT_SENTINEL` constant, and
  `CUSTOM_UNIT_MAX_LEN` cap live inside `src/components/cmd/IngredientForm.tsx`
  (exported for testability) rather than `src/utils/validators.ts`. The
  jest test file sits next to the component at
  `src/components/cmd/IngredientForm.test.ts`.
- `jest.config.js` was extended to match `.test.ts` files under
  `src/components/**` in the component (jsdom) project, because the test
  imports a helper from a `.tsx` file (which transitively pulls in
  react-native). Pure-logic tests without a `.tsx` dependency still
  belong under `src/utils/` to stay in the fast node-env project; that
  pattern is enforced by a comment in the config.
- AC4 save-button gate: the user's "don't touch IngredientFormDrawer.tsx"
  scope means the save button itself stays enabled (matching the
  pre-046 spec-004 fix-pass behavior where required-field validation
  runs inside `handleSave` with a Toast on miss). Within the form, the
  inline `CustomUnitInput` validates on blur / Enter and refuses to
  commit an empty value — so picking the sentinel and trying to blur
  away leaves the field in custom mode with a `required` error visible.
  The user must either type a valid value or click `×` to back out.
  This preserves the spirit of AC4 within the file scope the user
  authorized.
- Case preservation (architect Q3 §5): the option-list memos for both
  default-unit and pack-unit were updated to append the stored value
  *verbatim* (case-preserved) rather than via the existing lowercase
  dedup-set. Without this, a user-typed "Case" would be stored as
  "Case" but the dropdown would only render the lowercased "case" entry,
  breaking the SelectField's byte-for-byte display lookup.
- Pack-unit non-canonical option is now `enabled` (was `disabled: true`
  in the pre-046 pattern at the old line 279). Disabling a custom value
  that the user just committed would be a UX dead-end, so the change
  unifies the default- and pack-unit treatment as "annotated with
  · custom suffix, fully selectable."
- Browser verification: this agent does not have `preview_*` MCP tools
  loaded in this session, so the spec's "Web verification" step was
  performed indirectly via `npm run typecheck` (passes) and `npm test`
  (157 tests passing, including the 15 new ones). The dev server is
  alive at http://localhost:8081 (HTTP 200). A reviewer with browser
  tools should sanity-check the "+ custom…" → TextInput → back swap.

## Files changed

- `src/components/cmd/IngredientForm.tsx` — added `CUSTOM_UNIT_SENTINEL`
  constant, `CUSTOM_UNIT_MAX_LEN` cap, `CustomUnitValidation` type, and
  `validateCustomUnit` pure helper (all exported). Added local
  `CustomUnitInput` component (inline TextInput + `×` cancel). Extended
  `defaultUnitOptions` and `packUnitOptions` memos to append the
  sentinel row and the case-preserved stored-value option. Updated
  both SelectField onChange handlers to flip into customMode on
  sentinel pick and the conditional render to swap to `CustomUnitInput`
  when customMode flag is true. Pack-unit non-canonical entries
  flipped from `disabled: true` to enabled with a `· custom` suffix.
- `src/components/cmd/IngredientForm.test.ts` — new file. 15 jest cases
  covering `validateCustomUnit` empty / whitespace / 30-char boundary /
  31-char rejection / canonical snap (all 8 units) / case-preservation
  non-canonical paths. Mocks `../../lib/supabase` at the boundary so
  importing the form's pure helper does not crash on missing env vars.
- `jest.config.js` — extended the component (jsdom) project's
  `testMatch` to include `<rootDir>/src/components/**/*.test.ts` so
  the new test file is discovered. Includes a comment explaining when
  to use this pattern vs. the faster node-env `src/utils/` track.

## Files changed · Round-2 (code-reviewer fixes · 2026-05-18)

Addresses the code-reviewer.md findings (2 Critical, 4 Should-fix, 1 Nit):

- `src/components/cmd/IngredientForm.tsx` —
  - C1 (double-commit on web Enter): `CustomUnitInput` now holds a
    `committedRef` latch. The first `handleCommit` / `handleCancel`
    invocation flips the latch, calls the parent callback, and queues
    a `setTimeout(…, 0)` reset; the second invocation within the same
    React batch (blur after onSubmitEditing) is a no-op. Parent's
    `onChange` now fires exactly once per Enter.
  - SF1 (redundant `onKeyPress` Enter trap): removed. RN Web 0.21
    synthesizes `onSubmitEditing` reliably for `TextInput`; the trap
    was the third commit path and contributed to the same double-fire
    symptom.
  - C2 (`validateCustomUnit` doesn't snap `each` / conversion units):
    extended `validateCustomUnit(raw, knownLowercaseKeys = [])` with a
    new optional arg. The helper now case-insensitively snaps to the
    canonical set first, then to any caller-supplied known-lowercase
    keys. Both `onCommit` handlers in the form build their known-keys
    array live from the relevant dropdown's option list (default-unit
    reads from `defaultUnitOptions`; pack-unit reads from
    `packUnitOptions` PLUS every `allConversions.purchaseUnit`).
    Typing `EACH`, `Each`, `BAG`, etc. now snaps to the lowercase form
    the SelectField's display lookup expects.
  - SF2 (banner case preservation): `abstractUnitWarning` interpolates
    `curRaw` (raw trimmed) in the warning text instead of the
    lowercased `u`. Banner now reads `No conversion defined for "Case"`
    for a committed `Case`, not `"case"`. The comparison still uses
    the lowercased value, so a stored `CASE` matches a conversion row
    keyed by `case`.
  - Nit: updated the comment on the `×` back-out button to acknowledge
    the round-2 commit-path race (not just the original cancel-path
    race).
- `src/components/cmd/IngredientForm.test.ts` —
  - SF3 (jest mock placement): added an inline explanatory comment
    above `jest.mock(...)` noting that Babel hoists the call above the
    `import` line at compile time, so the placement is intentional.
  - SF4 (hardcoded canonical list): the "snaps each canonical unit"
    test now drives its loop from the live `CANONICAL_UNITS` import
    from `../../utils/unitConversion`; a future addition to the
    canonical registry automatically exercises the snap path.
  - C2 coverage: 6 new `it()` cases under a new `describe` block for
    the `knownLowercaseKeys` arg — `EACH`/`Each`/`BAG` snap, canonical
    precedence over known-keys, non-known pass-through case-preserved,
    and empty-arg backward compatibility.
  - Header comment refreshed: the case-list inventory now includes
    the new round-2 cases (and the test count went from 15 to 21).
