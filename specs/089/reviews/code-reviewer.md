## Code review for spec 089

### Critical

None.

---

### Should-fix

- `src/screens/staff/screens/Reorder.tsx:199` — `useStaffStore((s) => currentStaffUserId(s.authState))` is called and its return value is silently discarded. The comment explains it is there "for parity with EODCount's header" and to keep the header shape "identical if a future change keys on user," but that rationale is speculative and introduces a live Zustand subscription that will trigger unnecessary re-renders of the Reorder screen whenever the authenticated user's ID changes — with zero effect on the rendered output. The parity motivation is also circular: `EODCount.tsx:214` does assign the selector to `userId` but never reads that variable either, so propagating a dead read into new code compounds the problem. Remove the call; if a future spec actually needs the userId, it can be added then.

- `src/screens/staff/lib/shareReorder.ts:96-109` — In `nativeShare`, `Sharing.isAvailableAsync()` is checked AFTER the file has already been written to the cache directory. If sharing is unavailable (the function then throws, which is caught by the callers' `try/catch`), the temp file is left behind — wasted I/O and cache-directory pollution that accumulates on repeated failures. The fix is to move the availability check before the write: `const available = await Sharing.isAvailableAsync(); if (!available) throw new Error('Sharing is not available on this device'); const file = new File(Paths.cache, filename); file.create({ overwrite: true }); file.write(content); await Sharing.shareAsync(...)`. The same issue applies to `shareReorderPdf`'s native branch (line 162-169), where `Print.printToFileAsync` renders the PDF before `Sharing.isAvailableAsync()` is checked.

---

### Nits

- `src/utils/reorderExport.ts:70` — `todayLocalIso()` uses `new Date().toISOString().slice(0, 10)` (UTC midnight), while every other date helper in the staff subtree and the shared `reportDates.ts:toISODate()` use local timezone components (`getFullYear()` / `getMonth()` / `getDate()`). The name `todayLocalIso` implies local time but the implementation is UTC. This is an inherited pre-extraction behavior (identical code existed in `ReorderSection.tsx` before spec 089), and in practice the function is only reached when `payload.asOfDate` is absent — which the RPC never produces — so the real-world impact is nil. Noting for the eventual clean-up pass on shared utils.

- `src/screens/staff/screens/Reorder.tsx:201` — `maxDate` is `useMemo(() => todayIso(), [])`, which computes only at mount. If the Reorder tab stays visible past midnight the date picker's upper-bound becomes one day stale. The admin `ReorderSection.tsx` avoids this by computing `toISODate(new Date())` outside any memo, so it recomputes on every render. Low probability in practice (a kitchen manager is unlikely to leave the screen open overnight), but worth aligning with the admin's pattern.

- `src/screens/staff/i18n/i18n.test.ts:119-121` — The parity test exercises `reorder.weekday.monday` and `reorder.weekday.sunday` but omits the other five weekday keys (`tuesday` through `saturday`). `Reorder.tsx:72`'s `weekdayLabel()` can produce any of the seven keys at runtime. The missing five keys ARE present in `en.json` so there is no crash risk, but the parity gate is not exhaustive. (Out-of-scope for this reviewer; noting here for the test-engineer.)

---

### Summary

The implementation is clean and well-structured. The extraction of pure formatters into `src/utils/reorderExport.ts` is byte-for-byte behavior-preserving (the admin reorder jest re-exports cover it), all new staff-subtree code stays within the documented carve-out, the HTML builder correctly escapes every interpolated value, and the Platform.OS branching in `shareReorder.ts` keeps DOM APIs off native paths. No Critical findings. Two Should-fix items: a superfluous Zustand subscription that creates needless re-renders, and a sequencing issue in `nativeShare`/`shareReorderPdf` where the `Sharing.isAvailableAsync()` check comes after I/O that should be guarded by it. Three Nits, one of which is deferred to the test-engineer.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in; the 3 Nits + the test-engineer's 3 coverage gaps deferred (non-blocking).

- **S1 (dead `currentStaffUserId` Zustand subscription, `Reorder.tsx:199`)** — **fixed.** Removed the discarded subscription (+ its now-unused import) so the Reorder screen no longer re-renders on auth-user changes for zero output effect.
- **S2 (`Sharing.isAvailableAsync()` checked AFTER I/O, `shareReorder.ts`)** — **fixed in both paths.** Moved the availability check BEFORE the temp-file write in `nativeShare`, and BEFORE `Print.printToFileAsync` in `shareReorderPdf`'s native branch — so an unavailable share sheet no longer leaves an orphaned file/PDF in the cache dir.
- **Nits (3)** — deferred (cosmetic): the `todayLocalIso` UTC-vs-local naming (inherited pre-extraction, unreachable in practice), the mount-time `maxDate` memo (stale only if the tab is left open past midnight), and the i18n weekday-key parity (5 keys present but untested).
- **test-engineer's 3 NOT TESTED + missing e2e** — deferred as coverage-completeness follow-ups (not failures; the production code is present/correct): the activeStore-null gate, the date-picker re-fetch at the screen layer, the loading-state testID, and the named-but-absent `e2e/staff-reorder.spec.ts` (Track 4, non-blocking).

Re-verified post-fix-pass: full `npx jest` **553/553** green; base + test-graph typechecks exit 0.

**Live browser golden-path (closing the gap the frontend-dev's tool set couldn't):** ran the local stack preview signed in as the manager (`manager@local.test`) → StorePicker → Towson → the new **Reorder tab**. Confirmed the staff Reorder renders full parity: the calendar date button ("Jun 2, 2026") + Refresh, the KPI cards (Vendors 2 · Items 15 · Est. total $647.66 · On-hand source), the **CSV / Text / PDF** export buttons, the no-schedule warnings, the bottom **Count | Reorder** tab bar, and the per-vendor list with the spec-088 **by-the-case** display ("2 cases · 70 each", singular "1 case" for Sprite, "10 bags" unchanged for no-case items) + per-vendor subtotals + next-delivery/stock-fallback badges. (Native device share path remains device-QA, as flagged.)
