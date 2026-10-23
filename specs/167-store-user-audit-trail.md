# Spec 167: Server-side audit trail for store-user create / set-password (+ delete-user self-guard case fix)

Status: READY_FOR_REVIEW

Origin: spec 165 security-auditor findings **L4** (no record when an admin sets a store user's password and can then sign in as them) and **L7** (delete-user's `'cannot delete self'` comparison is case-sensitive) — [specs/165-admin-create-user-without-email/reviews/security-auditor.md](165-admin-create-user-without-email/reviews/security-auditor.md).

## User stories

- As a **brand owner / super_admin**, I want every store-user account creation and every admin-set password recorded server-side, with who did it, to whom and when, so that an admin who sets a store user's password and signs in as them leaves a trace that a hand-crafted request cannot skip.
- As a **store admin**, I want those events in the Cmd audit log for my store (desktop and phone), labelled in my language, so that I can review account changes alongside the store's other activity.
- As a **privileged admin**, I want delete-user to refuse deleting my own account however my id's letters are cased, so that the self-guard cannot be bypassed by sending an uppercased UUID.

## Acceptance criteria

### Edge function `manage-store-user`: audit write

- [ ] **AC-1** After a successful `create`, meaning auth user, profile and `user_stores` all succeeded and the function is about to return 201, the function inserts exactly **one** `public.audit_log` row per store id in the request's validated `storeIds`. It inserts through the service-role client, with:
  - `store_id`: that store
  - `user_id`: the caller's id (`gate.userId`)
  - `action`: `'Store user created'`
  - `item_ref`: the new user's normalized (lowercased) username
  - `value`: `''` (empty string)
  - `detail`: the compact JSON string `{"target_id":"<new user id>","brand_id":"<derivedBrand>"}`
  - `created_at`: the column default
- [ ] **AC-2** After a successful `set_password`, meaning `updateUserById` returned no error, the function reads the target's current `user_stores` rows with the service-role client. It then inserts exactly one `audit_log` row per store, with:
  - `store_id`: that store
  - `user_id`: the caller's id
  - `action`: `'Store user password set'`
  - `item_ref`: the target's `profiles.username`, as stored (lowercase in practice; `NULL` only if the profile has no username)
  - `value`: `''` (empty string)
  - `detail`: the compact JSON string `{"target_id":"<target id, lowercased>","brand_id":"<target.brand_id or null>"}`
- [ ] **AC-3** Store-less target: if `set_password` succeeds on a target with zero `user_stores` rows, the function writes **no** `audit_log` row. It never writes a `store_id IS NULL` row. It emits one console line containing only the caller id, the target id and the action name, and still returns 200 `{ success: true }`.
- [ ] **AC-4** Best-effort: if the audit insert, or the `user_stores` read in AC-2, errors or throws, the action's response is unchanged: 201 `{ id, username }` for create, 200 `{ success: true }` for set_password. The audit failure never triggers create compensation or rollback. The function `console.error`s only the caller id, target id, action name and the error **code**. It never logs the error message, details or request body.
- [ ] **AC-5** Refused or failed actions write **zero** `audit_log` rows. This covers every 4xx/5xx path in both actions:
  - validation errors
  - the self-guard
  - brand / role / placeholder gates
  - weak password
  - username taken
  - compensated create failures
- [ ] **AC-6** Secrets hygiene: no `audit_log` column written by this function contains any of the following, and no new console line contains them either:
  - the password, or any part of it
  - the placeholder email, or any part of it, including the placeholder domain substring `no-email.invalid`
- [ ] **AC-7** No change to request or response shapes, status codes or refusal strings for either action. No change to any spec 165 gate ordering. The audit write runs strictly after the last successful side effect.

### Edge function `delete-user`: self-guard case fix (L7)

- [ ] **AC-8** [supabase/functions/delete-user/index.ts:168](../supabase/functions/delete-user/index.ts): the self-guard compares `trim().toLowerCase()` of the request `userId` against `gate.userId.toLowerCase()`, the same normalization as `manage-store-user` `handleSetPassword` steps 1-2. The guard still fires before any read or side effect. The refusal is still HTTP 400 with the error string `cannot delete self`, byte-for-byte unchanged. A non-string `userId` must not throw an uncaught TypeError. It keeps returning 400, either `userId required` or `cannot delete self`, per the architect's design.

### Frontend: Cmd audit log display

- [ ] **AC-9** `AuditAction` in [src/types/index.ts](../src/types/index.ts) gains `'Store user created'` and `'Store user password set'`.
- [ ] **AC-10** [src/utils/formatAuditAction.ts](../src/utils/formatAuditAction.ts) `KEY_BY_ACTION` maps both new values to new `enum.auditAction.*` keys. Those keys exist with translated strings in `src/i18n/en.json`, `es.json` and `zh-CN.json`.
- [ ] **AC-11** [AuditLogSection.tsx](../src/screens/cmd/sections/AuditLogSection.tsx) `ACTION_TONE` assigns a tone to both new actions, and `inferKind` returns `'user'` for both. [PhoneAuditLog.tsx](../src/screens/cmd/sections/phone/PhoneAuditLog.tsx) `ACTION_TONE` assigns the same tones. The phone file has no `inferKind` today, so nothing to add there. Rows written by AC-1/AC-2 appear for the matching store in both views via the existing `fetchAuditLog(storeId)` path, with no `db.ts` change required.

### Tests

- [ ] **AC-12** [scripts/smoke-store-user.sh](../scripts/smoke-store-user.sh) gains arms proving:
  - (a) a successful multi-store `create` produces exactly one row per store, with the correct `store_id`, `user_id` (caller), `action`, `item_ref` (username), `value` (`''`) and `detail` (JSON with exactly the keys `target_id` = new id and `brand_id` = brand id)
  - (b) a successful `set_password` produces one row per current `user_stores` store, with the correct fields
  - (c) for every row in (a) and (b), no column contains the password used or the substring `no-email.invalid`
  - (d) at least one refused `create` and one refused `set_password` produce zero new rows, scoped by `item_ref` / `action` and a before/after count
  - (e) `set_password` on a store-less target returns 200 and produces zero rows
- [ ] **AC-13** [scripts/smoke-edge-roles.sh](../scripts/smoke-edge-roles.sh) gains an arm that sends the caller's own id **uppercased** to delete-user and expects HTTP 400 with body error exactly `cannot delete self`. It also asserts the caller's profile still exists afterward.
- [ ] **AC-14** [src/utils/enumLabels.test.ts](../src/utils/enumLabels.test.ts) drift test includes both new actions and passes. The full `npx jest`, `npm run typecheck` and `typecheck:test` all pass.

## In scope

- Service-role `audit_log` inserts in `manage-store-user` on the success paths of `create` and `set_password`
- A service-role `user_stores` read in `set_password`, after success, to choose the stores to write
- delete-user self-guard normalization (one comparison)
- Two new `AuditAction` values plus mapping, i18n (en / es / zh-CN), desktop tone + `inferKind`, phone tone
- Smoke arms (store-user + edge-roles) and the jest drift-test update

## Out of scope / Non-goals / Follow-ups

- **`audit_log` integrity gap (spec 157 deferred).** Two problems remain:
  - Any `auth_is_privileged()` caller can UPDATE/DELETE any audit row, so an admin could erase their own `'Store user password set'` entry.
  - Store members can INSERT store-scoped rows with an arbitrary `user_id`.

  This spec makes the record server-written, not tamper-proof. Follow-up: an append-only or RESTRICTIVE policy hardening spec.
- **Moving `'User invite'` / `'User deleted'` to server-side writes.** These rows are still written client-side from `src/store/useStore.ts:3414-3452`. Separate spec.
- **Schema changes.** No migration and no new columns, for example no `brand_id`. Reuses `public.audit_log` as is.
- **Store-less audit visibility.** No `store_id IS NULL` rows. Those would be readable cross-brand by every privileged caller, and no screen shows them (decision 5).
- **Friendlier row rendering.** Both screens render `itemRef · value` and do not render `detail`. With the revised decision 3 the new rows read as `<action label> <username>` (empty `value` drops the ` · ` suffix), and the desktop "top items" aggregation groups by username. Stable ids live in `detail` and are not displayed. No rendering change in this spec.
- **Prod deploy** of the two edge functions. The owner decides separately.
- **Other spec 165 findings** (L5 password floor, L6 brand-gate oracle, and so on).

## Open questions resolved

- Q: Who writes the audit row? → A: The edge function, with the service-role client, after the successful side effect. Never the client.
- Q: New table (`audit_events`) or existing? → A: Reuse `public.audit_log`. No migration or schema change.
- Q: Row shape? → A: One row per store the target belongs to: the created `storeIds` for create, and the target's current `user_stores` for set_password.
  - `store_id`: that store
  - `user_id`: caller
  - `action`: `'Store user created'` / `'Store user password set'`
  - `item_ref`: target username, lowercased as stored (non-secret, already shown in Users & access)
  - `value`: `''` (empty)
  - `detail`: compact JSON string `{"target_id":"<uuid>","brand_id":"<uuid>"}` (stable references; a username can change)
  - `created_at`: default
  - *Revised at architecture (main Claude's call):* both audit screens render `itemRef · value` and never `detail`, so the original id-in-`item_ref` mapping would have shown raw UUIDs.
- Q: What must never be recorded? → A: The password, the placeholder email, or any part of it (including its domain). Not in any column, not in logs.
- Q: Store-less target on set_password? → A: No audit row. One console line with caller id, target id and action only.
- Q: Audit insert fails? → A: Best-effort. The action still returns success. `console.error` with caller id, target id, action and error code only. Failed or refused actions write no row.
- Q: Frontend? → A: Two new `AuditAction` values, formatAuditAction mappings, en/es/zh-CN strings, tone and `inferKind` `'user'` on desktop. Phone gets tone only, because it has no `inferKind`.
- Q: delete-user L7? → A: trim + lowercase both sides. Add a smoke arm that sends the caller's own id uppercased and expects 400 `cannot delete self`, with the string unchanged.
- Q: Tests? → A: Smoke arms in `smoke-store-user.sh` per AC-12, the delete-user arm per AC-13, the jest drift test, and full jest + typechecks.
- Q: What is out of scope? → A: The `audit_log` integrity gap, migrating `User invite` / `User deleted`, and prod deploy.

## Dependencies

- Spec 165 (`manage-store-user`, commit afe181e): this spec extends its success paths.
- `public.audit_log` ([init schema :196](../supabase/migrations/20260405000759_init_schema.sql)). `user_id` FK is ON DELETE SET NULL (migration `20260528000000_actor_fk_cascade_audit.sql`). Current RLS is in `20260809000000_super_admin_policy_parity.sql`; the service role bypasses it.
- Precedent for a server-side audit insert: `copy_catalog_rows` in `20260518000000_spec049_cross_brand_copy.sql`.
- Existing read path: `fetchAuditLog` in [src/lib/db.ts:2810](../src/lib/db.ts), filtered by `store_id`, joined to the actor's name and role.

## Risks

- **AC-13 smoke arm is destructive if the fix regresses.** Without the fix, an uppercased self id passes the self-guard. If the smoke caller is not the last of its role, delete-user would delete the caller's account. The architect should pick a smoke caller or ordering that keeps this survivable, for example a throwaway privileged caller or running the arm last.
- **Partial audit on a mid-batch failure.** If the insert is not a single bulk statement, a failure could leave some stores with a row and others without. Prefer one bulk insert per action. Best-effort semantics still apply.

## Project-specific notes

- **Cmd UI section / legacy:** `src/screens/cmd/sections/AuditLogSection.tsx` and `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`. Display-only additions.
- **Per-store or admin-global:** per-store. Rows always carry a non-NULL `store_id` and are read via `auth_can_see_store()`. No cross-brand NULL-store rows.
- **Realtime channels touched:** none. `audit_log` is not subscribed in `useRealtimeSync`, so new rows appear on the next audit-log fetch.
- **Migrations needed:** no.
- **Edge functions touched:**
  - `manage-store-user`: audit inserts plus the `user_stores` read
  - `delete-user`: self-guard normalization. Keeps the `ADMIN_ROLES` gate, spec 043 brand gate and spec 031 last-of-role guard ordering unchanged.
- **Web/native scope:** both. Edge-function and display changes are platform-agnostic.
- **`app.json` slug:** not touched.
- **Test tracks:** shell smokes (`smoke-store-user.sh`, `smoke-edge-roles.sh`) and jest (`enumLabels.test.ts` drift). No pgTAP, since there is no schema change.

## Backend design

### 0. Summary

Two edge-function edits and display-only frontend additions. No migration, no RLS change, no realtime change, no `src/lib/db.ts` change, no `useStore.ts` change. `manage-store-user` gains a never-throwing audit writer that runs after the last successful side effect of each action and does one bulk `audit_log` insert through the existing service-role client. `delete-user` normalizes the request `userId` once and uses that value from the self-guard onward.

### 1. Data model

- **No migration.** Reuses `public.audit_log` (init schema :196). Columns written: `store_id`, `user_id`, `action`, `item_ref`, `value`, `detail`. `id` and `created_at` use their defaults.
- `audit_log.action` is plain `text not null` with no CHECK constraint, so the two new action strings need no DDL.
- The FKs still hold:
  - `store_id → stores(id)`: every store id written is a `user_stores.store_id` that already exists.
  - `user_id → profiles(id)`, ON DELETE SET NULL: the caller always has a profile. `requireAdminCaller` either read it or the caller holds a privileged JWT role, and every privileged role carries a profile.
- `detail` is `text`, not `jsonb`. The JSON is produced with `JSON.stringify({ target_id, brand_id })`. Insertion order makes the key order deterministic: `target_id` first, then `brand_id`. Readers must parse it, not string-match it. The smokes cast with `detail::jsonb` only in rows they scope to these two actions, because other actions' `detail` values are not JSON.

### 2. RLS impact

- **None.** The insert uses the service-role client, which bypasses RLS. That is the same posture as every other write in this function (spec 165 §4).
- Every row has a non-NULL `store_id`, so read visibility comes from the existing `store_member_read_audit_log` arm `store_id is not null and auth_can_see_store(store_id)` (`20260809000000_super_admin_policy_parity.sql:177-182`). A store admin sees rows for stores they can see. super_admin sees all. No `store_id IS NULL` rows are ever written, so the cross-brand NULL arm is never involved.
- Grants: `service_role` already has full DML on `public.*` through spec 097's explicit-grant migration (`20260618000000_public_grants_explicit.sql`).
- The known integrity gap is unchanged and deferred (Out of scope): any privileged caller may UPDATE/DELETE audit rows, and the global retention purge in `cleanupOldRecords` (`src/lib/db.ts:6017`) also deletes old rows.

### 3. API contract

No change to either action's request shape, response shape, status codes or refusal strings (AC-7). No new PostgREST surface and no RPC. The audit write is internal to the edge function.

### 4. Edge function changes

Both functions keep `verify_jwt = true`. `manage-store-user` pins it explicitly at `supabase/config.toml:498-499`. `delete-user` uses the implicit default. No config.toml edit.

#### 4.1 `manage-store-user`: new inline helpers

Place them in the `// ── Helpers ──` region, **after `compensate()`** (around line 210) and before `// ── action: create`. Do **not** touch, move or sit next to the `// BEGIN placeholder-email (spec 165)` … `// END` block at lines 68-75 or the `reserved-usernames` block. `src/lib/placeholderEmail.parity.test.ts` pins both, and the spec 166 session edits around the placeholder copies. Keeping our hunk well away from lines 50-75 keeps a merge conflict-free. Inline, not `_shared/`, per the spec 027 §4.2 rule.

Signatures (pseudocode; the developer writes the code):

```
type StoreUserAuditAction = "Store user created" | "Store user password set";
type AuditCtx = { callerId: string; targetId: string; action: StoreUserAuditAction };

// Pure. One row per store id. targetId is already lowercase.
function buildStoreUserAuditRows(
  storeIds: string[], ctx: AuditCtx, username: string | null, brandId: string | null,
): Array<{ store_id; user_id; action; item_ref; value; detail }>
  // store_id  = each id
  // user_id   = ctx.callerId
  // action    = ctx.action
  // item_ref  = username  (null allowed)
  // value     = ""
  // detail    = JSON.stringify({ target_id: ctx.targetId, brand_id: brandId })

// NEVER throws. Never rejects. Returns void in every path.
async function writeStoreUserAudit(
  service: SupabaseClient, rows: AuditRow[], ctx: AuditCtx,
): Promise<void>
  // rows.length === 0  → console.warn("[manage-store-user] audit skipped: target has no stores",
  //                                    ctx.callerId, ctx.targetId, ctx.action);  return
  // try {
  //   const { error } = await service.from("audit_log").insert(rows)
  //                                  .abortSignal(AbortSignal.timeout(3000));
  //   if (error) console.error("[manage-store-user] audit write failed",
  //                            ctx.callerId, ctx.targetId, ctx.action, error.code);
  // } catch (e) {
  //   console.error("[manage-store-user] audit write failed",
  //                 ctx.callerId, ctx.targetId, ctx.action,
  //                 e instanceof Error ? e.name : typeof e);
  // }

// NEVER throws. Returns the target's current store ids, or null if the read failed (already logged).
async function readTargetStoreIds(
  service: SupabaseClient, ctx: AuditCtx,
): Promise<string[] | null>
  // try { const { data, error } = await service.from("user_stores").select("store_id")
  //                                     .eq("user_id", ctx.targetId).abortSignal(AbortSignal.timeout(3000));
  //       if (error) { console.error("[manage-store-user] audit store read failed",
  //                                  ctx.callerId, ctx.targetId, ctx.action, error.code); return null; }
  //       return (data ?? []).map(r => r.store_id); }
  // catch (e) { console.error(... same 4 fields, e.name ...); return null; }
```

Rules, each traced to an AC:

- **One bulk `.insert(rows)` per action.** No `.select()`, so the default `return=minimal` applies. Postgres applies a multi-row INSERT atomically, so a mid-batch failure leaves zero rows rather than some (Risks: partial audit).
- **Log hygiene (AC-4, AC-6).** Every log line carries only static prefix text plus caller id, target id, action, and the error `code`. For a thrown exception the class name stands in, because a throw has no code. That matches the existing line-360 precedent. Never log `error.message`, `error.details`, `error.hint`, rows, username, the request body, the password or the placeholder.
- **Store-less line (AC-3).** It fires only when the read **succeeded** and returned zero rows. A failed read (`null`) logs the failure line instead and writes nothing. The function never writes a `store_id IS NULL` row.
- **Bounded latency.** `AbortSignal.timeout(3000)` keeps a hung PostgREST call from holding the admin's response open. An abort comes back as a returned error or a throw, and both are handled. The developer may drop the timeout if the esm.sh supabase-js build in use lacks `.abortSignal()` on the insert builder. Note that in the design-drift section of `## Files changed`.
- **Await, don't fire-and-forget.** The Deno edge runtime may tear down the isolate once the response resolves. `EdgeRuntime.waitUntil` exists, but awaiting is simpler and lets the smoke read the rows right after the response. The cost is one INSERT on create, and one SELECT plus one INSERT on set_password.

#### 4.2 `handleCreate` insertion point

Insert **after the closing `}` of the compensating `try … catch` (current line 362) and before `return json(201, { id: newId, username })` (line 365).** Outside the try, so nothing in the audit path can reach `compensateOnce()`. The helper never throws anyway; this is belt and braces.

```
// 9b. audit (spec 167) — strictly after the last successful side effect; best-effort
const ctx = { callerId: gate.userId, targetId: newId, action: "Store user created" };
await writeStoreUserAudit(service, buildStoreUserAuditRows(ids, ctx, username, derivedBrand), ctx);
```

- `ids` are the validated, deduped, lowercased store ids. They exactly match the `user_stores` rows from step 9, so there is no extra read.
- `username` is the step-2 normalized value.
- `derivedBrand` is the step-5 value.
- `newId` comes from GoTrue and is lowercase.
- Every earlier `return` (4xx/5xx, compensated failures) exits before this line (AC-5).

#### 4.3 `handleSetPassword`

- **Step 4 select:** change `select("brand_id, role")` to `select("brand_id, role, username")` and widen the local type to `{ brand_id: string | null; role: string; username: string | null }`. This is the same read with one more column and no new round trip. Gate ordering is unchanged.
- **Insertion point:** after the `if (updErr) { … }` block (current line 441), before `return json(200, { success: true })` (line 443).

```
// 7. audit (spec 167) — after updateUserById succeeded; best-effort
const ctx = { callerId: gate.userId, targetId: userId, action: "Store user password set" };
const storeIds = await readTargetStoreIds(service, ctx);
if (storeIds !== null) {
  await writeStoreUserAudit(service, buildStoreUserAuditRows(storeIds, ctx, target.username, target.brand_id), ctx);
}
```

**Decision: read `user_stores` AFTER the side effect, not in the step-4 parallel reads.** Reasons:

1. **AC-7 / spec 165 gate ordering stays byte-identical.** The pre-side-effect sequence is untouched except for one column in an existing select. Adding a third leg to the step-4 `Promise.all` would add a new failure mode (its `error`) to the gate path. We would then have to decide whether a read failure refuses the action, and the owner decided audit is best-effort, so it must not.
2. **Refused paths do zero extra I/O.** AC-5 holds by construction, not by discipline.
3. **Read failure falls naturally under AC-4.** It lives inside the same never-throw envelope as the insert.
4. **It reflects stores at write time.** That is what the AC-2 text specifies ("after a successful set_password … reads").

The cost is one sequential round trip (a few ms on an indexed `user_stores.user_id` lookup) on the success path only.

- `userId` is the step-1 normalized (trimmed, lowercased) value.
- `brand_id` may be `null` in `detail` when a super_admin targets a brandless `role='user'` account. The `detail` shape allows `"brand_id":null`.
- `target.username` is written as stored with no transform. Every placeholder account is created by this function, which lowercases, so it is lowercase in practice.

#### 4.4 `delete-user`: self-guard normalization (AC-8)

Replace lines 159-173 with this shape (pseudocode):

```
const body = await req.json();
const rawUserId = body && typeof body === "object" ? (body as Record<string, unknown>).userId : undefined;
const userId = typeof rawUserId === "string" ? rawUserId.trim().toLowerCase() : "";
if (!userId) → 400 { error: "userId required" }          // unchanged string
if (!UUID_RE.test(userId)) → 400 { error: "userId required" }   // fix pass (S1): canonical form only
if (userId === gate.userId.toLowerCase()) → 400 { error: "cannot delete self" }   // byte-identical
```

`UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` is copied inline, byte-identical to `manage-store-user/index.ts` `UUID_RE` (spec 027 §4.2 inline-not-shared). It runs after normalization and before the self-guard and any read or side effect, the same shape as `manage-store-user` `handleSetPassword` steps 1-2.

- A non-string `userId` (number, bool, object, array) normalizes to `""` and returns 400 `userId required`. It never reaches `.trim()`, so no TypeError (AC-8). A `null` or array body no longer hits a destructuring TypeError (pre-existing 500). This is a strictly narrower failure surface on the same lines.
- **The normalized `userId` flows to every later use:** the `requireSameBrandOrSuperAdmin` target read, the super_admin role lookup, `assert_not_last_of_role`, the three cleanup deletes, and `auth.admin.deleteUser`. Justification:
  - Every DB-side use compares against a `uuid` column or `uuid` parameter, and Postgres uuid input is case-insensitive, so query semantics are identical.
  - *(Corrected post-impl, architect M1.)* supabase-js `auth.admin.deleteUser` validates the id client-side against a canonical **lowercase, hyphenated** UUID regex and **throws** `@supabase/auth-js: Expected parameter to be UUID but is not`. Canonicalizing the id is therefore *required* for the delete to work, not just semantically equivalent.
  - Using one canonical string for the whole handler removes the two-strings-one-identity class of bug that produced L7.
  - *(Corrected post-impl, architect M1.)* Two behavior changes. (1) Padded ids are trimmed. (2) Uppercase ids for a non-self target used to delete the `user_stores` / `profiles` / `invitations` rows and then return 500 with the auth user orphaned. They now complete the delete. Both are fixes.
- **`UUID_RE` gate (reversed post-impl, architect S1 / security M1).** The original text said "No `UUID_RE` validation is added. A malformed string still produces today's brand-gate 403 or 500." That held only for strings Postgres rejects. Postgres-valid non-canonical encodings (braces, no hyphens, hyphens every 4 digits) passed the string self-guard, ran the three cleanup deletes and then 500'd in supabase-js `validateUUID`: a self-delete / half-delete. Reason for reversal: canonical-form validation is the only way to make the string self-guard and supabase-js agree with Postgres on identity. Previously malformed or non-canonical input now returns 400 `userId required` instead of 403 / 500 / half-delete; `cannot delete self` is byte-identical.
- **Not changed (scope):**
  - `requireAdminCaller`, `ADMIN_ROLES`, the spec 043 brand gate and the spec 031 last-of-role ordering stay as they are.
  - Raw `error.message` responses at lines 102/117/226/241/255/265 are pre-existing, out of scope, and fine to note as a follow-up.

### 5. `src/lib/db.ts` surface

**None.** The rows reach both views through the existing `fetchAuditLog(storeId)` (`src/lib/db.ts:2810`), which already maps `item_ref → itemRef`, `value → value` (`''`), `detail → detail` and `user_id → userId`, and joins the actor's name and role. No new helper and no mapping change.

### 6. Realtime impact

**None.** `audit_log` is not in the `supabase_realtime` publication (`20260530000000_record_missed_orders_rpc.sql:92-94`) and is not subscribed in `useRealtimeSync`. New rows appear on the next audit-log fetch. Publication membership is unchanged, so no `docker restart supabase_realtime_imr-inventory` step is needed.

### 7. Frontend store impact

**None in `src/store/useStore.ts`.** There are no client writes, so the optimistic-then-revert / `notifyBackendError` pattern does not apply. Display only:

| File | Change |
|---|---|
| `src/types/index.ts:602-616` | Append `\| 'Store user created'` and `\| 'Store user password set'` to `AuditAction`. |
| `src/utils/formatAuditAction.ts:11-26` | `KEY_BY_ACTION`: `'Store user created': 'storeUserCreated'`, `'Store user password set': 'storeUserPasswordSet'`. `Record<AuditAction, string>` makes typecheck enforce this. |
| `src/i18n/en.json` (`enum.auditAction`, ~line 1723-1738) | `"storeUserCreated": "created store user"`, `"storeUserPasswordSet": "set store user password"` |
| `src/i18n/es.json` (same block) | `"storeUserCreated": "creó usuario de tienda"`, `"storeUserPasswordSet": "estableció contraseña de usuario de tienda"` |
| `src/i18n/zh-CN.json` (same block) | `"storeUserCreated": "创建门店用户"`, `"storeUserPasswordSet": "设置门店用户密码"`. The developer should check the catalog's existing word for "store" (门店 vs 店铺) and match it. |
| `src/screens/cmd/sections/AuditLogSection.tsx:21-35` | `ACTION_TONE`: `'Store user created': 'ok'` (parallels `Item added`), `'Store user password set': 'warn'` (security-sensitive, review-worthy; parallels `Waste log` / `Order missed`) |
| `src/screens/cmd/sections/AuditLogSection.tsx:58-70` | `inferKind`: add `if (a === 'Store user created' \|\| a === 'Store user password set') return 'user';` before `return 'other'`. Neither string starts with an existing prefix (`Item`/`Recipe`/`Prep recipe`), so placement anywhere before the fallback works. |
| `src/screens/cmd/sections/phone/PhoneAuditLog.tsx:39-53` | `ACTION_TONE`: the same two entries with the same tones. Phone has no `inferKind`. |
| `src/utils/enumLabels.test.ts:64-79` | Add both actions to `ACTIONS`. Add one es and one zh-CN exact-string assertion for each new key, mirroring the spec 075 `orderMissed` cases at lines 105-113. |

Rendering check: both views render `{itemRef}{value ? ' · ' + value : ''}` (`AuditLogSection.tsx:223,317`, `PhoneAuditLog.tsx:182-183`). With `value = ''` a row reads "created store user zz_cashier" with no trailing separator. The phone filter at `PhoneAuditLog.tsx:88` already searches `itemRef`, so usernames become searchable for free.

`src/i18n/i18n.test.ts` checks catalog shape and parity. Adding both keys to all three catalogs keeps it green.

### 8. Smoke design

#### 8.1 `scripts/smoke-store-user.sh`: audit arms (AC-12)

Follow the script's existing mechanics: `psql_q` (docker exec psql as postgres) for DB reads, `call`/`expect` for HTTP, and the `pass`/`fail`/`skip` accumulator. **Do not use service-role REST.** The script reads every DB assertion through `psql_q`, and so should these arms.

To keep the diff away from spec 166 (which may fold arms into this script), additions are limited to:

- (i) header arm list and recovery block lines
- (ii) one cleanup statement in `cleanup()`
- (iii) one baseline capture in preflight
- (iv) one new contiguous block inserted **after Arm 17 and before Arm 18**

No edits inside existing arms.

1. **Preflight baseline**, after the fixtures are created:
   ```
   AUDIT_ACTIONS_SQL="action in ('Store user created','Store user password set')"
   AUDIT_BASE=$(psql_q "select count(*) from public.audit_log where $AUDIT_ACTIONS_SQL")
   ```
2. **Cleanup**, added to the existing `cleanup()` psql statement before the user deletes. It does not cast `detail`, because other actions' `detail` is not JSON:
   `delete from public.audit_log where action in ('Store user created','Store user password set') and item_ref like 'zz_s165%';`
   Add the same line to the header's kill -9 recovery block.
3. **New block "Arm A: server-side audit trail (spec 167)"**, after Arm 17. By this point arms 1-17 have run, so every assertion is a scoped total. A refused path that wrote a row would push a total above its exact expected value, which is the before/after proof for AC-12(d).
   - **A1, create multi-store (AC-12a).** Query `action='Store user created' and item_ref='${U_MAIN}'`. Assert:
     - exactly 2 rows
     - `store_id` set = {`$STORE_A1`, `$STORE_A2`}
     - every `user_id = $ADMIN_ID`
     - `coalesce(value,'') = ''`
     - `detail::jsonb->>'target_id' = $NEW_ID` and `->>'brand_id' = $BRAND_A`
     - the key set is exactly `{brand_id,target_id}`: `(select array_agg(k order by k) from jsonb_object_keys(detail::jsonb) k) = '{brand_id,target_id}'`
     Exactly 2 also proves the Arm 9 duplicate store id was deduped, and the Arm 11 409s (same `item_ref`) wrote zero (AC-12d, create).
   - **A2.** `item_ref='${U_ROLE}'`, created: exactly 1 row, `store_id = $STORE_A1`, brand A in `detail`. The Arm 10 injected `brand_id` (brand B) was ignored in the audit too.
   - **A3, compensation.** `item_ref='${U_COMP}'`, created: exactly **1** row, from the post-fault retry. Proves the compensated Arm C attempt wrote zero (AC-5).
   - **A4, set_password (AC-12b).** `action='Store user password set' and item_ref='${U_MAIN}'`: exactly 2 rows, stores {A1, A2}, `user_id = $ADMIN_ID`, `value ''`, `detail` `target_id = $NEW_ID` and `brand_id = $BRAND_A`. Exactly 2 also proves Arm 8b (short password on the same target) wrote zero (AC-12d, set_password).
   - **A5.** `action='Store user password set' and item_ref='${U_ROLE}'`: 0 rows (Arm 14b refusal).
   - **A6, store-less target (AC-12e).**
     - Create `U_NOST="zz_s165_n${SUFFIX}"` (15 chars) via `call` with `[$STORE_A1]` and expect 201. This contributes 1 created row.
     - `psql_q "delete from public.user_stores where user_id='${NOST_ID}'"`.
     - `set_password` with `PW2` and expect 200 with a body of exactly `{"success":true}`.
     - Assert 0 rows for `action='Store user password set' and item_ref='${U_NOST}'`.
     - Assert 0 rows for `$AUDIT_ACTIONS_SQL and store_id is null` across the whole table.
   - **A7, global tally (AC-5 catch-all).** `count(*) where $AUDIT_ACTIONS_SQL` minus `$AUDIT_BASE` must equal **7**: created U_MAIN 2 + U_ROLE 1 + U_COMP 1 + U_NOST 1, plus set U_MAIN 2. This catches a row from any refused path anywhere in the script, including ones whose `item_ref` is not a zz username: Arm 2 / Arm 13 (self), Arm 14 (admin target with NULL username), unknown target, malformed id. The local stack has no concurrent writers.
   - **A8, secrets (AC-12c / AC-6).** Dump every row matching `$AUDIT_ACTIONS_SQL and item_ref like 'zz_s165%'` as `concat_ws('|', store_id, user_id, action, item_ref, value, detail)` into a variable. `grep -F` it for `$PW1`, `$PW2`, `no-email.invalid`, and `$NEW_EMAIL` when it is non-empty. Any hit fails. Do the matching in bash, not SQL, to avoid quoting the password into SQL.
   - **A9 (recommended, SKIP-able), log hygiene.** Record `SMOKE_T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)` in preflight. Then `docker logs --since "$SMOKE_T0" "$EDGE_CONTAINER" 2>&1 | grep -F` for `$PW1` and `$PW2`, and expect no match. SKIP if `docker logs` fails. Passwords only: other functions exercised in this run (username-resolve, send-welcome-email) are outside this spec's AC-6 and could legitimately mention the placeholder domain, so scanning for it would be flaky.

Update the header arm table: add "A audit trail (spec 167)".

#### 8.2 `scripts/smoke-edge-roles.sh`: Arm 8, delete-user uppercase self (AC-13)

**Caller choice: a disposable same-brand `admin` created by the smoke, and the arm runs last** (new Arm 8, after Arm 7, before the summary). Why this survives a regression:

- If L7 regressed, the uppercased id passes the self-guard.
- The brand gate then passes (same brand A), and `assert_not_last_of_role` is a no-op for `target_role = 'admin'` (`20260514160000_assert_not_last_of_role.sql:55`).
- So delete-user **would delete the caller**. With a disposable caller, the only casualty is the throwaway account. `admin@local.test`, which every other smoke and the dev login depend on, is never the caller or the target.
- The arm then fails loudly on the "profile still exists" assertion.
- Running last means that even a catastrophic outcome cannot poison Arms 3-7.

Mechanics. Mirror `smoke-store-user.sh` Arm 14, which already creates an admin fixture this way:

1. SKIP the arm (not FAIL) when `docker exec supabase_edge_runtime_imr-inventory printenv SUPABASE_SERVICE_ROLE_KEY` returns empty. This is consistent with the script's CI-without-stack posture.
2. `SELFDEL_EMAIL="zz_s167_selfdel_${RANDOM}${RANDOM}@local.test"`. Create the user with `POST /auth/v1/admin/users` (service key, `email_confirm:true`, a random password). Then psql: `insert into public.profiles (id, name, role, brand_id) values ('<id>', 'zz_s167 selfdel', 'admin', '<BRAND_A>')`. Set `SELFDEL_CREATED=1`.
3. Log in via the password grant to get the bearer and `.user.id`.
4. POST `delete-user` with `{"userId":"<id uppercased via tr 'a-f' 'A-F'>"}`. Expect HTTP 400, and `jq -r '.error'` must equal exactly `cannot delete self`. This is an exact match, not Arm 6's regex alternative.
5. POST again with the uppercased id padded with surrounding spaces. Same expectation (this covers the trim).
6. POST with `{"userId": 12345}` (a number). Expect 400 with `.error` exactly `userId required`, per §4.4. This proves no uncaught TypeError and no 500 (AC-8 non-string clause).
7. Post-checks via psql:
   - `count(*) from public.profiles where id='<id>'` = 1
   - `count(*) from auth.users where id='<id>'` = 1
   - `count(*) from public.user_stores where user_id='<id>'` unchanged (0)
8. **Cleanup:** extend the existing `restore_admin` EXIT trap. Add a guarded block, `if [[ "$SELFDEL_CREATED" == "1" ]]`, that runs `delete from auth.users where email like 'zz_s167_selfdel_%@local.test'` (profiles cascade, as `smoke-store-user.sh` cleanup relies on). Keep it inside the single trap function, because bash allows only one EXIT trap per signal. Add the recovery SQL to the header comment.

### 9. Risks and tradeoffs

- **Not tamper-proof.** Server-written only. A privileged caller can still DELETE their own `'Store user password set'` row, and the global retention purge removes old rows. Deferred to the spec 157 FUTURE-1 append-only follow-up (Out of scope).
- **Response latency.** +1 INSERT on create, +1 SELECT and +1 INSERT on set_password, all awaited. Bounded by the 3 s abort, a few ms in practice. On the 286 KB seed there is negligible table volume. `user_stores.user_id` lookups are indexed by the composite key.
- **No cold-start impact.** No new imports. The helpers use the already-imported supabase-js client.
- **Best-effort means the record can be missing.** A transient DB failure after a successful password set leaves no row, only a `console.error` with the code. The owner accepted this explicitly (decision 6). Edge function logs are the fallback trail.
- **Username drift.** `item_ref` is a point-in-time username. If it changes later, old rows show the old name. `detail.target_id` is the stable join key. The desktop "top items" aggregation groups by username, which is acceptable.
- **`brand_id: null` in `detail`** is possible for set_password by a super_admin on a brandless store user. That is documented in AC-2.
- **Merge surface with spec 166.** Both specs may touch `manage-store-user/index.ts` and `smoke-store-user.sh`. This design keeps 167's hunks to the helpers region after `compensate()`, the two success-tail insertion points, one select column, and an appended smoke block, all away from the placeholder block.
- **Prod deploy:** both functions need `supabase functions deploy manage-store-user delete-user`. There is no migration, so the `db-migrations-applied` gate is unaffected. Deploy remains the owner's call (Out of scope). Spec 165's function is committed but not deployed, so 167 rides the same rollout.
- **Smoke destructiveness (AC-13).** Contained by the disposable caller (§8.2).

### 10. Build split (parallel-safe; disjoint file sets)

**backend-developer**:
- `supabase/functions/manage-store-user/index.ts`: §4.1-4.3
- `supabase/functions/delete-user/index.ts`: §4.4
- `scripts/smoke-store-user.sh`: §8.1
- `scripts/smoke-edge-roles.sh`: §8.2
- Verification:
  - `npm run dev:db`
  - check the edge-runtime bind mount (CLAUDE.md sanity check)
  - `bash scripts/smoke-store-user.sh` and `bash scripts/smoke-edge-roles.sh` both green
  - `npx jest src/lib/placeholderEmail.parity.test.ts`, to prove the pinned blocks are untouched

**frontend-developer**:
- `src/types/index.ts`
- `src/utils/formatAuditAction.ts`
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
- `src/screens/cmd/sections/AuditLogSection.tsx`
- `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`
- `src/utils/enumLabels.test.ts`
- Verification: full `npx jest`, `npm run typecheck`, `npm run typecheck:test`. Optionally, a browser check of a seeded `'Store user password set'` row in the Audit log section (desktop + phone width) after the backend lands.

No file appears in both lists. The frontend does not depend on the backend at build time: the strings are a contract, both sides use the exact literals `'Store user created'` and `'Store user password set'`, and the jest test needs no DB.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec (## Backend design, §10 assigns your files — do not edit files in the other developer's list). After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/167-store-user-audit-trail.md

## Files changed

### Backend (backend-developer)

Edge functions:
- `supabase/functions/manage-store-user/index.ts`: §4.1-4.3. Adds the inline helpers `buildStoreUserAuditRows`, `writeStoreUserAudit` and `readTargetStoreIds` after `compensate()`, plus the `AuditCtx` / `AuditRow` / `StoreUserAuditAction` types and `AUDIT_TIMEOUT_MS = 3000`. The create audit (step 9b) sits outside the compensating try, before the 201. The set_password audit (step 7) runs after `updateUserById`, before the 200. The step-4 select gains `username`. The placeholder-email and reserved-usernames blocks are untouched (`placeholderEmail.parity.test.ts`: 9/9 pass).
- `supabase/functions/delete-user/index.ts`: §4.4. `userId` is normalized once (non-string → `""` → `userId required`), the self-guard compares against `gate.userId.toLowerCase()`, and the normalized value flows to every later use.

Smokes:
- `scripts/smoke-store-user.sh`: §8.1. Header arm list + recovery SQL, one `audit_log` cleanup statement in `cleanup()`, the `AUDIT_BASE` / `SMOKE_T0` baseline in preflight, and a new contiguous "Arm A" block (A1-A9) between Arm 17 and Arm 18. No edits inside existing arms.
- `scripts/smoke-edge-roles.sh`: §8.2. New Arm 8 runs last with a disposable same-brand admin. It sends the uppercased id, the uppercased+padded id and a numeric `userId`, then post-checks profiles / auth.users / user_stores. The `SELFDEL_CREATED` guarded cleanup sits inside the existing `restore_admin` EXIT trap, and the header has the recovery SQL.

Backend design drift: none. `.abortSignal()` exists on the esm.sh supabase-js builder in use, so the 3 s timeout is kept. One note on a §4.4 premise: "GoTrue's admin delete parses the path id as a uuid" is slightly off. supabase-js `auth.admin.deleteUser` checks a **lowercase-only** UUID regex on the client side and rejects uppercase ids with `Expected parameter to be UUID but is not`. The lowercasing in this spec makes that safe. The scratch run below shows that before the fix, an uppercased id for **any** target got through the brand gate and deleted the `user_stores` / `profiles` / `invitations` rows, then hit a 500 at `deleteUser`, leaving a partial delete. The normalization closes that case too.

Verification (local stack, edge runtime restarted to drop warm `per_worker` workers):
- `bash scripts/smoke-store-user.sh`: exit 0, 85 PASS / 0 FAIL / 1 SKIP. The SKIP is the existing username-resolve token skip, not related to this spec.
- `bash scripts/smoke-edge-roles.sh`: exit 0, 24 PASS / 0 FAIL / 0 SKIP.
- Arm 8 is shown to be meaningful by a scratch run of the HEAD delete-user, swapped in temporarily and restored with a matching md5. With a disposable admin sending its own uppercased id, the old code returned HTTP 500 and **deleted the caller's profile row**, so Arm 8 would fail both its 400 assertion and its "profile still exists" check.
- `deno check` on both functions passes (npx deno@2, scratch config outside the repo). `tsc -p tsconfig.json` excludes `supabase/functions/**`; it passes but does not cover these files.

#### Backend fix pass (release-proposal items 2-5)

Edge functions:
- `supabase/functions/delete-user/index.ts`: inline `UUID_RE` (byte-identical to `manage-store-user/index.ts:50`). After normalization, `!userId || !UUID_RE.test(userId)` → 400 `userId required`, before the self-guard and before any read or side effect (architect S1 / security M1). `cannot delete self` unchanged.
- `supabase/functions/manage-store-user/index.ts`: comment-only. The log-hygiene header now mentions the spec 167 audit log lines (code-reviewer nit). No code change.

Smokes:
- `scripts/smoke-edge-roles.sh`: `sd_psql` now captures psql output first and returns psql's exit status (`|| return 1`), so the "could not create the disposable admin fixture" branch can fire (code-reviewer Should-fix). Arm 8 gains two calls, the caller's own id in braces and with hyphens removed, both expecting 400 `userId required`, ahead of the existing profile / auth user / user_stores post-checks.
- `scripts/smoke-store-user.sh`: new Arm AF (AC-4 failure injection), placed between A6 and A7. It installs a temporary `zz_s167_fail_audit_log` BEFORE INSERT trigger on `public.audit_log`, which raises P0001 only for `item_ref = U_AUD`. Then it runs one create and one set_password and asserts: 201 with `{id, username}`; account kept (profile, auth user and user_stores, no compensation); 200 `{success:true}` with the new password working; zero audit rows for `U_AUD`; the trigger dropped; edge logs with ≥2 `audit write failed … P0001` lines for the target and never the trigger's message. The `AUDIT_TRIGGER_INSTALLED`-guarded drop is in the `cleanup()` EXIT trap, and the header lists it plus the kill -9 recovery SQL. A7's delta stays 7 (AF adds 0 by design), and a comment by the tally says to update it whenever a success arm is added.

Verification (local stack, edge runtime restarted, bind mount checked at `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`):
- Pre-fix proof: with the staged (pre-fix) delete-user swapped in temporarily, the new Arm 8 calls returned `HTTP 500 '@supabase/auth-js: Expected parameter to be UUID but is not'`, and the post-check "caller profile was DELETED" failed (half-delete reproduced). The fixed file was restored afterwards.
- `bash scripts/smoke-edge-roles.sh`: exit 0, 26 PASS / 0 FAIL / 0 SKIP (PASS lines include the two trap cleanup lines).
- `bash scripts/smoke-store-user.sh`: exit 0, 97 PASS / 0 FAIL / 1 SKIP (the SKIP is the existing username-resolve token skip; PASS lines include the cleanup line).
- `sd_psql "select 1/0"` returns non-zero. A hand-installed `zz_s167_fail_audit_log` trigger is removed by `cleanup()` when `AUDIT_TRIGGER_INSTALLED=1`.
- `npx jest src/lib/placeholderEmail.parity.test.ts`: 9/9.
- `deno check` (npx deno@2, scratch config outside the repo) on delete-user and manage-store-user: clean.
- After the runs: 0 `zz_%` auth users / profiles / audit rows / brands / stores, 0 non-internal triggers on `public.audit_log`, 0 `zz_%` functions.

### Frontend (frontend-developer)

- `src/types/index.ts`: `AuditAction` gains `'Store user created'` and `'Store user password set'` (AC-9).
- `src/utils/formatAuditAction.ts`: `KEY_BY_ACTION` maps them to `storeUserCreated` / `storeUserPasswordSet` (AC-10).
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`: `enum.auditAction.storeUserCreated` / `storeUserPasswordSet`, with the §7 strings. zh-CN uses 门店, which matches the catalog (77 uses of 门店, 0 of 店铺, and the existing `addUser` string "添加门店用户") (AC-10).
- `src/screens/cmd/sections/AuditLogSection.tsx`: `ACTION_TONE` maps created to `ok` and password set to `warn`. `inferKind` returns `'user'` for both (AC-11).
- `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`: `ACTION_TONE` gets the same two tones (AC-11).
- `src/utils/enumLabels.test.ts`: both actions added to `ACTIONS`, plus es and zh-CN exact-string assertions for each new key (AC-14).

Frontend design drift: none.

#### Frontend fix pass (release-proposal item 1, AC-11 coverage)

- `src/screens/cmd/sections/AuditLogSection.tsx`: `ACTION_TONE` and `inferKind` are now named exports. Behavior is unchanged.
- `src/screens/cmd/sections/phone/PhoneAuditLog.tsx`: `ACTION_TONE` is now a named export. Behavior is unchanged.
- `src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx` (new): `inferKind` returns `'user'` for both actions, desktop tones are `ok` / `warn`, and phone tones equal desktop (AC-11).
- `src/screens/cmd/sections/phone/__tests__/PhoneAuditLog.test.tsx`: a render test showing the translated verb plus the username, with no ` · ` suffix (AC-11).
