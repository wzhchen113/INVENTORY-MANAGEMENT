# Security audit for spec 140

Phone-tier EOD count (admin console) — presentation-layer change. Verdict: **clean, no blocking findings.** All five requested verification points confirmed. Nothing in the changeset touches auth, authz, secrets, the DB surface, or the dependency tree.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)
None.

### Medium
None.

### Low
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx:202-219` — the note field is a free-text `TextInput` written through `model.setNotes` into the existing `notesByVendor` map and submitted via the unchanged `submitEODCount` path. This is **not a new exposure** — it is the same note data model the desktop worksheet already writes, and RN `<Text>` rendering auto-escapes. Flagged only as a forward note: if a future phone pass wires these notes into the spec-139 CSV/PDF export (explicitly out of scope here), the export path — not this spec — would need to confirm it renders note text as data, not HTML. No action required for spec 140.

### Verification of the frontend-only claim (the review's five points)

1. **No new DB / RPC / edge-function call sites.** `grep` for `supabase.from|.rpc|functions.invoke|.from(|.rpc(` across `src/screens/cmd/sections/eod/` and `src/lib/eodKeypad.ts` returns nothing. Submission still flows through the parent's existing `model.onSubmit` (`PhoneEodCount.tsx:427`, `:405`), which is `EODCountSection`'s unchanged `onSubmit` handler → `submitEOD` store action → `submitEODCount` in `src/lib/db.ts`. No new submission path. Confirmed.

2. **No new store fields, no auth/role change, no widening of who can submit.** The phone gate is purely `if (isPhone)` at `EODCountSection.tsx:1048`, where `isPhone = useIsPhone()` (`EODCountSection.tsx:132`, imported from `theme/breakpoints`) — a viewport/platform check, NOT `useRole()`. `RoleRouter` is untouched; the Cmd UI still mounts only for admin/master/super_admin, so a phone viewport does not grant count-submit to any new caller. The `PhoneEodModel` bundle carries only data + callbacks already lifted in the parent; no new `useState`/store slice was added (`caseCountsByVendor` / `unitCountsByVendor` / `notesByVendor` / `eodSubmissions` are the existing ones). Confirmed.

3. **Keypad write-through cannot cross-write another vendor's / store's count map.** The child's `onKey` (`PhoneEodCount.tsx:120-128`) calls `model.setCaseCounts` / `setUnitCounts` keyed by `sheetItem.id`. Those setters (`EODCountSection.tsx:189-200`) close over `selectedVendorId` and write into `caseCountsByVendor[selectedVendorId]` — the single vendor-scoping key, and they early-return when `selectedVendorId` is null. `sheetItem` is derived from `model.filteredItems` (`PhoneEodCount.tsx:92-95`), which the parent scopes to `selectedVendorId` and (transitively) `currentStore.id`; a vendor switch drops the item from `filteredItems`, so `sheetItem` becomes null and the sheet auto-closes (`visible={isCountTab && !!sheetItem}`, `:456`). A write therefore always targets the currently-selected vendor within the current store — identical scoping to the desktop path. No cross-vendor / cross-store write is reachable. Confirmed.

4. **No secrets, no PII in logs, no injection surface.** `grep` for `console.*|innerHTML|dangerouslySetInnerHTML|eval|Deno.env|process.env|SERVICE_ROLE|apiKey|token|secret|password` across the new files returns nothing. Digit input is sanitized by the pure `appendKeypadDigit` (`src/lib/eodKeypad.ts:29-44`): only `0-9`, a single `.`, and backspace pass; max 5 chars; every other key is a no-op — no numeric-overflow or malformed-string reaches the count maps. All dynamic values render through RN `<Text>` (auto-escaped); no HTML sink exists on this surface. Confirmed.

5. **i18n additions are inert strings.** The 10 new `section.eod.phone.*` keys (`en.json` / `es.json` / `zh-CN.json`, `:581+`) are plain display strings with `{count}` / `{qty}` / `{total}` / `{unit}` placeholders resolved by the existing `T()` interpolator into `<Text>`. Parity preserved across all three locales. No HTML, no executable content. Confirmed.

### Dependencies
`package.json` changed, but the diff is a version bump only (`2.4.0` → `2.5.0`) already carried in prior commit `7f298c2`. No dependency added, removed, or upgraded — dependency attack surface unchanged. `npm audit` not warranted for this spec.
