# Spec 167: backend-architect post-implementation drift review

Scope: the unstaged working-tree changes for spec 167, checked against `## Backend design` §0-§10. Files read in full or in the relevant slice:

- `supabase/functions/manage-store-user/index.ts`
- `supabase/functions/delete-user/index.ts`
- `scripts/smoke-store-user.sh`
- `scripts/smoke-edge-roles.sh`
- the frontend set (`src/types/index.ts`, `src/utils/formatAuditAction.ts`, the three i18n catalogs, `AuditLogSection.tsx`, `PhoneAuditLog.tsx`, `src/utils/enumLabels.test.ts`)

I also checked `src/components/cmd/AddStoreUserDrawer.tsx` for duplicate client-side audit writes. There are none.

`specs/166-*` was ignored, as instructed.

**Verdict:** the implementation matches the design. I found no contract drift. There is one Should-fix, and it is a defect in my own §4.4, not developer drift. It also makes three statements in the §4.4 design text inaccurate, which the developer's finding brought to light.

---

## Critical

None.

---

## Should-fix

### S1. delete-user self-guard can still be bypassed with a non-canonical UUID encoding, and a half-delete is still possible for any target (design defect in §4.4)

**Where:** [supabase/functions/delete-user/index.ts:168-182](../../../supabase/functions/delete-user/index.ts), combined with lines 257-261.

**Why this exists:** §4.4 said "No `UUID_RE` validation is added." That was wrong. Postgres `uuid` input accepts more than the canonical lowercase hyphenated form:

- uppercase
- `{...}` braces
- no hyphens (32 hex characters)
- hyphens after any group of four digits

supabase-js only accepts the canonical form. `validateUUID` at `node_modules/@supabase/auth-js/src/lib/helpers.ts:367-371` uses `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` with no `i` flag. It **throws**; it does not return an error. `deleteUser`, `getUserById` and `updateUserById` all call it (`GoTrueAdminApi.ts:594/754/803`).

The fix lowercases and trims, so it closes uppercase and padding, which is exactly what AC-8 asks for. Other encodings still go through. Take a same-brand `admin` caller sending `{"userId":"{<own-id>}"}` or the caller's own id with the hyphens removed:

1. The self-guard does a string compare, `"{abc…}" !== "abc…"`, so the request passes.
2. The brand gate passes (same brand) and `assert_not_last_of_role` is a no-op for `admin`.
3. Lines 257-259 delete the caller's `user_stores`, `profiles` and `invitations` rows.
4. Line 261 throws inside `validateUUID`. The outer catch returns 500.

**Result:** the caller's profile is gone and the auth user is left orphaned. CLAUDE.md's self-guard rule exists to prevent exactly this recover-by-psql-only state. The same sequence half-deletes **any** target sent in a non-canonical form, so the class the developer found for uppercase ids still exists for these encodings.

AC-8 as written ("however my id's letters are cased") is satisfied, so this is not drift and does not block on its own terms. However, the spec's stated purpose (L7: the self-guard can be bypassed through the id's string form) is only partly met. The fix is one line on lines this spec already touches, so I recommend landing it in spec 167, not in a follow-up.

**Recommended fix (amends §4.4):**

- After normalization, require the canonical form. Use the same constant and the same refusal string that `manage-store-user` `handleSetPassword` already uses at [manage-store-user/index.ts:48,487](../../../supabase/functions/manage-store-user/index.ts):
  `if (!UUID_RE.test(userId)) → 400 { error: "userId required" }`
  with `UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` copied inline (spec 027 §4.2 inline-not-shared). The check must come before the self-guard and before any read. This is the same shape as `manage-store-user` steps 1-2.
- The `cannot delete self` string stays byte-identical. The only behavior change is for previously malformed or non-canonical input: it moves from 403/500 (or a half-delete) to a 400 `userId required`. The sole frontend caller, `src/lib/auth.ts:682`, sends canonical ids from GoTrue. AC-8 already allows `userId required` as a refusal.
- Smoke: extend `smoke-edge-roles.sh` Arm 8 with two more calls, the caller's own id in braces and with hyphens removed. Expect 400 `userId required` for both. The existing post-checks (profile, auth user and user_stores unchanged) then cover them.

---

## Minor

### M1. Corrections to the §4.4 design text (confirming the developer's finding)

I checked the developer's report in `## Files changed` against the code and against auth-js, and it is accurate:

- supabase-js rejects uppercase ids client-side, before any request reaches GoTrue.
- Before the fix, an uppercased id for any target passed the brand gate. Postgres compares uuids case-insensitively, so the three cleanup deletes at lines 257-259 ran, and then `deleteUser` threw at line 261, giving a 500 and a partial delete.
- The developer's scratch run (the old function deleting the caller's own profile) is consistent with this.

Three statements in §4.4 are therefore inaccurate after the fix. They should be read as corrected below. I have not edited the spec text; main Claude or the user can apply these if wanted.

| §4.4 text | Correction |
|---|---|
| "GoTrue's admin delete parses the path id as a uuid." | "supabase-js `auth.admin.deleteUser` validates the id client-side against a canonical **lowercase, hyphenated** UUID regex and **throws** `@supabase/auth-js: Expected parameter to be UUID but is not`. Canonicalizing the id is therefore *required* for the delete to work, not just semantically equivalent." |
| "The only behavior change for previously accepted input is that surrounding whitespace is now trimmed … nothing depends on that failure." | "Two behavior changes. (1) Padded ids are trimmed. (2) Uppercase ids for a non-self target used to delete the `user_stores` / `profiles` / `invitations` rows and then return 500 with the auth user orphaned. They now complete the delete. Both are fixes." |
| "No `UUID_RE` validation is added. A malformed string still produces today's brand-gate 403 or 500." | That holds only for strings Postgres rejects. Postgres-valid non-canonical encodings (braces, no hyphens) reach the side effects. See S1, which reverses the "no `UUID_RE`" decision. |

### M2. delete-user's side-effect ordering stays non-atomic (pre-existing, follow-up)

Even with S1 fixed, lines 257-261 delete the public rows before `auth.admin.deleteUser`. A transient GoTrue failure still leaves the public rows deleted and the auth user present. The `compensate()` comment in `manage-store-user` notes that deleting from `auth.users` cascades to `profiles` and `user_stores`, so the order could be reversed: delete the auth user first, then delete `invitations`, which does not cascade. That belongs in a separate spec. It is out of 167's scope and is noted only because 167 is where it was found.

### M3. §1 claim "every privileged role carries a profile" is assumed, not enforced

A `super_admin` whose JWT carries the role but who has no `profiles` row would make the audit insert fail with FK `23503` on `user_id`. The best-effort envelope handles it correctly: it logs the code and the response is unchanged. So there is no defect, only a trace that can quietly go missing in a state that should not exist. No action needed.

---

## Conformance checklist (design § → implementation)

| § | Item | Status |
|---|---|---|
| §1 | No migration. Writes `store_id, user_id, action, item_ref, value, detail`. `detail` = `JSON.stringify({target_id, brand_id})` in that key order | Matches (`manage-store-user/index.ts:237-252`) |
| §2 | Service-role insert, no RLS change, never a `store_id IS NULL` row | Matches. The zero-store path returns before the insert (`:260-268`) |
| §3 | No change to request/response shapes, status codes or refusal strings | Matches. The 201/200 returns are byte-identical (`:472`, `:564`) |
| §4.1 | Helpers inline after `compensate()`, away from the placeholder and reserved blocks. Never throw. One bulk insert. 3 s `abortSignal`. Log lines carry only caller id, target id, action and code (or class name) | Matches (`:212-312`). The placeholder block at `:68-75` is untouched. No `error.message` is logged |
| §4.2 | Create audit outside the compensating try, after step 9, before the 201. Uses `ids` / `username` / `derivedBrand` / `newId` | Matches (`:466-469`) |
| §4.3 | Step-4 select gains `username`. `user_stores` read happens after `updateUserById` succeeds. A `null` read skips the write | Matches (`:506`, `:513`, `:550-562`) |
| §4.4 | Normalize once. Non-string → `""` → `userId required`. Self-guard against `gate.userId.toLowerCase()`. Normalized value used downstream | Matches the design (`delete-user/index.ts:165-182`, then `:202,231,245,257-261`). See S1 for the design gap |
| §5 | No `db.ts` change. Rows reach the UI via `fetchAuditLog(storeId)` | Matches. No direct Supabase access was added outside `db.ts` |
| §6 | No realtime or publication change. No `docker restart` step | Matches |
| §7 | `AuditAction`, `KEY_BY_ACTION`, en/es/zh-CN keys, desktop tone + `inferKind`, phone tone, jest drift | Matches (`types/index.ts:617-618`, `formatAuditAction.ts:26-27`, catalogs `:1738-1739`, `AuditLogSection.tsx:35-36,71`, `PhoneAuditLog.tsx:53-54`, `enumLabels.test.ts:79-80,117-136`). zh-CN uses 门店 as recommended |
| §8.1 | Smoke: header + recovery, cleanup line, preflight baseline + `SMOKE_T0`, one contiguous Arm A block between 17 and 18. psql only. A1-A9 as specified | Matches (`smoke-store-user.sh:22-23,37-38,92,180-183,414-520`). A8 also scans `$NEW_EMAIL`, which is good |
| §8.2 | Disposable same-brand admin, runs last, uppercase + padded + numeric arms, exact-string checks, three post-checks, cleanup inside the single EXIT trap | Matches (`smoke-edge-roles.sh:41-44,82,105-115,491-572`). The script-level local-only refusal (`:58-65`) also covers Arm 8 |
| §10 | File split disjoint | Matches |

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (S1: delete-user self-guard and half-delete can still be reached with non-canonical UUID encodings such as braces or no hyphens; a one-line `UUID_RE` gate plus two smoke calls, recommended to land in this spec), 3 Minor (M1 §4.4 text corrections confirming the developer's supabase-js finding, M2 pre-existing non-atomic delete ordering follow-up, M3 FK note). No contract drift.
payload_paths:
  - specs/167-store-user-audit-trail/reviews/backend-architect.md

---

## Delta re-review (fix pass), 2026-10-19

Scope: the fix-pass changes listed under `## Files changed` → "Backend fix pass", checked against S1 and M1 above and against the amended §4.4. I read these files directly; I had no shell, so I did not diff or run anything:

- `supabase/functions/delete-user/index.ts` (whole file)
- `supabase/functions/manage-store-user/index.ts` (header, constants, and the audit helpers at `:214-314`)
- `scripts/smoke-edge-roles.sh` (header and Arm 8)
- `scripts/smoke-store-user.sh` (header, `cleanup()`, Arm AF, A7-A9)
- the spec's §4.4 and `## Files changed`

**Verdict:** S1 and M1 are both closed. I found no new contract drift and no new Critical or Should-fix items. The only new items are two stale line-number references (D1, Nit).

### S1: closed

- `delete-user/index.ts:26` copies `UUID_RE` inline. It is byte-identical to `manage-store-user/index.ts:50` (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`, no flags). This follows spec 027 §4.2 inline-not-shared.
- Order at `:172-191`: normalize (trim and lowercase; a non-string becomes `""`), then `!userId || !UUID_RE.test(userId)` returns 400 `userId required`, then the self-guard against `gate.userId.toLowerCase()`. Both refusals run before `createClient(service_role)` at `:193`, before any read, and before the three cleanup deletes at `:266-268`. That is the ordering the CLAUDE.md self-guard rule requires.
- `cannot delete self` is byte-identical (`:187`).
- Braces, no hyphens, hyphens every four digits, and any other non-canonical spelling now stop at the regex. So the string self-guard, supabase-js `validateUUID` and Postgres now treat the same id as the same identity, and the half-delete path through these spellings is gone. Uppercase and padded ids still normalize first and then reach the self-guard, so AC-8 is unchanged.
- The refusal shape matches `manage-store-user` `handleSetPassword` (`:489`), same string and same status.
- Caller impact: `src/lib/auth.ts:682` is the only frontend caller and sends GoTrue-issued canonical ids. Nothing else in `src/` calls the function.
- Smoke (`smoke-edge-roles.sh:570-577`): Arm 8 adds two calls, the braced own id and the hyphenless own id (`${SELFDEL_ID//-/}`). Both expect exactly 400 `userId required`. They run before the existing profile, auth.users and user_stores post-checks, which now cover all five calls. The developer reports a pre-fix proof in which the staged delete-user returned 500 `Expected parameter to be UUID` and failed the "caller profile was DELETED" check. That shows the new arms fail on a regression.
- Code-reviewer's Should-fix is also in: `sd_psql` (`:512-516`) now captures the output and then `|| return 1`, so the fixture-failure branch at `:587` can actually fire.

### M1: closed

§4.4 now reflects the shipped code:
- The pseudocode includes the `UUID_RE` line (`spec:275`), and `spec:279` states the byte-identical inline copy and where the check sits.
- The "GoTrue parses the path id" premise is replaced with the supabase-js lowercase-only `validateUUID` throw (`spec:284`, marked "Corrected post-impl").
- The behavior-change bullet now lists both changes (trim, and uppercase non-self ids no longer half-delete) (`spec:286`).
- The "No `UUID_RE`" decision is explicitly reversed, with the reason (`spec:287`).

All three rows of my M1 correction table are applied, and the corrections are marked in the spec rather than silently rewritten.

### Nothing else drifted

- **`manage-store-user/index.ts`:** the only change is the header comment (`:24-26`), which now says the spec 167 audit log lines carry only caller id, target id, action and code (or class name). This matches the helpers as written (`:277`, `:285`, `:300`, `:310`): no `error.message`, rows or username. No code changed. The placeholder and reserved-usernames pinned blocks (`:52-77`) are intact, and the developer reports `placeholderEmail.parity.test.ts` at 9/9.
- **`smoke-store-user.sh` Arm AF** (`:503-564`) is a new block that §8.1 did not specify. It does not break §8.1:
  - It sits inside the Arm A block (between A6 and A7), so the "one contiguous block between 17 and 18" constraint still holds, and it edits no existing arm.
  - It uses psql only (`psql_q`), not service-role REST.
  - The temporary trigger is scoped to `item_ref = U_AUD`, so it cannot affect any other arm's rows.
  - The trigger has its own `AUDIT_TRIGGER_INSTALLED` flag, dropped in-arm and again in the single `cleanup()` EXIT trap (`:97-101`), and the kill -9 recovery SQL is in the header (`:39-40`).
  - `U_AUD` matches `zz_s165%`, so both the user and any stray audit row fall under the existing cleanup and the A8 secrets scan.
  - The log assertion greps for `"audit write failed"` + target id + `P0001`, which matches the helper's log line shape exactly. Its negative check on the trigger message proves AC-4's "code, never message" rule on a real failure.
  - A7 stays at 7 (AF adds 0 by design), and the "UPDATE THIS TALLY" note is present (`:570`).
- **No migration, no RLS change, no `db.ts` change, no realtime or publication change.** §1, §2, §5 and §6 still hold, and there is still no `docker restart supabase_realtime_imr-inventory` step.

### D1 (Nit, new): stale line references after the `UUID_RE` insertion

Adding `UUID_RE` and its comment shifted `delete-user/index.ts` down by about 9-18 lines. These references are now stale:
- spec §4.4 `spec:290` ("lines 102/117/226/241/255/265" for the raw `error.message` responses; these are now `:109/124/244/259/273/283`)
- the release proposal's F3 line list
- `Files changed` `spec:457`, which cites `manage-store-user/index.ts:48` for `UUID_RE`; it is at `:50`
- the existing doc comment at `src/lib/db.ts:5401`, which cites `delete-user/index.ts:168-173` for the self-guard; it is now `:186-191`. This is pre-existing comment drift.

None of these affects behavior. Fix them opportunistically, or carry them into the F3/F4 follow-up, which rewrites those lines anyway.

### Status of the original findings

| Finding | Status |
|---|---|
| S1 (non-canonical UUID self-guard bypass / half-delete) | **Closed** |
| M1 (§4.4 text corrections) | **Closed** |
| M2 (non-atomic delete ordering) | Open, follow-up (release-proposal F4), unchanged |
| M3 (profile-less super_admin) | Open, no action (release-proposal F2), unchanged |
| D1 (stale line refs) | New, Nit |

### Handoff
next_agent: NONE
prompt: Architectural delta re-review complete. S1 and M1 closed. 0 Critical, 0 Should-fix, 1 new Nit (D1 stale line references). M2/M3 remain as already-tracked follow-ups. No contract drift.
payload_paths:
  - specs/167-store-user-audit-trail/reviews/backend-architect.md
