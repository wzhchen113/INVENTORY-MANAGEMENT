## Security audit for spec 183

Auditor: security-auditor, 2026-10-26. Scope is the spec-183 staged files only:

- `src/components/cmd/ExportLanguagePrompt.tsx` (new)
- `src/components/cmd/ExportLocalePicker.tsx`
- `src/screens/cmd/sections/ReorderSection.tsx`
- `src/screens/cmd/sections/phone/PhoneOrdering.tsx`
- `src/i18n/{en,es,zh-CN}.json`, `section.reorder.exportLanguagePrompt.*` keys only

The staged index also holds other specs' files (the 176/177/179/180 migrations, `submission-push-fanout`, `useStore.ts` and others). Those were reviewed under their own specs and are not covered here.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **Defense in depth: the store-switch guard lives only in the prompt's render path.** See `src/components/cmd/ExportLanguagePrompt.tsx:106-111`, `src/screens/cmd/sections/ReorderSection.tsx:400-403` and `:588-605`, and `src/screens/cmd/sections/phone/PhoneOrdering.tsx:874-887`.
  - **What happens:** the hosts save `storeId` when the prompt opens, but only `ExportLanguagePrompt` compares it with the live `currentStore.id`. On a mismatch the prompt renders `null` and cancels, so Continue cannot be pressed. `runQuickOrder`, `runCsv`, `runPdf` and the phone `onPromptConfirm` never check the saved id themselves.
  - **Impact today:** none for data integrity. The file, `exportSnapshot` and the draft-PO record are all built from the same live `currentStore` / `reorderPayload`, so a draft PO can never be filed under a different store than the file it records. The only exposure would be a future refactor that drops the prompt's mismatch branch. A file for store B could then go out from a prompt the operator opened while looking at store A: a wrong-order mistake, not a cross-tenant leak.
  - **Fix (optional):** pass the saved `storeId` into the confirm handler and bail when `currentStore?.id !== openedFor`. That is one line at each of the four confirm sites. Not required for ship.

### Verification of the areas of interest

**1. Snapshot rule (2026-08-08 Mediums 1+2) under a user-paced prompt: holds.**
- All six sites now take the snapshot through one hoisted helper, `exportSnapshot(store, payload)` (`ReorderSection.tsx:161-166`). It runs synchronously at the top of each `run*`, after the null guard and before the first `await`:
  - desktop: `ReorderSection.tsx:417`, `:563`, `:580`
  - phone: `PhoneOrdering.tsx:800`, `:833`, `:850`
- The snapshot comes from the same `currentStore` / `reorderPayload` that the file is built from inside the same call. Neither value is re-read after an `await`.
- The pending-prompt state holds only `{ storeId }` / `{ format, storeId }` / `{ vendorId, format, storeId }`. It never holds a payload or date, so nothing from open time can go stale and end up in the record.
- `ExportLanguagePrompt.confirm` (`:98-102`) calls `onConfirm(picked)` synchronously with no timer, so the host's run starts in the same tick as the press.
- **Store switch while the prompt is open:** the prompt subscribes to `s.currentStore?.id` (`:88`). On a mismatch it returns `null` in the same render (`:111`), so no confirm control exists. It also calls the guarded `cancel()` in an effect (`:107-109`), which clears host state, so switching back cannot bring back a stale prompt.
- **Native phone 350 ms handoff:** if the switch happens before the prompt mounts, the first mounted render already sees the mismatch and cancels.
- **Store goes to null or `__all__`:** `PhoneOrdering` takes the early return at `:921`. Its hooks sit above that return, so the prompt is not rendered. When a store comes back, the mismatch check runs on mount.
- **Payload nulled:** the `if (!reorderPayload || !currentStore) return;` guards at the top of each `run*` make confirm a no-op. Phone also cancels silently when the prompt's vendor drops out of the list (`PhoneOrdering.tsx:784-789`).
- **Payload replaced for the same store** (spec-175 realtime reload): confirm builds the file and the snapshot from the new payload. They stay consistent with each other. Date controls sit behind the modal scrim, so a different-date replacement during the prompt is not reachable in practice.
- **Tests pin this:** `ExportLanguagePrompt.test.tsx:265+`, `ReorderSection.exportLanguagePrompt.spec183.test.tsx:474-500` and `PhoneOrdering.exportLanguagePrompt.spec183.test.tsx:316`.

**2. Cancel or dismiss has no side effects: confirmed.**
- Every dismiss path (Cancel button, `ResponsiveSheet.onClose` / backdrop, RN `Modal.onRequestClose` for Android back and web Escape) goes through the `firedRef`-guarded `cancel` (`ExportLanguagePrompt.tsx:92-96`).
- The host `onCancel` handlers only clear local React state:
  - `ReorderSection.tsx:511`, `:641`
  - `PhoneOrdering.tsx:888-891`
- Nothing is built, shared, recorded or cleared, and no toast or `onPreview` call runs, before confirm. The once-guard also blocks confirm after cancel and a double confirm.

**3. The picked locale never reaches `setLocale` or `profiles.locale`: confirmed.**
- Neither `ExportLanguagePrompt.tsx` nor `ExportLocalePicker.tsx` imports or calls `setLocale`, and neither touches `profiles`, AsyncStorage or localStorage. Grep of the spec-183 diff finds only the comment mentions.
- The picked value lives in component-local `useState` (`ExportLanguagePrompt.tsx:89`). It flows only into `onConfirm`, then into the builder's `locale` argument.
- Tests assert `setLocale` is never called: `ExportLanguagePrompt.test.tsx:240-251`, `ReorderSection...spec183.test.tsx:541-549` and `PhoneOrdering...spec183.test.tsx:241-246`.

**4. CSV formula injection: already mitigated before this spec. Spec 183 adds no new sink.**
- Item names reach the generic CSV through `buildReorderCsv` → `unparseCsvSafe` (`src/utils/reorderExport.ts:191-201`, `:275`). That function runs `csvSafeCell` on every string cell, which prefixes `'` when a cell starts with `= + - @ \t \r` (spec 139).
- The localized `es` / `zh-CN` names (`i18nNames`) go through the same unparse boundary as English, so a picked locale gets the same guard.
- The US Foods / SYSCO import file keeps its own `csvSafe` (`src/utils/vendorImportShared.ts:19-21`) and does not use the picked locale at all.
- Before spec 183, a user could already export every locale's names by switching the app language, so the prompt opens no new data path. Quick-order output is plain share or clipboard text, and the PDF is jsPDF text. Neither is a spreadsheet formula context.
- Pre-existing note, not a spec-183 finding: the guard does not catch a formula that starts after leading spaces. Excel does not evaluate those, so no action is needed.

**5. No new DB or edge surface: confirmed.**
- The spec-183 files add no `supabase.from` / `rpc` / `functions.invoke` / `fetch` call, migration, policy, RPC, edge function or `config.toml` entry.
- The only write on these paths is the unchanged spec-156 `recordExportedOrder` draft-PO upsert, reached only after a confirmed, successful export. It keeps its existing store-side guard and RLS (`auth_can_see_store`).
- New i18n strings render through RN `<Text>`. The `{vendor}` interpolation in `exportLanguagePrompt.subtitle` goes to a text node, not an HTML sink, so there is no XSS surface.
- No client-side `useRole()` value is used as a security boundary.

### Dependencies

`package.json` / `package-lock.json` are not in the change set, so `npm audit` was skipped.
