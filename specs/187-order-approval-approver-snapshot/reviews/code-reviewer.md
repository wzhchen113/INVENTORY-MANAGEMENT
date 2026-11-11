## Code review for spec 187

Scope: migration `20261108130000`, `delete-user/index.ts`, the new pgTAP file, the three edited pgTAP files, `scripts/smoke-delete-user.sh`, `package.json`, `src/lib/placeholderEmail*`, and the spec-187 comment hunk in `src/lib/db.ts`. I read the migration, `delete-user`, and the smoke script header and helpers in full. I skimmed the test files and grepped them for the spec-187 comment updates. I did not execute anything.

Project checks that came back clean: no direct Supabase calls added outside the carve-outs, no legacy-file edits, no `app.json` change, no custom `current_setting('jwt…')`, no new realtime channels, and no inline colors. `auth.uid()` is used rather than raw JWT parsing. The new test files sit in the established tracks (pgTAP in `supabase/tests/`, smoke in `scripts/` and wired into `test:smoke`). The placeholder block in `delete-user` is inside the marked region and `delete-user` is added to the parity `COPIES` list. The "To do at build" comment corrections are done, including the `create_order_approval` "ONLY INSERT" wording, the `index.ts` policy comment, and the auth-scope test comments. The spec 178 and spec 043 pointers are also present.

### Critical

None.

### Should-fix

- `supabase/functions/delete-user/index.ts:177-179, 504-505` — `DeleteAuditCtx` (`{callerId, targetId}`) and `DeleteAuditContext` (the pre-delete read result) differ by three letters, and the call site holds both as `auditCtx` and `auditContext`. Inside `readDeleteAuditContext` a local named `ctx` is the *small* one, while the return value is the *Context*. A reader has to check the type each time to know which is which, and passing them in the wrong order to `writeDeleteAudit(serviceClient, ctx, audit, …)` would still half-typecheck. Rename to say what they are: `DeleteAuditIds` (or `DeleteActors`) for the ids, and `DeleteAuditSnapshot` for what was read. Use `ids` / `snapshot` for the locals.

- `supabase/functions/delete-user/index.ts:513-530, 542-546` — `thrown: unknown = undefined` is used as the "did it throw" flag (`thrown !== undefined`, then `throw thrown`). If anything ever throws `undefined`, the error is swallowed and the code falls through to the 200 path. This is unlikely, but a sentinel that is also a legal thrown value is a trap. Use a separate `let threw = false`, or restructure so the outer `catch` builds the 500 and the audit write sits in a `finally`-style block. This is also the only place where the auth-delete outcome is derived from two variables (`error`, `thrown`). A single `authDeleteFailed` boolean would make the `authUserDeleted` line and the later branches easier to read.

### Nits

- `supabase/functions/delete-user/index.ts:216-310` — five `readX` closures repeat the same try / `{data,error}` / `logAuditFailure` / catch-`errorClass` skeleton (about 90 lines). A small `guardedRead<T>(what, run)` helper that logs and returns `null` would shrink this to the five queries. Not required for correctness, and tolerable given the inline-not-shared rule for edge functions, since the helper would live in this file.

- `supabase/functions/delete-user/index.ts:236, 251` — `let timer: number | undefined` plus `clearTimeout(timer)` in `finally` is fine on Deno. `Promise.race` leaves the real `getUserById` call running after a timeout, and the comment doesn't say so. One line saying "the race abandons the call, it doesn't cancel it" would help the next reader.

- `supabase/functions/delete-user/index.ts:371` — `if (audit.storeIds === null || audit.approvalCount === null) return;` has a comment saying the read "already logged". The null-means-failed convention is carried by `DeleteAuditContext` comments only on `storeIds` (line 185). Add the same note to `approvalCount`, or make both fields a single `failed` flag. It is easy to read `null` as "none".

- `src/lib/db.ts:2703-2706` — the comment edit re-wrapped the paragraph badly: "…a retry after a / network error returns the SAME row" now breaks mid-sentence on a short line. Reflow it. This is the only spec-187 hunk in the file. The rest of the file's diff belongs to another spec.

- `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:478` — `drop policy "Admins can delete profiles"` has no `if exists`. That matches how this repo applies migrations (a fresh `db reset` and one prod apply), so it is only a nit. `if exists` would make the prod-apply step re-runnable if the MCP `execute_sql` half-succeeds before the `schema_migrations` insert.

- `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:46-48, 502` — a single `begin/commit` with `set local lock_timeout` is good. The header block (lines 1-44) is long but mostly "why", which is fine. Lines 269-283 re-state the RPC's original comment verbatim, and part of it ("Re-approval is REFUSED, not overwritten") now slightly oversells append-only, since pending rows are overwritten and re-stamped. Consider trimming that sentence to "approved/ordered rows are refused".

- `scripts/smoke-delete-user.sh:255` — `SMOKE_T0` is second-granularity (`date -u +%H:%M:%SZ`), so `docker logs --since` can pick up the previous second's lines from another session on a shared stack. The notes already flag the shared-stack caveat; a one-line comment at this assignment would save the next person a debugging session.

- `scripts/smoke-delete-user.sh:181` — `new_target` interpolates `$2`, `$3` and `$4` straight into SQL. All callers pass fixed `zz_s187…` literals on a local-only stack, so this is not a bug. A short comment that the arguments are trusted, test-only values would stop someone copying the pattern into non-test code.

- (out-of-scope) `package.json` — `test:smoke` is now a six-script `&&` chain on one line. It is hard to diff, but changing it is beyond this spec.

- Deferred: whether the email now carried in `approved_by_email`, and its reach to brand admins, is acceptable is the security-auditor's call. Whether coverage matches the AC list (AC-22 and AC-28 in particular) is the test-engineer's.

### Summary

0 Critical, 2 Should-fix, 9 Nits.
