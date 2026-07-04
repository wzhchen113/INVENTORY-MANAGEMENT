## Code review for spec 111

### Critical

None.

### Should-fix

None.

### Nits

- `src/store/useStore.switching.test.ts:161` — dead/stale intermediate `useStore.setState({ currentStore: storeB, ... })` call in T3b. It is immediately overwritten by the next line (`store-c`, line 162) before `setCurrentStore` is invoked, so it has no effect on the assertion. The comment above it ("Now prev = storeA") doesn't match either the dead line or the line that actually matters (line 162's `store-c`, which the comment at line 164 correctly describes). The test's assertion is still correct — `fallback = accessible[0] = storeA` vs. `prev.id = 'store-c'` → real switch, `switching` correctly becomes `'store'` — this is a readability nit, not a logic bug. Delete line 161 and fix the stale comment (deferred to test-engineer's territory, flagging here since I read the file for wiring verification).
- `src/store/useStore.ts:1126` — pre-existing `if (!sid) return;` guard sits before `set({ storeLoading: true })` and thus before the `try/finally` that resets `switching`. Not reachable from either switch entry point today (both `setCurrentStore` and the `__all__` fallback always pass a concrete, truthy id, and the `__all__` branch already early-returns via `if (!fallback) return;` before calling `loadFromSupabase`), so this cannot currently strand the overlay. Noting only because it's the one place in `loadFromSupabase` that exits without touching `switching` — if a future caller ever invokes `loadFromSupabase(someOptionallyEmptyId)` after having escalated `switching` first, the overlay would strand. Out of scope for this spec (pre-existing guard, untouched by the diff) — surfacing as a forward-looking note, not a spec-111 defect.
- `src/components/cmd/StoreSwitchOverlay.tsx:54-55` — `zIndex: 100` / `elevation: 100` on the overlay's `absoluteFillObject` style is explicitly called out in the design note as "belt-and-suspenders" (RN paints in document order and the shell already mounts this last), and the component's own comment says the same. Genuinely harmless defense-in-depth per the design note — not a finding, just confirming it's intentional and documented rather than stray dead styling.

### Confirmed clean (no findings)

For completeness, since this spec touches store-lifecycle logic that's easy to get subtly wrong — verified against the design note's exact contract:

- **Escalate-not-downgrade guard** (`useStore.ts:772`, `:780`) — both the `__all__` fallback branch and the normal branch use the identical `id !== prev.id && prev.id !== '' && get().switching === null` shape, with `prev` captured once at the top of the action (`:757`) before the `__all__` branch, matching AC-1 and decision 2 verbatim.
- **Brand-copy-survives-delegation** (`useStore.ts:818-819`) — `setCurrentBrandId` sets `switching: 'brand'` before calling `get().setCurrentStore(newStore)`; since `setCurrentStore` only escalates from `null`, the pre-set `'brand'` is never clobbered to `'store'`. T6/T7 pin this at both the integration and unit level.
- **Single reset point** — exactly five writes to `switching` in the whole file (`grep switching:` → `:672` initial, `:773`/`:781` setCurrentStore escalations, `:818` brand pre-set, `:1243` the one `finally` reset). No redundant `set({ switching: null })` was added in either no-load brand branch, matching decision 3's explicit "do not add" instruction.
- **No-load branches don't strand** (`useStore.ts:795-804`, `:820-830`) — both the "All brands" null branch and the fresh-brand-no-stores branch never touch `switching`; T8a/T8b pin this.
- **Overlay mount** — `ResponsiveCmdShell.tsx:368` computes the gate once (`switching !== null ? <StoreSwitchOverlay mode={switching}/> : null`) and all three breakpoint branches (phone `:402`, tablet `:465`, desktop `:495`) insert `{switchOverlay}` as the last child of the same `cmd-shell-root` View — one absolute-fill child per branch, exactly as the design note flagged (RN has no shared wrapper across the three `return`s, so three insertions of one element, not one insertion).
- **Theming** — `StoreSwitchOverlay.tsx` uses only `useCmdColors()` tokens (`C.bg`, `C.fg`, `C.accent`); no hardcoded hex/named colors. Verified `bg`/`fg`/`accent` all exist on both `LightCmd`/`DarkCmd` palette objects.
- **Cross-platform** — no `window`/`document`/`navigator` reference anywhere in `StoreSwitchOverlay.tsx`; only `View`/`ActivityIndicator`/`Text`/`StyleSheet.absoluteFillObject`.
- **i18n** — `common.switchingStores` / `common.switchingBrands` present in `en.json:87-88`, `es.json:87-88`, `zh-CN.json:87-88`, siblings of `common.loading`/`common.saving` as specced, with real (non-placeholder) es/zh-CN translations. The pre-existing `src/i18n/i18n.test.ts` identical-key-set assertion auto-covers parity with zero new test needed, as the spec claimed.
- **No direct Supabase calls / no `db.ts` changes / no `confirmAction` misuse / staff subtree untouched** — grepped for `Spec 111` / `switching` in `db.ts` (no hits) and confirmed no `supabase.from`/`supabase.rpc` call sites in any of the five implementation files.
- **Test coverage vs. design note's T1-T10 list** — all ten cases are present and exercise real state transitions (not shape-only): `useStore.switching.test.ts` covers T1-T8 (including the escalation-not-downgrade unit test T7 and the load-error path T5, which correctly asserts `switching` clears even when `fetchAllForStoreMock` rejects), `StoreSwitchOverlay.test.tsx` covers T9 (single-field render gate) and T10 (copy per mode) plus the testID/a11y mount contract.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **Nit 1 (dead setState line + stale comment in T3b) — FIXED.** The overwritten
  intermediate `setState({ currentStore: storeB, ... })` at
  useStore.switching.test.ts:161 is removed and the comment now describes the
  line that actually matters (prev = store-c → real change through the __all__
  redirect). Suite re-run: 10/10.
- **Nit 2 (pre-existing `if (!sid) return;` early-out before the finally) — NO
  ACTION**, per the reviewer's own framing: unreachable from both switch entry
  points today, pre-existing, out of scope. The forward-looking note stands in
  the review for any future caller.
- **Nit 3 — confirmation, not a finding.** No action.

Also from the test-engineer's notes: the spec's "Files changed"/"Verification"
test-count claim corrected (20 → 16: 10 store + 6 overlay).

Post-fix gates: jest 966/966 (87 suites), both typechecks exit 0.
