## Code review for spec 094 (store-deactivation-toggle)

> This is the re-review pass. The three Should-fix items from the initial review
> are confirmed resolved. New code (jest toggle test + pgTAP arms 7/8 + named
> StoresTab export) is assessed below.

---

### Should-fix item status

**Should-fix 1 — `db.ts updateStore` empty-`dbUpdates` guard**
RESOLVED. `src/lib/db.ts:104` now contains
`if (Object.keys(dbUpdates).length === 0) return;` with an explanatory comment
matching the `updateRecipe`/`updatePrepRecipe` convention.

**Should-fix 2 — pgTAP arm (3) master-UUID fix**
RESOLVED. `supabase/tests/stores_privileged_update_status.test.sql:147` now
reads `current_setting('test.master_id', true)` and the new comment on lines
139-142 documents why — the arm proves the master-profile path end-to-end via
the master's own `user_stores` brand_a grant rather than re-using the admin user
with a master JWT claim.

**Should-fix 3 — why-comment on the `useStore.updateStore` spread**
RESOLVED. `src/store/useStore.ts:1968-1974` carries a multi-line comment
explaining that the explicit 4-field object is required because `updates:
Partial<Store>` is wider than `db.updateStore`'s `Partial<Pick<...>>` signature
and that the spread intentionally drops `brandId` to avoid tripping the
`auth_can_see_brand` WITH CHECK.

---

### Critical

None.

The global-cache-leakage footgun (architect's primary review focus) remains
clean: `StoresTab` reads from `db.fetchStoresIncludingInactive()` into
tab-local state only, and the global `stores` cache path is untouched. No
direct `supabase.from(...)` calls outside `db.ts` were introduced. No legacy
files re-created. No inline color literals. No `Alert.alert`/`window.confirm`
direct calls.

---

### Should-fix

None.

---

### Nits

- `src/lib/db.updateStore.test.ts:105-112` — the `updateStore` happy-path tests
  do not assert `abortSpy` was called. All other `db.ts` tests in this file that
  exercise a PostgREST chain confirm the inflight-abort signal is forwarded (the
  spec-055 discipline). Minor: the UPDATE body and `eq` filter are already
  asserted, so the abort-chain correctness is covered by the `fetchStoresIncludingInactive`
  tests in the same file (which do call `abortSignal`). But consistent coverage
  would add `expect(abortSpy).toHaveBeenCalled()` to at least the status-toggle
  arm. No behavior impact.

- `src/lib/db.ts:99` — `updateStore` assigns
  `dbUpdates.eod_deadline_time = updates.eodDeadlineTime` directly, while the
  sibling `updateVendor` uses `updates.eodDeadlineTime || null` (see db.ts:2026)
  so that an empty string clears the column. This is an internal inconsistency
  within `db.ts` — if a future caller ever wants to clear `eod_deadline_time` by
  passing `''`, `updateStore` would write `''` rather than `null`. Affects only
  the `eodDeadlineTime` field; the status toggle never exercises this path.
  Pre-existing `updateVendor` convention; worth aligning in a follow-up.

- `supabase/tests/stores_privileged_update_status.test.sql:1` — the file header
  and several inline comments still reference "Spec 083" (the original spec
  number before the rename to 094). The renumbering note in the spec
  (`specs/094-store-deactivation-toggle.md:3`) documents the rename; the test
  file's header could mention "renumbered from 083 → 094" to avoid future
  confusion when grepping by spec number. Low friction; no functional impact.

- `src/screens/cmd/sections/__tests__/StoresTab.toggle.test.tsx:22-46` — the
  `useCmdColors` mock returns raw hex literals, which is the standard seam-stub
  pattern used throughout the `__tests__` sibling files (e.g. `VendorsSection.test.tsx`).
  No action needed; documented here so a future reviewer does not read the
  inline hex values as a violation of the "no inline color literals in
  components" rule — this is test infrastructure, not a rendered component.
