## Test report for spec 030

### Acceptance criteria status

#### Item 1 — `super_admin` predicate parity (sidebar/dashboard)

- AC1.1: `TimezoneBar.tsx` inline predicate widened to include `super_admin` → **PASS** — `src/components/TimezoneBar.tsx:24-27` is `currentUser?.role === 'admin' || currentUser?.role === 'master' || currentUser?.role === 'super_admin'`. Per the user's mid-stream correction, the inline widening pattern was used (not `useIsMaster()`) to preserve plain-admin TZ-edit access. Implementation matches the corrected spec intent.

- AC1.2: `DashboardSection.tsx` manager-lookup predicate widened to include `super_admin` → **PASS** — `src/screens/cmd/sections/DashboardSection.tsx:733` reads `(u.role === 'admin' || u.role === 'master' || u.role === 'super_admin')`.

- AC1.3: No other instances of `role === 'admin' || role === 'master'` (missing `super_admin`) in `src/components/` or `src/screens/cmd/` → **PASS** — grep of both directories produced three hits:
  - `TitleBar.tsx:41` — already includes `super_admin`; architect-audited as correct, no change needed.
  - `DashboardSection.tsx:733` — Item 1.2, now includes `super_admin`.
  - `BrandsSection.tsx:880` — `admin || master || user` (no super_admin), but architect audit §1 explicitly classifies this as intentional (super_admin-gated-upstream Brands tab, defensible exclusion). Confirmed no remaining two-part `admin || master` drift sites inside scope.

- AC1.4: Manual browser smoke — super_admin user sees chevron and can open timezone modal → **MANUAL-ONLY** — code path is deterministic: `isAdmin` is `true` for `super_admin` via the widened predicate; `onPress` fires `setShowModal(true)` and chevron renders at line 55 when `isAdmin` is true. No jest harness for this rendering path exists.

- AC1.5: Manual browser smoke — super_admin listed as store's only privileged user shows name in DashboardSection "Manager" field → **MANUAL-ONLY** — code path deterministic: `users.find((u) => (u.role === 'admin' || u.role === 'master' || u.role === 'super_admin') && u.stores.includes(store.id))` at line 730 now matches `super_admin` rows. No jest harness.

#### Item 2 — Hide DELETE button on self-row

- AC2.1: `canDelete` returns `false` when `isSelf` is `true`, regardless of role → **PASS** — `UsersSection.tsx:267-269`: both branches of the ternary block self. Master branch: `!isSelf`. Non-master branch: `!isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin'`. The old `isSelf || (...)` form that granted self-delete to non-master admins is gone.

- AC2.2: DELETE button render-site code (`{canDelete ? <TouchableOpacity ... /> : null}`) unchanged → **PASS** — `UsersSection.tsx:394-409` is unchanged. The `canDelete` boolean gates a ternary; the render block is unmodified.

- AC2.3: `silent: true` defensive code on `deleteProfile` self-delete call site stays in place → **PASS** — `UsersSection.tsx:106`: `const ok = await deleteProfile(target.id, isSelf ? { silent: true } : undefined)`. The guard is present.

- AC2.4: `DeleteConfirmModal` self-targeted code path (lines 227-232) retained as dead defensive code → **PASS** — `UsersSection.tsx:227-234` is present and unchanged: the modal title and description both branch on `deleteTarget.id === currentUser?.id`. This code is now unreachable from the UI (since `canDelete` blocks self-targeting) but is kept per AC2.4.

- AC2.5: Manual browser smoke — own row shows no DELETE button for any role → **MANUAL-ONLY** — code path deterministic: `isSelf` blocks `canDelete` in both ternary branches; `{canDelete ? ... : null}` at line 394 renders null. No jest harness covers this rendering path.

#### Item 3 — Hide Users & access sidebar entry for non-master admins

- AC3.1: Admin group push moved inside `if (isMaster)` guard → **PASS** — `src/lib/cmdSelectors.ts:1085-1092`: the Admin group push at lines 1086-1091 is wrapped in `if (isMaster) { ... }`.

- AC3.2: Hook calls both `useIsSuperAdmin()` and `useIsMaster()`; `useMemo` deps includes `isMaster` → **PASS** — `cmdSelectors.ts:8`: import is `import { useIsSuperAdmin, useIsMaster } from '../hooks/useRole'`. Line 1032: `const isSuperAdmin = useIsSuperAdmin()`. Line 1033: `const isMaster = useIsMaster()`. Line 1102 deps array: `[isSuperAdmin, isMaster]`.

- AC3.3: Default ordering preserved — Operations → Planning → Insights → Admin (if master) → Tenancy (if super_admin) → **PASS** — Source order at lines 1035-1102 is Operations, Planning, Insights (all unconditional), then `if (isMaster)` Admin push, then `if (isSuperAdmin)` Tenancy push. `useIsMaster()` returns `true` for `super_admin`, so a super_admin user gets both groups in that order.

- AC3.4: `applySidebarOverride()` silently drops the `Users` id for non-master admin with stale override → **PASS** — This is a structural property of `applySidebarOverride()` (spec 008); the spec documents it as already correct behavior. No code change is needed or was made; the implementation simply stops including the `Users` id in the default tree for non-master admins, and `applySidebarOverride`'s merge logic drops unrecognized ids.

- AC3.5: Manual browser smoke — non-master admin sees no Admin group / Users & access entry; master and super_admin see it → **MANUAL-ONLY** — code path deterministic: `if (isMaster)` false for `role === 'admin'`, so the group is never pushed. No jest harness covers sidebar rendering.

#### Cross-cutting

- AC4.1: `npx tsc --noEmit` exits 0 → **PASS** — zero real errors (all output lines are pre-existing TS2688 duplicate `@types/<pkg> 2/` noise).

- AC4.2: `npm run typecheck:test` exits 0 → **PASS** — exit code 0, no output.

- AC4.3: `npm test -- --ci` PASS → **PASS** — 4 suites / 24 tests passed. No existing test assumed the broken behaviors (TimezoneBar admin gate, manager lookup, canDelete, sidebar groups were not covered by the jest suite before this spec).

- AC4.4: `npm run test:db` PASS → **PASS** — 14/14 DB test files passed. No DB changes in this spec.

- AC4.5: `npm run test:smoke` PASS → **PASS** — all smoke arms passed. No edge function changes in this spec.

- AC4.6: `app.json` slug unchanged → **PASS** — `"slug": "towson-inventory"` confirmed.

---

### Test run

```
npm test -- --ci
  PASS component src/components/cmd/StatusPill.test.tsx
  PASS unit src/utils/relativeTime.test.ts
  PASS unit src/utils/seedVarianceDates.test.ts
  PASS unit src/utils/escapeHtml.test.ts
  Test Suites: 4 passed, 4 total
  Tests:       24 passed, 24 total

npm run test:db
  14/14 DB test file(s) passed

npm run test:smoke
  all checks passed

npx tsc --noEmit — zero new errors (pre-existing TS2688 noise only)
npm run typecheck:test — exit 0
```

---

### Notes

#### canDelete regression risk (assessment item 2)

The `isSelf` branch was removed from the non-master-admin side of the ternary. The old shape `isSelf || (...)` was logically inverted — it read "can delete if self OR if target is a non-privileged user," which granted self-delete. The new shape `!isSelf && (...)` correctly reads "can delete only if NOT self AND target is non-privileged." The master branch `!isSelf` was already correct and is unchanged.

Other places in `UsersSection.tsx` that reference `isSelf`:
- Line 105: `handleConfirmDelete` computes its own `isSelf` from `target.id === currentUser?.id` — independent of `UserRow.canDelete`; this is the silent-toast path and is unchanged.
- Line 323: the `(you)` label — purely visual, unchanged.
- `canResetPassword` at lines 279-281 — already used `!isSelf` in both branches before spec 030; unaffected.

No other code path in the file or repo was found that re-opens the self-delete affordance. The `delete-user` edge function HTTP 400 backstop remains the authoritative server-side guard.

When a master views their own row: `isMaster = true` → `canDelete = !isSelf = false`. DELETE is hidden. This is the spec's intended behavior per AC2.1.

#### cmdSelectors.ts memo reactivity (assessment item 3)

`useIsMaster()` subscribes to `useStore((s) => s.currentUser?.role)` — a primitive string selector. When `currentUser.role` changes (e.g., via a realtime event that causes the store to reload the user profile), the hook returns a new primitive, the outer component re-renders, and the `useMemo` fires because `isMaster` changed in the deps array. The memo is reactive to role changes as required. The `isSuperAdmin` dep was already reactive by the same mechanism; `isMaster` is parallel in design.

The only edge case is a mid-session role promotion where the store updates `currentUser` but the UI has a stale render. Since both hooks subscribe to the same store slice and Zustand triggers synchronous re-renders per subscription, there is no window where the sidebar would be stale after the store update lands.

#### AC1.1 semantic-change note (assessment item 5)

The architect's original design called for swapping `TimezoneBar`'s predicate to `useIsMaster()`, which would have dropped plain `admin` users from TZ-edit access. The user flagged this as an unintended semantic change during implementation. The frontend developer correctly applied the inline widening (`|| super_admin`) pattern instead.

The resulting predicate (`admin || master || super_admin`) is intentionally broader than `useIsMaster()` (`master || super_admin` only) and intentionally narrower than the TitleBar's "all-stores" gate. Plain admins retain TZ-edit access. The spec's file-level comment at lines 9-10 (`admin / master → opens the timezone picker modal`) was NOT updated to reflect `super_admin` — this is a Nit (stale comment), not a functional issue.

#### useStore.test.ts deferral (assessment item 4)

Spec 029 deferred the `useStore.test.ts` harness. Would unit tests on `canDelete` and the sidebar memo have caught edge cases in this spec? For `canDelete`: the logic is a short pure conditional with two inputs (`isMaster`, `isSelf`, `user.role`). The old bug (`isSelf || ...`) would have been caught by a parameterized truth-table test with cases: (master, self) → false; (admin, self) → false; (admin, non-self-user) → true. Both the old bug and the corrected form would be visible as a test failure. This is exactly the scenario where a `canDelete` unit test would have been load-bearing. The deferral was acceptable for spec 029's less-critical change, but for a predicate inversion (logical operator change) like spec 030 Item 2, a unit test is the right long-term mitigation. Recommendation: when the `useStore.test.ts` harness spec ships, include `canDelete` truth-table coverage as a first-class deliverable alongside the store tests.

For the sidebar memo: a jest test on `useDefaultSidebarGroups()` with mocked `currentUser.role` values would have verified the `if (isMaster)` gate directly. This class of test is achievable today without the full store harness — `useDefaultSidebarGroups` only reads one store slice — but requires mocking `useStore`. Still deferred pending the harness.

#### Manual-only ACs summary

Five ACs are manual-only (AC1.4, AC1.5, AC2.5, AC3.5, and the implicit "super_admin sees both Admin and Tenancy" case under AC3.5). All are noted in the spec as manual browser smokes. The code paths for all five are fully deterministic from the implementation and are documented above under each AC. None are Criticals unless Main Claude's parallel browser runs report failures.

#### Nits (non-blocking)

- `src/components/TimezoneBar.tsx` lines 9-10: file-level comment still reads `admin / master → opens the timezone picker modal`. Should be updated to `admin / master / super_admin` to match the widened predicate. Stale comment, no functional impact.
