## Test report for spec 084

### Acceptance criteria status

- AC1 (email inference — NULL-brand invite resolves non-empty email): PASS — `src/lib/db.fetchBrandAdmins.test.ts::fetchBrandAdmins — spec 084 NULL-brand inference + pending pollution guard::(e) NULL-brand invite matched by profile_id feeds inference (non-empty email)`. Arm (e) asserts `nina.email === 'nina@example.com'` where Nina's only invitation has `brand_id: null`. Pre-fix the `.eq('brand_id', BRAND)` query would have excluded this invite (mock `eq` is transparent, but the JS inference map would receive an empty `invitationsResult` array if the query truly filtered). The arm pins the observable contract: the NULL-brand invite arrives in `invites`, feeds `inviteByProfileId`, and the resolved email is non-empty.

- AC2 (pollution guard — NULL-brand UNCONSUMED invite produces no pending row): PASS — `src/lib/db.fetchBrandAdmins.test.ts::...::(f) NULL-brand UNCONSUMED invite produces no pending row (pollution guard)`. Asserts `pendings.toHaveLength(0)` and `result.every(u => u.id !== 'invitation:inv-ghost')`. Non-vacuous (see guard-test analysis below). Also pinned by `(f-bis) foreign-brand UNCONSUMED invite produces no pending row (strict equality)`.

- AC3 (in-brand unconsumed invite preserved — exactly one pending row): PASS — `src/lib/db.fetchBrandAdmins.test.ts::...::(g) in-brand UNCONSUMED invite still yields exactly one pending row`. Asserts `pendings.toHaveLength(1)`, `pendings[0].id === 'invitation:inv-pat'`, and `pendings[0].email === 'pat@example.com'`.

- AC4 (spec-082 regression safety — arms (a)-(d) unchanged): PASS — all five existing arms pass (including the empty-brandId guard). `(a)` name-match inference, `(b)` id-match precedence, `(c)` unconsumed pending + no duplicate, `(d)` sentinel-profile_id name fallback. None of the new predicate logic touches used=true invites with `brand_id: BRAND`, so arms (a)-(d) are unaffected.

- AC5 (Part B comment — auth.ts:468-470 no longer references "Cleanup #16 scopes the query to the current brand"): PASS — verified by reading `src/lib/auth.ts:468-477`. The stale "Cleanup #16 scopes the query to the current brand" text is gone. The replacement comment correctly states spec 083 DROPPED the brand filter, that NULL-brand invites were hidden by the old narrowing, that `opts?.brandId` is RETAINED for compatibility but currently IGNORED, and that which users appear is still brand-scoped via the profiles query. Mirrors the authoritative `fetchInvitationsForUserLookup` doc block at `src/lib/db.ts:119-135`.

- AC6 (jest arms cover inference AC and pollution-guard AC): PASS — four new arms in `describe('fetchBrandAdmins — spec 084 …')`: (e) NULL-brand inference, (f) pollution guard, (f-bis) foreign-brand strict equality, (g) in-brand preserved.

- AC7 (typechecks exit 0, full jest suite green): PASS — `npx tsc --noEmit` exit 0, `npx tsc -p tsconfig.test.json --noEmit` exit 0, `npx jest` 44 suites / 410 tests all green.

### Pollution-guard non-vacuousness analysis (the critical check)

The mock's `eq: jest.fn().mockReturnThis()` ignores its arguments — the `invitationsResult` array is returned verbatim regardless of whether the query carries `.eq('brand_id', brandId)` or not. This means Edit 1 (dropping the query `.eq`) is transparent to the harness. The arms exclusively exercise JS-side logic: the `inviteByProfileId`/`inviteByName` inference maps and the `pendingInvites` filter predicate.

**Arm (f) — if Edit 2 is fully reverted to `!inv.used` only:**
`inv-ghost` has `used: false` and `brand_id: null`. Filter becomes `!false` → `true`. Ghost is included. A pending row `id='invitation:inv-ghost'` appears. `expect(pendings).toHaveLength(0)` FAILS. The arm correctly catches the regression.

**Arm (f) — if Edit 2 is loosened to `!inv.used && (inv.brand_id === brandId || inv.brand_id == null)`:**
`null == null` is `true`, so the NULL-brand invite survives. `pendings.toHaveLength(0)` FAILS. Arm (f) catches this escape hatch too.

**Arm (f-bis) — distinguishes strict equality from a NULL special-case:**
`inv-foreign` has `brand_id: OTHER_BRAND ('brand-2')`, `used: false`. With the `|| inv.brand_id == null` escape hatch, `OTHER_BRAND == null` is `false`, so the foreign invite would be excluded — arm (f-bis) would PASS falsely. But arm (f-bis) does correctly fail under a full Edit 2 revert (`!inv.used` only): the foreign invite appears as pending. Together, (f) + (f-bis) pin strict equality and not a NULL-special-case.

**Arm (e) — if Edit 1 were never applied (but mock `eq` is transparent):** Because the mock ignores the `eq` args, the `invitationsResult` with `brand_id: null` is always delivered. Arm (e) is therefore not a direct test of whether the query `.eq` was dropped — it tests that the inference map correctly handles a `brand_id: null` invite that arrives in `invites`. This is the correct behavior to pin: the JS-side inference path is the changed surface. The pre-fix bug at the DB query layer would be invisible to the harness by design (the harness can't distinguish a dropped `.eq` from an `eq` that happens to return all rows). This is acknowledged in the test file comment and the spec's test contract. The arm is non-vacuous with respect to the JS contract (it would fail if the inference map loop excluded null-brand invites for any reason), even if it cannot directly pin the DB query change.

**Overall verdict:** arm (f) is non-vacuous for the primary regression risk (a strict-equality predicate is the entire correctness surface per the architect). Arm (f-bis) proves strict equality vs. NULL-special-case. Arm (g) proves the guard tightens without dropping in-brand pendings. No arm is vacuous.

### Test run

```
npx jest src/lib/db.fetchBrandAdmins --no-coverage

PASS unit src/lib/db.fetchBrandAdmins.test.ts
  fetchBrandAdmins — spec 082 email inference
    ✓ returns [] for an empty brandId without touching supabase (1 ms)
    ✓ (a) resolves email for a registered user from a used=true name-matching invite
    ✓ (b) id-match wins over name-match when two profiles share a display name (1 ms)
    ✓ (c) unconsumed invite → one pending row; consumed invite for an active user → no duplicate
    ✓ (d) used invite with sentinel profile_id resolves by name fallback
  fetchBrandAdmins — spec 084 NULL-brand inference + pending pollution guard
    ✓ (e) NULL-brand invite matched by profile_id feeds inference (non-empty email)
    ✓ (f) NULL-brand UNCONSUMED invite produces no pending row (pollution guard)
    ✓ (f-bis) foreign-brand UNCONSUMED invite produces no pending row (strict equality)
    ✓ (g) in-brand UNCONSUMED invite still yields exactly one pending row

Tests: 9 passed, 9 total  (was 5 spec-082 + 4 new spec-084)

npx jest --no-coverage

Test Suites: 44 passed, 44 total
Tests:       410 passed, 410 total  (was 406; +4 new arms)

npx tsc --noEmit       → exit 0
npx tsc -p tsconfig.test.json --noEmit  → exit 0
```

No failures. No regressions across the full suite.

### Notes

- No pgTAP and no shell-smoke track are needed or expected — this is TS-only (no migration, no DB object, no edge function). Confirmed by the architect.
- No realtime restart needed — no `supabase_realtime` publication change (no migration at all).
- The mock's `eq`-ignores-args characteristic means arm (e) cannot directly assert that the query `.eq` was dropped — it asserts the observable JS contract (inference sees the NULL-brand invite and resolves a non-empty email). This is acknowledged in the spec's test contract and is the correct posture for a unit harness; the DB-layer change is tested by the fact that it no longer calls `.eq('brand_id', brandId)` on the invitations chain (which would have been a no-op in the harness anyway — the mock doesn't filter). A pgTAP test could pin the DB-layer behavior, but per the architect's confirmation, no pgTAP applies here.
- The one `console.warn` in the full suite output is from `useStore.test.ts` (last-super_admin guard path) — pre-existing, unrelated to spec 084.
- CI status was not checked in this session (no push occurred); the test run above is local. Per project policy, the release-coordinator must confirm the latest `test.yml` run on `main` is green before recommending SHIP_READY.
