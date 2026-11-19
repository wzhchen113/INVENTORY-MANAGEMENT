## Test report for spec 200

### Acceptance criteria status
Paths: H = src/screens/staff/lib/borrowedEntries.test.ts, S = src/screens/staff/screens/EODCount.borrowed.spec200.test.tsx, F = src/screens/staff/lib/borrowSources.test.ts, P = supabase/tests/eod_cross_vendor_read_rls.test.sql
- AC-1 (pure derivation, arms a-h plus i-k) → PASS — H::"(a)".."(k)" (also (h2), NO NEED, null-vendor, queued-name fallback)
- AC-2 (prefill + label, "1 of 2 counted") → PASS — S::AC-2
- AC-3 (gate passes with Y counted; blocks with Y blank, opens on Y) → PASS — S::AC-3 (x2)
- AC-4 (NEXT skips X, DONE) → PASS — S::AC-4
- AC-5 (no borrow: no source, other date, other store, draft) → PASS — S::AC-5 (x2); other-date/store/draft also in H (a)(b)(d)
- AC-6 (edit becomes own, open/close leaves borrowed) → PASS — S::AC-6 + AC-7
- AC-7 (clear falls back) → PASS — S::AC-6 + AC-7
- AC-8 (omit by default) → PASS — S::AC-3 + AC-8
- AC-9 (all-borrowed verbatim copies, chip green, locked; mixed variant) → PASS — S::AC-9, AC-9 mixed
- AC-10 (NO NEED: shown, omitted when mixed, ships no_need:true when all-borrowed) → PASS — S::AC-10 (x2)
- AC-11 (count mode, cases-only verbatim) → PASS — S::AC-11; H::entrySeed parity / borrowedEntryCopy
- AC-12 (own wins in LOCKED and EDITING) → PASS — S::AC-12
- AC-13 (locked view, EDIT->Cancel, queued submit) → PASS — S::AC-13 (x2)
- AC-14 (queued source, other user's item doesn't borrow) → PASS — S::AC-14
- AC-15 (re-read after submit; rejected read -> notifyBackendError, list + queued still work) → PASS — S::AC-13 (asserts fetchBorrowSources called twice), S::AC-15, S::R9 drain gap; F::throws on query error
- AC-16 (RLS pgTAP, member of S reads A's rows; other-store member gets 0) → PASS — P (7 assertions)
- AC-17 (i18n keys en/es/zh-CN, i18n.test.ts) → PASS — keys present in all three catalogs; i18n.test.ts passes in the full jest run
- AC-18 (gates) → PASS (with the known base-typecheck note below) — EODCount.test.tsx and EODCount.noNeed.spec172.test.tsx updated with the borrowSources mock, not deleted
- AC-19 (manual phone-width preview) → NOT TESTED by me (manual, out of my tooling). Developer's notes record a 390px check on the local stack (label scrollWidth = clientWidth = 364) and the AC-2/AC-9 flows. Requires user/PM confirmation.

### Test run
- `npx jest`: 318 suites / 4067 tests passed, 0 failed.
- `npm run typecheck:test`: clean.
- `npm run test:db` (local stack up): 112/112 files passed, including eod_cross_vendor_read_rls.test.sql.
- `npm run typecheck` (base): not re-run. The developer reported only the 24 known TS2688 errors from the Finder-duplicate `node_modules/@types/* 2` folders. Noted, not fixed.
- e2e (`e2e/staff-reorder.spec.ts`, `e2e/eod.spec.ts`): NOT RUN. Port 8081 is held by PID 16279 (`expo start --web --port 8081`, the user's own dev server). I did not kill it. Neither spec exercises the new borrow behavior in any case.

### Notes
- Screen tests mock `borrowSources.ts` as a module and the staff submit function. The server-source read itself is covered only at the unit level (F) and its RLS reach by pgTAP (P). Per project policy, no mocked-DB integration is used for the DB layer.
- No new framework was introduced.
- Deploy gate D6 (spec 201 migration 20261118120000 on prod before this client ships) is a release-coordinator concern, not testable here.
- Result: 18 PASS, 0 FAIL, 1 NOT TESTED (AC-19, manual check).
