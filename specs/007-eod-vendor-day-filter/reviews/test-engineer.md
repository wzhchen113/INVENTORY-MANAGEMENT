## Test report for spec 007

### Acceptance criteria status

- **AC1**: On `EODCountSection`, when a day cell is selected in the left rail (`selectedIso` = some date), the vendor tab row reflects only vendors scheduled for that day's day-of-week for the current store. → **VERIFIED** (browser-confirmed by main Claude post-fix-pass; code-verified: `vendorTabs` memoized at EODCountSection.tsx:197-201 filters `allVendorTabs` against `dayScheduledVendorIds` derived from `orderSchedule[selectedDayName]`)

- **AC2**: "Scheduled for that day" is sourced from the `order_schedule` row set at `(store_id = currentStore.id, day_of_week = <Mon..Sun for the selected ISO date>)`. → **VERIFIED** (code-verified: `dayScheduledVendorIds` at line 179 reads `orderSchedule?.[selectedDayName]` where `selectedDayName = DAY_NAMES[new Date(selectedIso + 'T00:00:00').getDay()]`; `orderSchedule` slice populated by `fetchOrderSchedule(storeId)` in `loadFromSupabase`; local DB confirmed 2 rows at correct grain)

- **AC3**: If no `order_schedule` rows exist for that `(store, day_of_week)`, the vendor row renders an empty state with a clear, actionable message. → **VERIFIED** (code-verified: EODCountSection.tsx:606-611 renders `"no vendors scheduled for ${selectedDayName.toLowerCase()}"` when `vendorTabs.length === 0 && scheduleConfigured && !showUnscheduled`; browser-confirmed for Wednesday with no schedule entry; empty state also guards `!scheduleConfigured` path differently — shows "no vendors with items at this store" which is the correct fallback copy for the "store has no schedule rows at all" case)

- **AC4**: Switching `selectedIso` to a different weekday updates the vendor row to that weekday's scheduled vendors without a manual refresh. → **VERIFIED** (browser-confirmed: clicking rail cells re-derives `selectedDayName` → `dayScheduledVendorIds` → `vendorTabs` via dependent `useMemo` chains; no network round-trip)

- **AC5**: When the schedule changes elsewhere (e.g. another admin edits it), the vendor row updates within the existing realtime debounce window on the same store/brand channels — no new realtime channel. → **CODE-VERIFIED (with scope revision)** — Architect §5 revised this AC: same-tab changes propagate immediately via optimistic write; cross-tab/cross-device propagation is NOT guaranteed without a manual refresh. `order_schedule` IS in the `supabase_realtime` publication (confirmed locally: `select from pg_publication_tables where pubname='supabase_realtime' and tablename='order_schedule'` returns 1 row). However, `useRealtimeSync.ts` was not modified to subscribe to `order_schedule` changes — so the realtime event arrives at the channel level but triggers a reload only if one of the already-watched tables fires first. The revision is documented in the build notes and is an accepted V1 trade-off.

- **AC6**: The `(N)` count badge on each vendor card continues to mean "items in this store sourced from this vendor" (unchanged from today). → **VERIFIED** (code-verified: `allVendorTabs` at EODCountSection.tsx:187-195 computes per-vendor item count from `storeInventory` exactly as before; the filter only controls which pills render, not the count value)

- **AC7**: Per-vendor `cutoff` text continues to come from `vendors.orderCutoffTime`. → **VERIFIED** (code-verified: EODCountSection.tsx:576-580 renders `v.orderCutoffTime` unchanged; no new field read)

- **AC8**: No new functionality lands in `src/screens/AdminScreens.tsx` or any legacy store/sync file. → **VERIFIED** (grep of all new/modified files confirms zero imports or modifications of `AdminScreens.tsx`, `useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`; `git diff HEAD` shows no modifications to these files)

- **AC9**: No change to `app.json`'s `slug` value. → **VERIFIED** (`app.json` slug remains `"towson-inventory"`; confirmed via grep and `git diff`)

---

### Additional findings

#### 1. Dual unique constraint coexistence — tested

The pre-existing `order_schedule_store_id_day_of_week_vendor_name_key` on `(store_id, day_of_week, vendor_name)` coexists with the new `order_schedule_store_day_vendor_unique` on `(store_id, day_of_week, vendor_id)`. Build notes raise this but do not exercise the edge case.

Exercised locally via direct SQL:

- **Duplicate on new constraint (same vendor_id, same vendor_name)**: `INSERT ... ON CONFLICT ON CONSTRAINT order_schedule_store_day_vendor_unique DO NOTHING` → INSERT 0 0 (correct no-op behavior).
- **Same vendor_id, different vendor_name**: fails with `23505` on the new `vendor_id` constraint. Correct — the new constraint fires first for this case.
- **Different vendor_id, same vendor_name**: fails with `23505` on the old `vendor_name` constraint. The new `addOrderScheduleEntry` helper swallows only `23505` unconditionally (`if (error && error.code !== '23505') throw error`), so a `vendor_name` collision from a different vendor is also silently swallowed as an apparent no-op, even though no row was written.

**Finding**: If two vendors in the system have the exact same name (e.g., a duplicate vendor record), an attempt to add the second one to the same `(store, day)` will be silently swallowed rather than surfacing a meaningful error. This is a minor quality gap, not a blocking correctness issue for the primary use case — vendor names within a brand should be unique by convention, and the existing `vendor_name` constraint on `order_schedule` pre-dates Spec 007. Recommend a follow-up to either enforce vendor-name uniqueness in the `vendors` table or check `error.code === '23505'` more narrowly.

#### 2. TZ bug confirmed fixed — no automated coverage

The `localDayIso(d: Date)` helper at EODCountSection.tsx:38-43 formats `YYYY-MM-DD` from local date components (`getFullYear / getMonth / getDate`). All 5 former `toISOString().slice(0,10)` call sites replaced (`selectedIso` initial state, rail builder's `todayIso`, per-cell `iso`, `EODHistoryTab`'s `ninetyDaysAgo`, `EODCountTodayTab`'s `todayStr`). The one remaining `toISOString()` at line 269 is a real timestamp field for submission, not a date-only string — correct to leave UTC-encoded.

The fix was script-verified by the frontend dev (Node `TZ=America/New_York` simulation) and browser-verified by main Claude. No automated timezone regression test exists. If the test framework lands (Playwright + Jest as recommended in prior reviews), a TZ-edge test case for `localDayIso` called at 22:00-23:59 local time with a UTC+N offset should be added. This gap is recorded, not blocking.

#### 3. `__all__` mode empty state — defensive branch not live-exercised

Main Claude noted this was not exercised during the smoke walk. Code path exists at EODCountSection.tsx:375-383 and OrderScheduleSection.tsx:55-63. The architect confirmed `setCurrentStore` normally prevents `__all__` from reaching `currentStore.id` in real navigation. The branch also covers the brief `currentStore.id === ''` pre-load window, which cannot be reliably triggered in a browser session. Treating as NOT TESTED but not blocking — this is an explicitly defensive guard against a near-impossible state.

#### 4. Migration apply method deviation from standard path

The migration was applied via direct `psql` + manual `schema_migrations` insert rather than `npx supabase migration up --include-all`, because that command also pulls Spec 006's migration which has an idempotency assertion failing on this local DB. The migration IS recorded in `supabase_migrations.schema_migrations` (version `20260507214842`, confirmed via query). This is a pre-existing constraint unrelated to Spec 007. Noted for release-coordinator awareness — not a Spec 007 defect. Prod push requires user authorization as documented.

#### 5. Realtime publication — already member, subscription not wired

`order_schedule` is already in the `supabase_realtime` publication (confirmed locally). The architect chose NOT to add a `.on('postgres_changes', {...})` handler in `useRealtimeSync.ts` — this means cross-tab/cross-device schedule changes will not auto-push to the vendor row without a manual refresh. This is the accepted V1 trade-off documented in spec §5. No docker-restart is required because no publication membership changed. If multi-admin live propagation becomes a requirement, follow-up spec is clearly documented.

#### 6. REST day enforcement — vendor navigation stays live, inputs disabled

Verified at code level: `isRestDay` at line 369 applies `disabled` + `opacity 0.4` to "+ COUNT" / "SAVE DRAFT" / "SUBMIT COUNT" (lines 492-527) and `editable={false}` + `opacity 0.5` to BOX/CASE input (line 773), COUNT input (line 804), and Note input (line 830). Vendor pills and category chips remain clickable. "REST DAY — NO INPUT" pill renders in TabStrip rightSlot (lines 482-491). Browser-confirmed by main Claude on Tuesday May 5.

#### 7. Test framework gap — still no automated test runner

No jest/vitest/playwright framework is wired up. All verification in this review is code-verified (static analysis + direct DB queries) or browser-verified by main Claude. This is the project's known gap per CLAUDE.md. The prior framework recommendation (Playwright for browser flows, Jest for unit math) stands. This reviewer does not escalate beyond recording the gap — introduction of a framework requires explicit user approval per agent instructions.

---

### Test run

No automated test suite exists. Verification methods used:

1. **Static code review**: all spec-specified files read and cross-referenced against AC text and architect contract.
2. **Direct DB queries via `docker exec supabase_db_imr-inventory psql`**:
   - Migration recorded: `select version, name from supabase_migrations.schema_migrations where version='20260507214842'` → 1 row.
   - Constraint present: `\d public.order_schedule` shows both unique constraints and RLS policies.
   - Realtime publication: `select from pg_publication_tables where pubname='supabase_realtime' and tablename='order_schedule'` → 1 row.
   - Idempotent insert: `INSERT ... ON CONFLICT ... DO NOTHING` → INSERT 0 0 on duplicate vendor_id.
   - Dual constraint edge: same vendor_id/different name fires `vendor_id` constraint; different vendor_id/same name fires `vendor_name` constraint.
   - No duplicates at new grain: count query returns 0.
   - Test data: 2 rows (Towson/Thursday/BJs, store-000.../Tuesday/BJs).
3. **Browser smoke** (main Claude, post-fix-pass, Thu May 7 22:04 EDT):
   - EOD filter: BJs on Thursday with toggle on/off confirmed.
   - Day-switch: Wednesday → empty state with correct day name.
   - REST day: Tuesday May 5 → pill in TabStrip, buttons at 0.4 opacity.
4. **TypeScript check**: `npx tsc --noEmit` — zero net-new errors from Spec 007 files (project baseline is 149 pre-existing errors).
5. **Bundle check**: `OrderScheduleSection`, `EODCountSection`, `AddVendorScheduleModal`, `localDayIso` symbols confirmed present in compiled bundle (13.7 MB at localhost:8082).

Pass/fail counts across ACs: **7 VERIFIED, 1 CODE-VERIFIED (with accepted scope revision for cross-tab realtime), 1 NOT TESTED (`__all__` empty state not live-exercised)**.

---

### Notes

- The realtime AC (AC5) has an accepted scope revision in the architect's §5: same-tab propagation is guaranteed; cross-tab/cross-device is not. This revision is captured in spec build notes but not reflected in the AC text itself. Release-coordinator should note the AC wording is slightly ahead of the implementation.
- The `__all__` NOT TESTED gap is explicitly defensive code guarding a near-impossible state per architect Probe 6. Not a blocking concern for SHIP_READY.
- The dual-constraint silent-swallow finding (finding 1) is a quality gap for follow-up, not a blocking correctness issue for the primary use case.
- Prod push is not yet applied — user authorization pending. All verification is local-only.
