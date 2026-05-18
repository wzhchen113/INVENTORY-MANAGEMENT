## Code review for spec 045

### Critical

_None._

### Should-fix

- `src/components/cmd/IngredientForm.tsx:415` — Help text for `units / pack` reads `"default units in one pack"` but the spec AC (line 20-21) and resolved-question block require `"how many default units in one pack"`. The missing `"how many "` prefix makes the phrasing inconsistent with the parallel `"how many packs at a time"` on the previous field. Fix: change the `help` prop value to `"how many default units in one pack"`.

- `src/components/cmd/IngredientForm.tsx:434` — When `subUnitUnit` is empty the code substitutes `'pack'` and then routes it through the pluralization rule, rendering `pack` (qty=1) or `packs` (qty>1). The spec AC (line 28) and the architect's design note ("render `pack(s)` literal when subUnitUnit is empty") both call for the literal string `pack(s)` — parentheses included — as a placeholder that signals to the user that no unit is selected. Fix: branch on `values.subUnitUnit` emptiness before building `packLabel`; when empty, use the literal string `'pack(s)'` as the display token and skip the pluralization path.

- `src/components/cmd/IngredientForm.tsx:438` — The `endsWith('s')` check is case-sensitive. The spec AC (line 31) explicitly requires a case-insensitive comparison ("append `s` unless the string already ends in `s` (case-insensitive)"). A pack unit stored or typed as `CASES`, `Bottles`, or `Cases` ends in uppercase `S`; `endsWith('s')` returns false and the code appends another `s`, producing `CASESs`. Fix: `packUnit.toLowerCase().endsWith('s')` (or `packUnit.endsWith('s') || packUnit.endsWith('S')`).

### Nits

- `src/components/cmd/IngredientForm.tsx:433` — The `unit` empty fallback (`|| 'each'`) silently swallows the spec AC requirement for when `unit` is empty (line 28-29: "when `unit` is empty, render `= {total} per order` without a unit noun"). In practice the `default unit` SelectField does not have `allowEmpty`, so an empty `unit` isn't reachable through normal form interaction — but the branch is unimplemented. Not a runtime bug today, but leaves the spec AC partially unmet if data-quality issues produce an empty `unit`. Worth a note in the code or a follow-up.
