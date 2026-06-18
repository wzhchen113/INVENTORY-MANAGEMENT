# Code review for spec 096 (round 2 — post-fix re-review)

Reviewer: code-reviewer
Spec: `specs/096-shared-units-and-dual-cost-display.md`
Files re-reviewed: `src/screens/cmd/sections/InventoryCatalogMode.tsx`,
`src/components/cmd/IngredientForm.tsx`.

Prior review flagged 0 Critical, 3 Should-fix, 4 Nits. This pass verifies the
3 Should-fixes and notes Nit disposition against the release proposal's
"Out of scope" list.

---

## Should-fix resolution

### S1 — catalog per-each label (`InventoryCatalogMode.tsx:424`)

Resolved. `const eachLabel = unitLabel(g.primary.subUnitUnit || 'each', T)` is
now derived and used in both the dual-line branch (line 427) and the
fallback-only branch (line 428). The hardcoded `unitLabel('each', T)` is gone.
Black Pepper (`subUnitUnit="lbs"`) now renders `$8.40/lb` as intended.

### S3 — `(perEach as number)` cast (`InventoryCatalogMode.tsx:427-428`)

Resolved. Both branches now use `perEach!.toFixed(2)`. The non-null assertion
is sound: `showPerEach` at line 411 gates on `perEach !== null`, making the
assertion accurate rather than suppressive. The prior `as number` pattern is
gone.

### S2 — pool names rendering as `"· custom"` (`IngredientForm.tsx:528-539`, `:574-585`)

Resolved, and the fix is correct. Full trace:

**The approach**: the fix does NOT change option `value` to case-preserved
strings (which would break the `validateCustomUnit` snap). Instead, it keeps
lowercase values in the body of both option lists, and only changes the
displayed `label` for the verbatim tail-append (the case-preserved entry that
enables byte-for-byte `SelectField` lookup for legacy mixed-case stored values).
The label becomes `curRaw` instead of `"${curRaw} · custom"` when
`brandUnitPool.some(n => n.trim().toLowerCase() === curLower)`.

**Trace — user picks from dropdown**: `packUnitOptions` loop pushes pool names
as `{ value: n, label: unitLabel(n, T) }` where `n` is lowercase (e.g.
`"loaves"`). User picks `"loaves"` → stored as `"loaves"`. On next open:
`curRaw = "loaves"`, `isCustom = true` (not canonical). The
`isCustom && n === curLower` guard at line 570 skips `"loaves"` in the loop,
so the loop entry does NOT appear. The `isCustom` block at line 584 computes
`inPool = true` → `out.push({ value: "loaves", label: "loaves" })`. No
duplicate. `SelectField` finds `o.value === "loaves"` — hits, displays
`"loaves"` with no `"· custom"` suffix. AC1 satisfied.

**Trace — user types "Loaves" via custom input**: `knownKeys` at line 812-816
includes `"loaves"` (the lowercase pool entry the loop pushed, since on this
open `curRaw` is the PRIOR stored value, not `"loaves"` yet, so the loop did
push it). `validateCustomUnit("Loaves", knownKeys)`: `lower = "loaves"`,
`knownLowercaseKeys.includes("loaves")` — true → `normalized = "loaves"`.
Stored as `"loaves"`. Same outcome as picking from dropdown. AC5 satisfied.

**Trace — legacy mixed-case `"Loaves"` in DB**: `curRaw = "Loaves"`,
`curLower = "loaves"`, `isCustom = true`. Loop skips `"loaves"`.
`inPool = true` → `out.push({ value: "Loaves", label: "Loaves" })`. Display
lookup `o.value === "Loaves"` hits. No `"· custom"`. Round-trip stable on re-
save without migration. If user re-types via custom input it snaps to
`"loaves"` — consistent with the pool's lowercase key. AC1 satisfied for
legacy values.

**Truly novel custom value**: `isCustom = true`, `inPool = false` →
`"${curRaw} · custom"`. One-off strings still get the suffix. Correct.

`defaultUnitOptions` follows the same structure with an identical `inPool`
guard at lines 538-539. Logic is symmetric.

**Verdict**: S2 is fully resolved. The `inPool` conditional-label approach
correctly achieves AC1 (no `"· custom"` on recognized shared names) without
breaking snap/de-dupe (AC5) or legacy mixed-case display. No new craftsmanship
issue introduced.

---

## Nit disposition (from prior review)

- **Nit 1** (`perEachCost.test.ts:33-36` — misleading test description for
  `piecesPerCase(1, 1)` as a "defaulting" case): not addressed. Intentionally
  deferred — release proposal "Out of scope" last bullet.

- **Nit 2** (`InventoryCatalogMode.tsx:399-404` — double `piecesPerCase`
  call, once for `pieces` and once inside `perEachCost`): not addressed.
  Intentionally deferred — release proposal "Out of scope."

- **Nit 3** (`IngredientForm.tsx:862` — tautological `"1 case = 2000 cases"`
  for empty-`sub_unit_unit` rows): not addressed. Intentionally deferred —
  release proposal "Out of scope (readback by design)."

- **Nit 4** (`brandUnitPool.test.ts` — no test for undefined `inventory`
  input): moot. `IngredientForm.tsx:393-395` now passes `catalogIngredients`
  instead of `inventory` (the security-finding fix), so the observation's
  argument changed shape. No new finding; the `add` helper's `(raw || '')`
  defensive handling is exercised by existing empty-string tests.

---

### Critical

No Critical findings.

### Should-fix

No remaining Should-fix findings. All three from the prior round are resolved.

### Nits

- `src/screens/cmd/sections/InventoryCatalogMode.tsx:399-404` — double
  `piecesPerCase` call (O(1), no runtime concern). Deferred per release
  proposal; noting for the next touch of this file.

- `src/utils/perEachCost.test.ts:33-36` — test description `'both axes
  unset/zero default to 1 → 1'` covers `piecesPerCase(0, 0)` (the defaulting
  case) and `piecesPerCase(1, 1)` (a normal multiply that happens to equal 1).
  The second assertion is not a defaulting case. Deferred per release proposal.
