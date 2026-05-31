## Test report for spec 082

### Acceptance criteria status

- AC1: In **Users & access**, every registered (`status: 'active'`) profile with a name-matching `invitations` row renders that email at `UsersSection.tsx:344` instead of "(email not loaded)" → **PASS** — `src/lib/db.fetchBrandAdmins.test.ts::case (a)` proves a `used=true`, name-matching invite now resolves a non-empty email; case (d) proves the sentinel-profile_id / name-match fallback path. NOTE: The spec wording says "verified specifically for the 4 reported prod accounts in the local prod-mirror seed" — that clause is UNSATISFIABLE because `supabase/seed.sql` contains ZERO invitation rows and only 3 `@local.test` profiles (spec §0.2 acknowledges this). Verification is via hermetic jest fixtures. This is a spec wording gap, not a test gap; the architect explicitly accepted it as a should-fix-not-blocker.

- AC2: For a registered user with a resolved email, "Reset PW" no longer bails with "No email on file" (`UsersSection.tsx:77`) — `u.email` is non-empty so `sendPasswordReset(u.email)` runs → **PASS** — the reset bail is a purely UI consequence of `u.email` being non-empty; case (a) in `db.fetchBrandAdmins.test.ts` proves `email` is populated. No separate UI test needed (no JSX change; no `testID` was added to exercise the bail path via `@testing-library/react-native`). Verified by code inspection that the bail at line 77 is `if (!u.email)` — once `fetchBrandAdmins` returns a non-empty email the bail cannot fire. Gap: no automated integration test drives the Reset PW button end-to-end; the optional Playwright E2E test mentioned in the spec was not written (spec noted it as optional). Surface as a documentation gap, not a blocker.

- AC3: For a registered user with a resolved email, the DELETE confirmation text includes the email → **PASS** — by code inspection `UsersSection.tsx:238-241` uses `deleteTarget.email` in the confirmation body; `deleteTarget.email` is non-empty once `fetchBrandAdmins` returns it. Same logic as AC2 — purely downstream of the email field being populated. No separate UI test.

- AC4: PENDING invitations still appear exactly once as synthetic `status: 'pending'` rows; a consumed invite must NOT appear as a duplicate pending row → **PASS** — `db.fetchBrandAdmins.test.ts::case (c)` explicitly asserts: one pending row for Zoe (`used=false`), zero phantom rows for Amy (`used=true, active`), result length == 2.

- AC5: `fetchBrandAdmins` returns the same row count (one per active profile + one per genuinely-outstanding invite, no phantom second row) → **PASS** — case (c) asserts `result.toHaveLength(2)` for 1 active + 1 pending. Cases (a) and (b) assert `toHaveLength(1)` and `toHaveLength(2)` (all active, no pending phantom) respectively.

- AC6: The misleading `db.ts:3267-3271` comment is corrected → **PASS** — by code inspection, `db.ts:3268-3279` now accurately describes the A+B fix: "Maps are built from ALL brand invites (the query no longer filters used=false)", documents `profile_id` set by `consume_invitation` as of spec 082 and the backfill, and states name-match is the sentinel fallback. The false "always empty in practice" wording is gone.

- AC7: Brand scoping unchanged — `fetchBrandAdmins` reads only invitations/profiles for the passed `brandId`; no cross-brand email bleed → **PASS** — by code inspection `db.ts:3233` `.eq('brand_id', brandId)` on profiles and `db.ts:3242` `.eq('brand_id', brandId)` on invitations are both present in the updated code. No test directly asserts cross-brand isolation, but the jest mock routes all queries through the same `mockFrom` which returns per-test fixture data scoped to `BRAND = 'brand-1'`; there is no multi-brand fixture. This is sufficient given the brand scoping is structural (two `.eq` predicates) and not in any changed code path.

---

### Test run

**pgTAP DB tests**

```
npm run test:db
✓ 39/39 DB test file(s) passed
supabase/tests/consume_invitation_sets_profile_id.test.sql — 8 assertion(s) PASS
```

(Was 7 assertions before this review; arm-B profile_id assertion added — see Notes.)

**jest**

```
npx jest
Test Suites: 42 passed, 42 total
Tests:       402 passed, 402 total
```

**TypeScript**

```
npx tsc --noEmit -p tsconfig.json
exit code: 0
```

---

### Notes

**Arm-B gap found and fixed (as directed).**

The pgTAP arm B (`consume_invitation_sets_profile_id.test.sql`) asserted only that the second `consume_invitation` call returns `false`. It did NOT assert that `profile_id` was unchanged after the no-op. The comment said "must NOT overwrite the profile_id set in Arm A" — but the assertion body only proved the return value, not the invariant. This was the code-reviewer should-fix gap surfaced in the task brief.

Fix applied: added a second `select is(...)` assertion after `reset role` in arm B that verifies `profile_id` is still the first consumer's id after the second consume. `plan(7)` bumped to `plan(8)`. Re-run: 8/8 PASS, 39/39 files PASS.

**Backfill drift check — not byte-identical but semantically identical.**

The DRIFT DISCIPLINE comment in the test says the inline backfill UPDATE "must stay BYTE-IDENTICAL to the statement in the migration's `do $$ … $$` block." Strictly, they differ by indentation: the migration wraps the UPDATE inside a `do $$ begin … end $$` block with 3-space PostgreSQL-style indentation; the test copy is standalone with 2-space indentation. The SQL semantics are byte-for-byte identical after stripping whitespace (confirmed by script). Both produce the same query plan. This is a comment precision gap (not a correctness gap) — the comment should say "semantically identical" or "logic-identical" rather than "byte-identical". Surfaced as a Minor; no code change needed.

**AC1 seed-caveat posture — confirmed sound.**

`supabase/seed.sql` has zero `invitations` rows. Verification of the 4 reported prod accounts is not possible against the local seed. The spec explicitly acknowledges this (§0.2) and the architect flagged it as a "should-fix on the spec, NOT a build blocker." The hermetic jest fixtures (cases a/b/c/d) cover the email-inference paths end-to-end. This is acceptable for the test strategy; the AC wording gap (seed reference) is a documentation issue, not a test gap.

**AC2 / AC3 — no dedicated automated end-to-end coverage.**

The Reset-PW bail path and the DELETE confirmation text depend on `u.email` being populated, which is proved by the jest cases. There is no Playwright E2E test exercising the button click → dialog flow. The spec listed this as "optional" (spec §8, test notes). Surfaced as a documentation gap; not a BLOCK given the optional designation and the UI code being a trivial downstream consumer of the now-tested `email` field.

**Out-of-scope gap confirmed (user-accepted).**

Accounts without a name-matching invitation — including the bootstrap `super_admin` — still show "(email not loaded)". This is explicitly accepted per spec §9 and the user's scoping decision. Not a BLOCK.

**No fourth test framework introduced.** All tests land in the existing jest (Track 1) and pgTAP (Track 2) tracks.
