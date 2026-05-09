## Code review for spec 010

### Critical

_None._

### Should-fix

- `src/components/cmd/IngredientFormDrawer.tsx:62` — `toUpdates` returns `expiryDate: v.expiryDate ? v.expiryDate : undefined` when the field is blank; `updateInventoryItem` (db.ts:152) treats `undefined` as "do not touch this field" and skips `expiry_date` entirely. A user who blanks the "this row · expires" input to clear the date will silently do nothing — the old expiry stays in the DB. The form's own help text promises "blank to clear". Fix: return `expiryDate: v.expiryDate || null` so the `null` value reaches `updateInventoryItem`'s `expiry_date = updates.expiryDate || null` branch and actually clears the column.

- `src/screens/cmd/sections/ReceivingSection.tsx:133` — `computeExpiryFromShelfLife` is called with `new Date().toISOString().slice(0, 10)`, which yields the **UTC** date. `computeExpiryFromShelfLife` then adds shelf-life days in UTC and returns a UTC date string. But `computeAttentionQueue` (cmdSelectors.ts:888) interprets the stored `expiry_date` using **local-time** end-of-day parsing (`new Date(+m[1], +m[2]-1, +m[3], 23,59,59,999)`). On a negative-UTC machine (UTC-4) at 11 pm local time, the UTC date is already tomorrow — so a 1-day shelf-life item stamped at that moment gets `tomorrow + 1` as its expiry and the attention queue sees it as 47 local hours away instead of 23. The spec explicitly flagged this class of bug (Spec 007 TZ gotcha). Fix: derive the local date explicitly in `ReceivingSection.commitReceive`: `const t = new Date(); const localToday = \`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}\`;` then pass `localToday` to `computeExpiryFromShelfLife`. No change needed inside the helper; the UTC-anchored arithmetic inside is fine once the input date is local.

### Nits

- `src/lib/db.ts:1622-1634` — `computeExpiryFromShelfLife` is a pure date-math helper exported from `db.ts`, the project's Supabase I/O file. The architect's spec notes "Could live in `src/utils/` instead — dev's call." With zero DB calls inside it, living in `db.ts` is tolerable but slightly misleading to a reader scanning the file for PostgREST boundaries. Consider moving to `src/utils/dateHelpers.ts` (or similar) in a follow-up; not worth a standalone PR.

- `src/lib/cmdSelectors.ts:892-895` — the bucket ternary is written in a cascade format where the first arm (`hoursToExpiry <= EXPIRY_HIGH_HOURS ? 'high'`) already covers the already-expired case (`hoursToExpiry <= 0`). This is correct per the spec ("≤ 24h includes ≤ 0h") and the comment at line 679 explains the decision. The `≤ 0` case is invisible to the reader scanning the bucketing logic alone — a brief inline note (`// includes already-expired (hours ≤ 0)`) on the first arm would save the next reader a double-check.

- `src/components/cmd/IngredientFormDrawer.tsx:177-191` — the keyboard handler `useEffect` dep list is `[visible, values, mode, item]` but `catalogRow` (used on line 142 inside `handleSave`) is not listed. A realtime catalog update arriving while the drawer is open would leave `catalogRow` stale in the handler closure. Pre-existing `// eslint-disable-next-line react-hooks/exhaustive-deps` suppresses the lint warning. Adding `catalogRow` to the dep list would keep it fresh without other side effects (the handler re-registers on the next render, matching the existing `values`-in-deps pattern). Low probability of biting in practice (single-operator UI), but worth noting.

- `src/components/cmd/ExpiringItemsModal.tsx:71` — inner `TouchableOpacity` uses `onPress={() => {}}` as a click-stopper to prevent the backdrop from closing the modal when clicking inside the card. This is the established pattern (matches `AddCountModal.tsx:87`), so not wrong, but an empty arrow function is the only thing preventing event propagation; using `(e) => e.stopPropagation()` would be more explicit on web. Out-of-scope to change now.

- `src/screens/cmd/sections/ReceivingSection.tsx:19-23` — `shortExpiry` parses its ISO input with `new Date(iso)` (UTC midnight) then reads `getUTCMonth()` / `getUTCDate()`. This is internally consistent and displays the correct UTC calendar date. However it means a date that was stamped from the local-date-fix recommended above (once applied) would still display as the UTC-correct calendar label, which is what the DB stores. No action needed here once the Should-fix above is applied; noting the coupling so the next engineer doesn't have to re-derive it.
