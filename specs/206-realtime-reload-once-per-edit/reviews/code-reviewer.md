## Code review for spec 206

Scope: `src/lib/inflight.ts`, `src/lib/realtimeReloadScheduler.ts`, `src/hooks/useRealtimeReloadScheduler.ts`, `src/navigation/CmdNavigator.tsx` (grepped; Bash/git diff unavailable to this reviewer, so the CmdNavigator and inflight.test.ts diffs were not read line by line), plus the hook test and the scheduler test titles. I traced the scheduler by hand against the §3.3 state machine and invariants I1-I4.

Verdict: the implementation matches the design. No project-policy violations: no Supabase calls outside db.ts, no color literals, no web-only APIs, no new channels, no legacy-file edits, no app.json change, and tests sit in the jest track.

### Critical
- None.

### Should-fix
- None.

Race and teardown checks that came out clean:
- Dispose during a running reload: `onSettled` sets `running = false`, then returns on `disposed`. No follow-up and no leak. The reporter path (`safeReport`) is still invoked after dispose on rejection, which is harmless.
- A write starting mid-debounce: `W↑` clears the timer and `dirty`, and keeps `pending`. The drain re-arms.
- A write starting while `dirty`: demoted to held. This is the AC-7 path.
- Rejection handling: both `then` branches are attached in the same expression, a sync throw from `reload` is converted to a rejection, and `safeReport` swallows reporter errors. Nothing can go unobserved.
- `startReload` sets state before calling `reload()`, so a synchronous re-entry sees `running`.
- Hook: the scheduler is created in the effect, so a StrictMode double-mount gets a live instance. `handleSync` is `useCallback(..., [])`, so its identity is stable. The hook call precedes `useRealtimeSync` in CmdNavigator (L66-67), so the scheduler exists before the channels subscribe. The unused `useRef` import was dropped (L1).

### Nits
- `src/lib/realtimeReloadScheduler.ts:136-140` — the `dirty && writes.isWriting()` branch in `onSettled` is unreachable. `W↑` always clears `dirty` (L158-162), and the comment says as much. Likewise the `isWriting()` guard in `onTimer` (L148) is unreachable under I1. Both are defensible as belt-and-braces, but they carry no test and add paths to reason about. Either keep with the "defensive" comment, as now, or drop them.
- `src/lib/realtimeReloadScheduler.ts:126` — `Promise.resolve(p)` guards against a non-promise return. The type already says `Promise<void>`. The implementation notes explain it, but a one-line "why" comment in the code would help, since the L125 comment is about the dual-branch `then`, not the wrap.
- `src/lib/inflight.ts:116-127` and `176-190` — the write and non-write patches repeat the base fields. A spread (`{ ...base, ...(isWrite && {...}) }`) would remove the duplicated object literal on entry, as the exit `set` already does. Style only, and the current shape keeps the non-write patch byte-identical, which was the design intent.
- `src/hooks/useRealtimeReloadScheduler.test.ts:72,100,146,162,168,196` — case labels repeat (`(b)` x2, `(d)` x2, `(e)` x2). Cosmetic only. Renumbering would make failures easier to cite.
- `src/hooks/useRealtimeReloadScheduler.test.ts:140` — `handleSync()` after unmount runs outside `act`. That's fine because it is a no-op, but it is inconsistent with the other calls.
- `src/hooks/useRealtimeReloadScheduler.ts:21-35` — `reloadCurrentStore` and `inflightWriteSource` are exported mainly for tests. That's acceptable, but if the hook file grows, consider a note saying they are exports-for-test.
