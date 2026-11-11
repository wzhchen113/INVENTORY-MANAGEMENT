## Security audit for spec 187

Auditor: security-auditor, 2026-11-08. Local stack only. Prod was not touched.

**Bottom line:** the erase-and-return chain from M1 is closed, and nobody can edit, blank or re-point the approver or snapshot columns by any API write I could find. L4 is closed too. But the columns can still end up saying something false, because an attacker doesn't have to write to them. There are 0 Critical, 2 High, 2 Medium and 7 Low findings.

- **H1:** a second admin can change a pending row's lines and approve it while it stays under the first admin's name. The snapshot then makes that permanent.
- **H2:** an older cross-brand hole now also exposes approver emails and lets an outsider write to another brand's approvals.

### What I ran and what I only read

**Ran:** three probe scripts on `supabase_db_imr-inventory`, each in one transaction ending in `ROLLBACK`. Callers were simulated with `set local role` plus `request.jwt.claims`, which is how PostgREST presents them. Afterwards I confirmed 0 fixtures were left behind and removed my probe files from the container's `/tmp`.

Also ran:
- catalog queries
- a comparison of live function bodies against the migration (whitespace normalized; all three match)
- a diff of the guard and RPC against their previous definitions
- `order_approvals_approver_snapshot.test.sql` (49/49 ok) and `audit_log_rls_hardening.test.sql` (61/61 ok), both of which roll back
- `npx jest src/lib/placeholderEmail.parity.test.ts` (11/11 ok)

**Not run, read only:**
- **`delete-user`.** Real calls commit outside a transaction, so every statement about it comes from reading the code. The developer's smoke results are theirs, and I did not reproduce them.
- **`scripts/smoke-delete-user.sh`.** It commits to the shared stack.
- **Real HTTP.** No probe went through PostgREST or a signed JWT. The upsert probes are hand-written SQL in the shape I expect `Prefer: resolution=merge-duplicates` to generate (`ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col`).
- **GoTrue.** An email change would commit, so the email half of M1 is simulated.
- **`pg_graphql`.** The extension is installed locally. I did not probe it. The guard and RLS sit on the table, so I expect the same results.

Each finding is tagged **[ran]**, **[read]** or **[simulated]**.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

**H1. Bob can put his own lines and approval under Alice's permanent name. [ran]**

- **Where:** `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:104-107` (the re-stamp fires only when `approved_by` changes), `:172` (the no-approver refusal checks only for NULL), `:180` (lines stay writable while pending). Reached through `supabase/functions/instacart-cart-link/index.ts:679` as well.
- **What I ran**, as Bob, a same-brand admin, on Alice's pending row:
  ```
  PATCH lines=<Bob's>, line_count=1, est_total_cost=99000  -> row still 0a / Alice Admin
  PATCH status='approved'                                  -> approved, Alice Admin
  PATCH status='ordered'                                   -> ordered, Alice Admin
  ```
  - Final row: `ordered | Alice Admin | p187-0a@local.test | BOB-LINE qty 99`.
  - Alice can't correct it. Her re-stamp is a no-op, and once the row leaves pending the name and lines are frozen.
  - A plain `status='approved'` by Bob on Alice's untouched row also leaves it under her name.
  - Nothing records that Bob did either of these.
- **Why it matters:**
  - D3 is titled "the approver follows the lines while pending" and says the re-stamp fixes false attribution "which an immutable snapshot would otherwise make permanent". That holds only through the RPC.
  - The design's risk note covers the opposite case, Bob taking over and keeping Alice's lines. It doesn't cover Bob's lines staying under Alice's name.
  - Before this spec the same PATCH was possible, but the name was only a live profile join. Now it is an immutable statement that Alice approved those lines.
  - Direct PATCH also skips the RPC's line validation (the 100000 quantity cap), and `est_total_cost` can be any value.
- **Why High and not Critical:** it needs a privileged caller in the same brand, grants no new access, and prod has 0 approvals, so nothing is affected yet. It should go in before approvals are in use, because the guard then refuses any repair of false rows.
- **Fix, in the guard, for callers with a non-NULL `auth.uid()`:**
  - Refuse `pending -> approved` when `new.approved_by` isn't `auth.uid()`.
  - Refuse a change to `lines`, `line_count`, `est_total_cost` or `channel` on a pending row under the same condition.
  - Keep the "never NULL" form from the `v_restamp` comment. With a NULL `auth.uid()` the rule doesn't apply, so G1 to G5 are unaffected.
  - Refuse rather than auto re-stamp. Otherwise a late `instacart-cart-link` write-back from Alice could claim lines Bob just wrote.
  - I traced the app's writes. `useStore.ts:4287`, `:4317`, `:4332` and `:4380` all run in the same session right after `createOrderApproval` re-stamped the row, so they should still pass. I did not run this change.
  - Add pgTAP arms for both PATCH routes, and re-check `cross_store_item_rejection.test.sql`.

**H2. A demoted admin's token can read and write another brand's approvals. The root cause is older, but this spec raises the impact. [ran, except the token itself]**

This answers your question about a JWT whose `sub` differs from the claim role.

- **Where:**
  - `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:104` (own-row `user_stores` writes)
  - `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql` (no brand scope; sets `brand_id = NULL`)
  - `auth_is_admin()`, which trusts only the JWT claim
  - the new data in `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:52-53` and `:486`
- **What I ran:**
  - Carol, a brand B admin, called `demote_profile_to_user(<Alice>)`. Alice, in brand A, became `role=user, brand_id=NULL`. A brand admin can therefore demote a user in another brand.
  - I then simulated that state: profile `user` with NULL brand, JWT claim still `admin`. In that state `auth_is_privileged()` is true.
  - That caller inserted their own `user_stores` row on a brand B store. `user_stores_brand_match` allows a NULL-brand user's first brand. They then:
    - read `approved_by_email` and name on a brand B approval
    - read a brand B `User deleted` row, including its email
    - PATCHed lines and cost on the other brand's pending row and moved it to `approved`, still under the brand B approver's name
    - re-stamped a pending brand B row to themselves
  - Unlinking and relinking moved them to another brand's store, and they read its emails too.
- **Other JWT cases, all [ran]:**

  | Caller | Result |
  |---|---|
  | Staff with a stale `admin` claim, same brand | Reads `User deleted` rows, re-stamps and approves. The snapshot correctly names the staff member |
  | `super_admin` claim on a staff profile | Not privileged, 0 rows. `auth_is_super_admin()` reads the profile |
  | `admin` claim, login but no profile | Store not visible, 0 rows |
  | Staff with a correct `user` claim, self-linked to a foreign store | `order_approvals` 0, `User deleted` 0 |
  | Brand A admin self-linking to a brand B store | Refused by `user_stores_brand_match` |

- **What is new:** the self-link and the stale claim are the queued follow-ups H1, H2 and M2 in the project notes, and they already gave this caller cross-brand access to these tables. `get_profile_emails` refuses this caller, because a NULL brand fails `auth_can_see_brand`. This spec adds a second route to auth emails that doesn't have that check, and adds a table row that lets the caller fabricate another brand's approval (see H1).
- **Limits on the attack:**
  - The window is one token lifetime. `jwt_expiry = 3600` locally; prod not checked.
  - The attacker has to already be an admin, and needs a target login whose token is still live. A brand admin can invite a second admin, or a brand admin in another brand can do the demoting.
  - The customer PWA can't reach this path, since it needs a privileged claim.
  - I couldn't check whether the `user_stores` policy is still the same on prod. Local still has it.
- **Why High and not Critical:** this spec didn't create the hole, and it can't be reached without a privileged account. I would still treat the multi-tenant boundary as broken. You may want to raise it.
- **Fix:** ship the queued `user_stores` own-row write removal before or with this spec. Add a brand check to `demote_profile_to_user`. Separately, have the guard's re-stamp and the H1 rule check `profiles.role` against the claim, so a stale claim can't stamp or approve.

### Medium

**M1. The snapshot's sources are client-writable, so the "server-written" name can be forged or blanked. [ran for name, simulated for email]**

- **Where:** `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:73-74` and `:124-125`; policies `Users can update own profile` and `Admins can update any profile` (`supabase/migrations/20260517050000_rls_hardening_followups.sql:99`).
- **What I ran:**
  - Alice renamed herself `Bob Admin`, called the RPC and renamed herself back. The row's snapshot stays `Bob Admin` for good.
  - Alice set her name to `''`. The stored snapshot name is blank.
  - Bob renamed Alice `Mallory` before she approved. Her row's snapshot says `Mallory`.
- **Email:** with `auth.users.email` changed first, the snapshot took the new address. I made that change as postgres. GoTrue was not exercised. Local has `GOTRUE_MAILER_AUTOCONFIRM=true` and `enable_confirmations = false` (`supabase/config.toml:232`). From memory of GoTrue, autoconfirm applies `PUT /auth/v1/user` email changes immediately, and the project notes say prod's email confirmation is off too. Please verify both before relying on this.
- **Result:** while the profile exists, `approved_by` still identifies the real person. After `delete-user`, the pointer is NULL and the snapshot has no id, so the forged name and address are all that remain. One person can do this alone, because a brand admin can invite a second admin to do the delete. That is the M1 shape from spec 178, moved from erasing to forging.
- **Fix:**
  - Add a snapshot of the approver's uuid with no FK (for example `approved_by_id`), set and guarded with the other two. It ties a forged row back to the account, and to `detail.target_id` on the `User deleted` row.
  - Store `nullif(btrim(name), '')` and fall back to the email, so a blank name can't blank the record.
  - Audit privileged renames and email changes as a follow-up.

**M2. One brand admin can still erase approvals, snapshots and `User deleted` rows by deleting the store. [ran]**

- **Where:** `supabase/migrations/20260509000000_multi_brand_schema_rls.sql:638` (`privileged_delete_stores`), plus `ON DELETE CASCADE` on `order_approvals.store_id` and `audit_log.store_id`.
- **What I ran:**
  - Bob ran `DELETE stores`. Approvals on that store went 18 to 0, and `User deleted` rows on it went to 0.
  - A super_admin's direct `DELETE brands`, with no soft-delete first, also removed that brand's approvals and wrote 0 `brand_deletion_log` rows. That goes through `super_admin_manage_brands` (`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:429`) and skips `hard_delete_brand`'s pre-flight checks and log.
  - A direct brand delete with an admin attached is refused by `profiles_role_brand_consistent`.
- **Context:** the spec lists store deletes as out of scope, citing spec 178's note that audit M2 "did not hold up". That note is about whether the delete was newly possible. It doesn't say the delete is impossible, and it isn't. Spec 187 calls the snapshot "the durable record", and for this route it isn't.
- **Why Medium:** it's loud (the store disappears) and needs privilege. It is the one remaining way to erase the record.
- **Fix:** record the owner's acceptance, or add a store-delete refusal when approvals exist, or write deletions to a table outside the cascade. At minimum, correct the "durable record" wording under Known limits.

### Low

**L1. A brand admin can read a super_admin's email, confirming the spec's flag. [ran]**
`supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:53`; `src/lib/db.ts:2748`, `:2787`; `supabase/functions/delete-user/index.ts:344`. As Bob: the super_admin's profile is hidden, `get_profile_emails` returns 0 rows, yet `approved_by_email` and the `User deleted` row's `value` both show the address. It also travels to every privileged client through `select('*')` and the RPC return, though `mapOrderApproval` drops it. Reach is limited to stores the super_admin approved in or was linked to, and brand B's admin saw 0 of brand A's rows. Acceptable as flagged, leaving aside H2.

**L2. `User deleted` can't be forged exactly, but look-alikes get through. [ran]**
`supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:493-497`. The list is an exact match.
- Staff inserted `'User deleted '`, `'user deleted'`, `'USER DELETED'` and a no-break-space variant, with invented names and emails.
- An admin inserted `'User deleted '` naming Alice as actor. `audit_log_restrict_insert_actor_is_caller` exempts privileged callers.
- `formatAuditAction` (`src/utils/formatAuditAction.ts`) falls back to the lowercased string, so these render as `user deleted` beside the real `deleted user`.
- Applies to all five listed actions. An exact-match SQL query isn't fooled.
- Fix: compare a normalized value, or better, allowlist the actions clients may write.

**L3. The audit row can be avoided by removing store links first. [link deletes ran, the skip itself read]**
`supabase/functions/delete-user/index.ts:371-377`. An admin can delete a target's `user_stores` rows (ran), and a target can delete their own (ran). A target with no approvals then has an empty union, so per the code only a console line is written. This is by design for store-less targets, but the user story says "every user deletion". Targets with approvals still get rows.

**L4. A direct INSERT can still set most of what the guard protects. [ran]**
As Bob: `status='ordered'`, `channel='instacart'`, and backdated `approved_at`, `created_at`, `updated_at` and `ordered_at`, plus arbitrary `line_count` and `est_total_cost`. All stored. Spec line 107 says "A client can never supply `approved_at`", which is true only for UPDATE. The Out of scope section acknowledges `status`, `channel` and `approved_at`, but not the other columns. Approver and snapshot were correct on the row. Correct the wording.

**L5. A placeholder account can reach the snapshot through the API. [ran]**
`supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:74`. The security note says no client path promotes these accounts, which is true of the app's code. But a super_admin PATCH of `role='admin'` succeeds, and that account's approval then stored `u-...@no-email.invalid` in `approved_by_email`. Brand admins are refused (`role changes require super_admin`). Have the trigger and the guard blank the address, or correct the note.

**L6. The snapshot has no erasure path. [ran for the refusal]**
The guard refuses edits even as postgres (AC-4), and `order_approvals` isn't pruned. Removing a deleted person's email on request would mean disabling the trigger. This follows from the design, so the owner should know about it.

**L7. Spec corrections, and one note on orphan logins. [ran for the first, read for the second]**
- The API contract row "Caller with no profile row re-stamping: 23503" and its matching risk note don't match what I saw. A no-profile `admin` claim can't see the store at all, so the PATCH updates 0 rows, and by reading the RPC its store gate gives 42501. `auth_is_super_admin()` needs a profile, so a JWT-only super_admin isn't privileged in the database either.
- `delete-user` trusts `app_metadata.role` (`supabase/functions/delete-user/index.ts:52-53`), and nothing shows that metadata being cleared when the profile is deleted. After a partial failure on a super_admin target, the surviving login would still pass as super_admin here. I found no way for an API caller to force that failure: the only public FK to `auth.users` is the cascading one on `profiles`.

Older than this spec and left alone: `delete-user` returns raw `error.message` to its admin callers (`index.ts:119`, `:134`, `:481`, `:496`, `:533`, `:543`).

### Your questions, answered

**Erasing, forging, blanking or re-pointing, by route. All [ran] unless noted.**

| Route | Result |
|---|---|
| PATCH name, email, `approved_at`, or `approved_by` to NULL or someone else, at any status | P0001 `order approval is immutable` |
| Re-stamp to self once the row has left pending | P0001 |
| Staff or anon PATCH | 0 rows |
| Direct INSERT with a forged snapshot | Overwritten with real values |
| Direct INSERT naming someone else, or NULL | 42501 |
| Upsert: forged snapshot and `approved_at` on someone's pending row, as self | Becomes a normal re-stamp with real values and `now()` |
| Upsert naming the other admin as approver, with own lines | 42501, because INSERT WITH CHECK still applies |
| Upsert on an approved or ordered row | P0001 |
| Upsert by id onto another brand's row | 42501 (DO UPDATE); DO NOTHING changed nothing |
| Delete the auth user as `authenticated` | 42501 on `auth.users` |
| Re-key an approver's profile id | Refused by FK. In my probe the `audit_log` FK fired first; `order_approvals` has the same NO ACTION definition |
| **PATCH lines or status while leaving someone else's name** | **Allowed: H1** |
| **Rename, or change email, before approving** | **Allowed: M1** |
| **Delete the store** | **Allowed: M2** |

**M1's erase-and-return chain.** Closed through the API. Direct profile deletes remove 0 rows for same-brand, cross-brand and own-profile attempts, and `register_invited_profile` raises `profile already exists` while the profile lives. The only remaining version is the documented partial failure of `delete-user`. I simulated it by deleting the profile as postgres: Alice came back with the same id and role, `approved_by` stayed NULL with the snapshot intact, and she could not reclaim her frozen rows. She could re-stamp a pending row.

**Re-stamp.** Taking over while keeping Alice's lines is acceptable: Bob's name goes on lines he could read, and nothing has been ordered. The real problem is the opposite direction (H1). JWT mismatch is under H2.

**`pending -> approved` with no approver.** No other route found. Refused as admin, as `service_role` with no claims, as postgres, and in an upsert, including with new lines in the same PATCH. A direct INSERT must name the caller. `approved -> ordered` with NULL stays allowed by design, and `service_role` with a user's claims can re-stamp, but a real service token carries no `sub`.

**BEFORE INSERT email side channel.** None found. Naming someone else as approver gave the same bare 42501 in all four variants: a plain insert, a bad `channel`, an existing key, and a nonexistent uuid. There was no DETAIL, no row data and no existence oracle, because RLS is checked before constraints. Even for a caller's own row, a CHECK failure has no `Failing row` DETAIL, since Postgres redacts it under RLS. Not exercised over HTTP or for timing.

**Email exposure.** `L1`, and H2 for cross-brand. Staff and anon read 0 rows from `order_approvals` and 0 `User deleted` rows, and both are refused the RPC. From reading the code, the new console lines carry only static text, ids, the action and an error code or class name.

**`audit_log` policies.**
- `User deleted` is refused for staff, admin and super_admin, including in a multi-row insert and through an upsert, and UPDATE and DELETE of fresh rows change nothing.
- Staff can't read those rows.
- Both policies are still RESTRICTIVE in `pg_policy`, so there is no permissive-OR slip.
- `service_role` inserts work, including a backdated one.
- An admin can delete a `User deleted` row older than 90 days one at a time through `admin_delete_audit_log`, which matches the spec's known limit.
- Look-alikes are L2.

**Dropping `Admins can delete profiles`.**
- No DELETE or ALL policy remains on `profiles`.
- `src/` has no `profiles` delete call in my searches, so nothing legitimate breaks in this repo. The sibling apps' code wasn't available to check, though the old policy only ever worked for privileged callers.
- `hard_delete_brand` doesn't delete profiles. It refused anon, an admin, and a live brand. A brand cascade only sets `profiles.brand_id` to NULL.
- `demote_profile_to_user` updates the row, and `assert_not_last_of_role` and `assert_profile_self_delete_blocked` don't delete. No function in `public` contains `delete from profiles`.
- Service-role deletes exist only in `delete-user` and in `manage-store-user`'s compensation, which targets an id it just created (read).

**`delete-user` (all read).** The audit read at line 505 comes after the self (423), brand (444) and last-of-role (489) guards, so a refused request writes nothing and reads nothing extra. Placeholder addresses are blanked from `value` and placeholder-shaped names from `item_ref` (343-344), and the marked block passes the parity test. The audit helpers catch their own errors, and `user_id` falls back to NULL when the caller's profile is missing or the read failed. Response bodies are unchanged. No `verify_jwt` change: there is no `[functions.delete-user]` block, so it stays at the default of true, and it still checks the caller's role itself.

**SECURITY DEFINER posture. [ran]**

| Function | Definer | `search_path` | Owner | EXECUTE |
|---|---|---|---|---|
| `tg_order_approvals_stamp_approver` | yes | `public` | postgres | postgres, service_role |
| `tg_order_approvals_guard` | yes | `public` | postgres | postgres, service_role |
| `create_order_approval` | no | `public` | postgres | postgres, authenticated, service_role |

Every table read in the two definer functions is schema-qualified, `authenticated` has no CREATE on `public` or `auth`, and `vendor_order_channel` is INVOKER with a pinned path. Clean. The diffs against the previous guard and RPC show only the intended changes. Prod's values still need the post-apply check in the spec.

**`scripts/smoke-delete-user.sh` (read).** It refuses non-local URLs and doesn't print keys. No security finding. One hygiene note: if it exits before `PH_EMAIL` is set, its cleanup runs `email = ''` against `auth.users`. That matches 0 rows on the local stack today.

### Dependencies

`package.json` changed only in the `test:smoke` script, with no dependency changes. `npm audit` was skipped.

---

## Re-audit 2026-11-09

Auditor: security-auditor, 2026-11-09. This covers the "Backend design amendment (2026-11-09)" and "Amendment build (2026-11-09)" sections of the spec. The original audit above is left as it was. Local stack only; prod was not touched.

**Bottom line:** 187-H1 is closed. The in-spec part of 187-H2 is closed for pending rows. M1's id column survives every path I tried. Nothing in the amendment refuses an app flow. There are 0 Critical, 0 High, 1 Medium and 2 Low new findings. The Medium is about scope, not a regression: the new rule covers UPDATE only, so a stale admin claim can still *insert* a row that is already `approved` or `ordered`. That is wider than the owner-accepted remainder says.

### What I ran and what I only read

**Ran:**
- Three probe scripts on `supabase_db_imr-inventory`, each one transaction ending in `ROLLBACK`.
- Callers were simulated with `set_config('role','authenticated')` plus `request.jwt.claims`.
- All fixtures were created as postgres, including every `user_stores` row, so spec 195 landing mid-run couldn't break them. The `Users can manage own store links` policy was still present when I ran.
- Afterwards: 0 leftover approvals, auth users or helper functions.

Also ran:
- The live `prosrc` md5 of the guard, the stamp trigger and `create_order_approval`. All three match the file byte for byte, and match the references in the spec's table (`c89df6a4…`, `89ebf13f…`, `a544d68d…`). `prosecdef`, `proconfig` and `proacl` are as listed.
- Four pgTAP files, which roll back: `order_approvals_approver_snapshot` (68/68), `order_approvals_fk_set_null` (15/15), `order_approvals` (24/24) and `cross_store_item_rejection` (54/54).

**Read only:**
- the `delete-user` diff
- `instacart-cart-link`'s write path and role gate
- the app's write paths in `src/lib/db.ts` and `src/store/useStore.ts`

There was no real HTTP, no signed JWT and no GoTrue call. The upsert probes are hand-written SQL in the shape I expect from `Prefer: resolution=merge-duplicates`.

### 187-H1: closed [ran]

Bob (same-brand admin) on Alice's pending row:

| Bob's write | Result |
|---|---|
| Each listed column alone: `status`, `lines`, `line_count`, `est_total_cost`, `channel`, `external_ref`, `external_ref_expires_at`, `ordered_at` | P0001 `order approval belongs to another approver` |
| Several of them in one PATCH | Same refusal |
| A multi-row UPDATE covering his own pending row and Alice's | Whole statement refused. Neither row changed, so his own approve was not applied either |
| Blanket `external_ref` write across the store | Refused |
| Upsert `DO UPDATE SET line_count, status` | Refused |
| Upsert `DO UPDATE SET external_ref` | Refused |
| Upsert `DO UPDATE SET approved_by_id = excluded.approved_by_id` | `order approval is immutable` |
| No-op writes (`lines = lines`, `external_ref = external_ref`) | Pass. They only bump `updated_at`, which isn't an attribution field |

Alice's row read back unchanged, as `0a|0a|'R187 0a'|…|pending`.

**Remainder:** Bob can take a pending row over in his own name. One PATCH can set `approved_by = self`, any `est_total_cost` (I used 123456) and `status = 'approved'` together. The merge-duplicates upsert does the same with a forged snapshot, and the forged name, email, id and `approved_at` were all overwritten. Bob's name, email and id land on the row, so attribution is honest. This is the takeover the original audit called acceptable. It still skips the RPC's line validation and cost recompute, which is the old L4 class, already in Follow-ups ("Limit what a direct INSERT can set" should also say "or a re-stamping PATCH").

### 187-H2 (in-spec part): closed for pending rows [ran]

Every pending-row write by these callers was refused with `order approval caller is not an admin`. The rows read back unchanged.

| Caller (all with an `admin` JWT claim) | Refused writes |
|---|---|
| `D`: profile `user`, NULL brand, linked to a brand X store | PATCH re-stamp, PATCH lines, PATCH approve, merge-duplicates upsert |
| `ST`: profile `user`, brand X staff, store-linked | RPC re-stamp, lone `external_ref` |
| `D2`: profile `user`, NULL brand, linked to a brand **Y** store (the cross-brand shape) | Re-stamp, cost, approve and lone `external_ref` on brand Y's pending row |

`D`'s RPC call returned P0002 (vendor hidden by RLS), so it was refused before reaching the guard. `D` can't self-promote either: P0001 `role is read-only for self-edits`.

**The owner-accepted remainder, confirmed [ran]:**
- `D2` reads brand Y's `approved_by_email` and `approved_by_id`.
- `D2` inserts a pending row in its own true name. The stamp is honest.
- `D2` moves brand Y's approved row to `ordered`.
- `D` writes `external_ref` on Alice's approved row and moves it to `ordered`. Nothing records that `D` did this.

**Wider than stated:** see M-R1 and L-R2.

### M1 re-check [ran]

**`approved_by_id` survives every path:**

| Path | Result |
|---|---|
| INSERT trigger | Set |
| RPC new row | Set |
| RPC same-approver retry after a rename | id and name kept, `approved_at` kept |
| Re-stamp PATCH with a forged id and name | Overwritten with the real values |
| Upsert that copies `excluded.approved_by_id` | Refused |
| PATCH the id to someone else, or to NULL, on a pending or approved row | P0001 |
| Same PATCH as postgres on an ordered row | P0001 |
| Profile delete as postgres with Bob's claims | id kept on both the pending and the approved row |
| `auth.users` delete with a stale-claim user's claims | id kept |
| `eod_submissions` delete with staff claims (`source_submission_id` SET NULL) | Passes, and (a0) doesn't fire |

On an orphaned pending row, a direct approve is refused with `has no approver`. The RPC recovery then works, and replaces the id with the new approver's, as designed.

So a forged name can now always be traced to the account through `approved_by_id`, which also matches `detail.target_id`. The rename forgery itself still works. For example, F renamed himself to Alice's email address and that is stored as the name, but the id and email columns contradict it. The audit of privileged renames stays a follow-up.

**The blank-name fallback:** plain spaces fall back to the email, as designed. It can be sidestepped, but not to make the record anonymous (L-R1). `profiles.name` is NOT NULL, so a NULL name can't be reached through the API.

### Trying to break block (a0) [ran unless noted]

| Probe | Result |
|---|---|
| NULL `auth.uid()`: claims with an `admin` or `super_admin` role and no `sub` | 0 rows. RLS hides everything: `auth_can_see_brand` and `auth_is_super_admin` both read `profiles` by `auth.uid()` |
| `sub = ""` | 22P02 |
| No claims at all | 0 rows |
| (a0)'s NULL-uid skip in general | Reachable only by postgres and `service_role`, which bypass RLS and are trusted |
| Caller with no `profiles` row (`admin` claim) | PATCH 0 rows, RPC 42501, INSERT 42501. `user_stores.user_id` has an FK to `profiles`, so this caller can't self-link to a store. (a0)'s role check is only a backstop for them |
| super_admin | Can approve its own rows. Refused on someone else's row (`belongs to another approver`). RPC re-stamp works whatever role the claim carries, because privilege is read from the profile |
| master | RPC, then approve: ok |
| Lone `external_ref` or lone expiry on someone else's pending row | Refused |
| Multi-row UPDATEs | See H1 |
| `ON CONFLICT DO UPDATE` | See H1 and H2. Real PostgREST wasn't exercised, so the upsert results are [simulated] |
| FK SET NULL | See M1. Passes with an admin's claims and with a stale claim's |

**App flows.** All of these pass:
- Alice's RPC on a new row, then a retry
- the OQ-2 `channel = 'manual'` fallback
- the extension advance with `external_ref` and expiry
- the Instacart write-back shape (`external_ref`, expiry and `status = 'approved'` in one PATCH)
- another admin's re-mint on an approved row, and marking it ordered
- the R-6 replay on an ordered row
- the manual advance
- a re-mint with the no-op status on her own approved row
- the null-approver recovery through the RPC
- a master taking over and approving

`instacart-cart-link` writes back through the caller-token client (`supabase/functions/instacart-cart-link/index.ts:175-177`, `:674-681`), so (a0) applies to it [read]. `src/lib/db.ts` has no direct INSERT or upsert on `order_approvals`. The only insert is the RPC, which always inserts `pending` [read].

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

**M-R1. The pending-row rule doesn't cover INSERT, so a stale admin claim can create rows that are already approved or ordered. [ran]**

- **Where:** `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:84-110` (the stamp trigger has no caller check) and `:170-183` (the (a0) block, UPDATE only). The policy is `privileged_store_insert_order_approvals` (claim, store and `approved_by = auth.uid()` only).
- **What I ran:** as `D2`, a `user` profile with NULL brand, linked to a brand Y store and holding a stale `admin` claim, by direct INSERT:
  - `status = 'approved'`, `channel = 'instacart'` (the vendor resolves to `manual`), `line_count = 50`, `est_total_cost = 99999`
  - `status = 'approved'` with `approved_at`, `created_at` and `updated_at` all `2026-01-01`. All three were stored.
  - `status = 'ordered'` with `ordered_at = 2026-01-01`

  All succeeded. The same caller's UPDATE `pending -> approved` on its own row was refused, which is the AC-35b and AC-35e shape.
- **Why it matters:**
  - AC-35b and AC-35e suggest a stale claim can't approve. It can, by inserting the row already approved.
  - The accepted remainder (A1, "inserting new pending rows… pinned by AC-37") and the handoff summary ("insert a pending row") understate what is actually accepted.
  - Attribution is honest, because the stamp names the inserter, so this doesn't reopen H1.
  - It is also the INSERT-side bypass of (c2)'s channel escalation guard (original L4).
  - For the same-brand stale-staff shape (`ST`, with a legitimate store link), spec 195 doesn't close this. Only spec 191 might, if it handles stale roles.
  - Whether `instacart-cart-link` would then mint for `D2` was not run. Its gate trusts the `app_metadata.role` claim (`index.ts:183`), but `D2` can't read the brand Y vendor through RLS (0 rows, [ran]), so the vendor-context read probably stops it [read].
- **Fix:** in `tg_order_approvals_stamp_approver`, when `auth.uid()` isn't NULL:
  - require `new.status = 'pending'`
  - require the same `exists (... profiles.role in ('admin','master','super_admin'))` check as (a0)
  - preferably also force `channel := vendor_order_channel(new.vendor_id)` and server-set the timestamps

  No app path inserts directly, so nothing legitimate breaks [read]. Add pgTAP arms beside AC-37 (stale claim INSERT at `approved` and at `ordered` refused, admin INSERT at `approved` refused). AC-37a stays green, because a pending insert still passes the status rule. If the owner would rather not change code, at minimum correct A1's remainder and AC-37 to "insert at any status, with any channel and timestamps", and record that acceptance.

### Low

**L-R1. The blank-name test trims only ASCII spaces. [ran]**

- **Where:** `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:98` and `:197`.
- **What I ran:** a self-rename to a tab, U+00A0 (no-break space) or U+200B (zero-width space). Each was stored verbatim as `approved_by_name`. Four spaces fell back to the email correctly.
- **Impact:** the name can look blank in the UI. The row still carries the real email and id, so the record isn't anonymous, and this is a cosmetic gap in A2's "refusing a blank name". A self-rename to another person's email address is also stored, which is the known M1 rename remainder.
- **Fix:** test blankness after stripping whitespace and format characters. For example, `nullif(regexp_replace(v_name, '[[:space:]  -‍  ⁠﻿]+', '', 'g'), '')` as the condition, while still storing `btrim(v_name)`. Keep the two copies identical.

**L-R2. `ordered_at` can be rewritten on approved and ordered rows. [ran]**

- **Where:** `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:255-262` (block (c) doesn't freeze it) and `:315-316` (`coalesce` keeps a client value at the transition).
- **What I ran:**
  - `D`, with a stale claim, set `ordered_at = 2020-01-01` on Alice's approved row and then moved it to `ordered`. The backdated value stuck.
  - Bob rewrote `ordered_at` on an already-ordered row.
- **Context:** this is older than this spec (spec 149), and the amendment didn't widen it. A1 put `ordered_at` on the pending list, but nothing freezes it later. The accepted remainder covers moving a row to `ordered`, not choosing when it was ordered. The app never writes `ordered_at` (`src/store/useStore.ts:4482` sends only `status`) [read].
- **Fix:** in (e), set `ordered_at := now()` on the transition with no `coalesce`, and refuse any other change to `ordered_at`. Alternatively, record it as a follow-up next to L4.

**Info, not scored.** After the amendment, `instacart-cart-link` called by another admin on someone else's pending Instacart row still mints upstream before the write-back is refused (500 `writeback_failed`). A1 already describes this for the race case. It spends IDP calls but returns no link [read].

### Status of the original findings

| Finding | Status |
|---|---|
| H1 | Closed |
| H2 | In-spec part closed for pending rows. The rest is owner-accepted until specs 195 and 191, and is wider than written (M-R1) |
| M1 | Mitigated by `approved_by_id`. Forging by rename remains, and is now traceable |
| M2 (store delete erases approvals) | Unchanged. Not in the amendment |
| L1, L3, L6, L7 | Unchanged |
| L2 | Unchanged. In Follow-ups |
| L4 | Unchanged. M-R1 shows how it interacts with the new rule |
| L5 | Unchanged. A placeholder email now also becomes the name when the name is blank. Same exposure |

### `delete-user` verdict [read]

Behaviour-neutral and clean. `authDeleteThrew` and `authDeleteThrown` (`supabase/functions/delete-user/index.ts:518-536`) and the `DeleteAuditIds` / `DeleteAuditSnapshot` / `readDeleteAuditSnapshot` renames change no response, log content or I/O ordering. The self, brand and last-of-role refusals still run before the audit reads, and nothing new reaches a log or a response.

One corner case: a thrown `undefined` now reaches the outer catch, where `(e as Error).message` itself throws. The client then gets the runtime's default 500 rather than a JSON 500. That is still not the 200, which is what the fix intends.

### Dependencies

No dependency changes in the amendment. `npm audit` was skipped.

## Re-audit 2 (2026-11-09)

Auditor: security-auditor, 2026-11-09. This covers the "Re-proposal build (2026-11-09)" section of the spec: the two new INSERT refusals in `tg_order_approvals_stamp_approver()` (`supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:111-120`). Everything above is left as it was. Local stack only; prod was not touched.

**Bottom line:** M-R1 is closed. A stale `admin` claim can no longer insert a row at any status, and nobody with a JWT can insert a row that is already `approved` or `ordered`. Owner-level inserts and the app's RPC path work as before. H1, H2 and `approved_by_id` survival have not regressed. There are 0 Critical, 0 High, 0 Medium and 1 Low new findings, plus some notes that aren't scored. Still open, as already recorded: AC-37b (a stale claim can still move an approved row to `ordered`) and L4 for real admins (an admin's direct pending INSERT still sets channel, timestamps, counts and refs).

### What I ran and what I only read

**Ran:**
- Three probe scripts on `supabase_db_imr-inventory`, each one transaction ending in `ROLLBACK`. Fixtures were created as postgres: two brands, two stores, two vendors, and 8 people with `c187…` ids.
- Callers were simulated with `set local role` plus `request.jwt.claims`. No real HTTP, no signed JWT, no GoTrue. The upserts are hand-written SQL in PostgREST's shape, so they are [simulated] as PostgREST traffic and [ran] as SQL.
- The live raw `prosrc` md5 of the stamp trigger (`45f14d61…`), the guard (`c89df6a4…`) and `create_order_approval` (`a544d68d…`). All three match the bodies in the file, which I hashed myself, and match the spec's table. `prosecdef`, `proconfig` and `proacl` are as listed. The triggers on the table are `order_approvals_guard` (BEFORE UPDATE), `order_approvals_lines_check_store_trg` and `order_approvals_stamp_approver_trg` (BEFORE INSERT, in that order). No other BEFORE INSERT trigger could change `status` after the check.
- These pgTAP files, which roll back: `order_approvals_approver_snapshot` 76/76, `order_approvals` 24/24, `order_approvals_fk_set_null` 15/15, `cross_store_item_rejection` 54/54, `report_last_order_context` 42/42, `retention_prune_job` 70/70.
- Afterwards: 0 `order_approvals` rows, 0 leftover `_r2_*` / `_t187_*` functions, 0 leftover probe policies.

**Read only:** `src/lib/db.ts:2677-2730` (the app reads and PATCHes only, and never inserts directly); both `insert into public.order_approvals` sites (only `create_order_approval`, always `'pending'`); `instacart-cart-link` (`index.ts:175-192`, `:383-470`, `:674-681`, which only reads and updates); `scripts/smoke-delete-user.sh:189` (inserts as postgres with no claims); `scripts/smoke-instacart-cart-link.sh` (uses existing fixtures).

**Callers:**

| Tag | Shape | Claim |
|---|---|---|
| ST | `user` profile, brand X, linked to SX | `admin`, and `super_admin` for two probes |
| D | `user` profile, NULL brand, linked to SX | `admin` |
| D2 | `user` profile, NULL brand, linked to SY (brand Y, the cross-brand shape) | `admin` |
| A, B | brand X admins | `admin` |
| — | a master and a super_admin | their real role |

### M-R1: closed [ran]

Every probe by a stale-claim caller was refused, and no row was created. The table holds 0 rows whose `approved_by_id` is ST, D or D2.

| Probe | ST (same brand) | D (NULL brand, SX) | D2 (cross-brand, SY) |
|---|---|---|---|
| INSERT `pending` | not an admin | not an admin | not an admin |
| INSERT `approved` | must be pending | must be pending | must be pending (sent with `instacart`, `line_count` 50, `est_total_cost` 99999) |
| INSERT `ordered`, backdated `ordered_at` | must be pending | must be pending | must be pending |
| `approved` with `approved_at`, `created_at` and `updated_at` all `2026-01-01` | — | — | must be pending |
| `pending` with the same backdated timestamps | not an admin | — | — |
| `pending` with `channel = 'instacart'` | not an admin | — | not an admin |
| `status` left out (the column default `pending` applies) | not an admin | — | — |
| `ON CONFLICT DO UPDATE SET approved_by = excluded.approved_by, status = 'approved'` onto a colleague's pending row | not an admin | — | not an admin (onto Y's admin's row) |
| `ON CONFLICT DO NOTHING` at `approved` | must be pending | — | — |
| `ON CONFLICT DO UPDATE SET status = 'ordered'` onto an approved row | not an admin | — | — |
| merge-duplicates shape (`DO UPDATE SET status = excluded.status`), new key, `approved` | must be pending | — | — |
| Multi-row `VALUES` (pending, pending) and (pending, approved) or (pending, ordered) | not an admin, whole statement | — | not an admin, whole statement |
| `INSERT … SELECT` copying an approved row | must be pending | — | must be pending |
| `INSERT … SELECT` over `generate_series`, pending | not an admin | — | — |
| Writable CTE (`WITH i AS (INSERT … 'approved' RETURNING id)`) | must be pending | — | — |
| `create_order_approval`, new key | not an admin | — | — |
| `create_order_approval` race branch (hide-once policy), onto a pending row and onto an approved row | not an admin (\*) | — | — |
| `super_admin` claim, INSERT `pending` / `ordered` | not an admin / must be pending | — | — |

"not an admin" is P0001 `order approval caller is not an admin`. "must be pending" is P0001 `order approval must be inserted as pending`.

(\*) The race marker reads as not consumed after these two calls. That comes from the probe, not the fix: `_r2_try`'s exception block rolls back the `set_config` that consumed it. Without the race policy, a non-race call by ST onto an approved row returns the row with no write (R-6), and one onto a pending row is refused by the guard's (a0). So the stale caller is refused on every branch, and the R-6 read-back still works.

**How the BEFORE INSERT trigger interacts with `ON CONFLICT` [ran]:** the trigger fires on the proposed row before conflict arbitration. So every upsert by a stale caller is refused before the `DO UPDATE` arm runs, whatever that arm would do. For a real admin, `excluded.*` carries the stamped values: `DO UPDATE SET approved_by_id = excluded.approved_by_id` with a forged id in the VALUES list wrote A's real id back onto A's own approved row, so nothing changed. Forging through `excluded` doesn't work.

**Real admin (A):**
- INSERT at `approved` or `ordered`: must be pending.
- An explicit `status = NULL`: must be pending (refused before the NOT NULL constraint).
- The same refusal for a multi-row (pending, approved), an `INSERT … SELECT` copying an approved row, a writable CTE at `ordered`, and an `approved` row naming B.
- Pending INSERT, multi-row pending (2 rows), `INSERT … SELECT` pending (3 rows) and `status` left out: ok, and the stamp is A's.
- A pending INSERT naming B, and one into brand Y's store: still 42501 (AC-2c and RLS unchanged).
- A super_admin: direct pending INSERT ok, `approved` refused.

**Other callers [ran]:**
- `anon` inserting `ordered` with A as approver: 42501.
- `authenticated` with a `super_admin` claim and no `sub`: 42501, whether naming A or NULL. With a NULL `auth.uid()` the new checks are skipped, but RLS still refuses: `auth_can_see_store` reads `profiles` and `user_stores` by `auth.uid()`, and `approved_by = auth.uid()` is NULL.
- Plain staff (claim `user`): P0001 instead of the old 42501, because BEFORE triggers run before `WITH CHECK`. See Notes.

**What's left of the M-R1 surface:**
- **AC-37b, still open, owner-accepted [ran].** D2 moved brand Y's approved row to `ordered` (`ok:1`). That is UPDATE only, unchanged, and waits on the `auth_is_admin()` / `auth_is_privileged()` convergence spec, as recorded.
- **L4 for real admins, still open, recorded [ran].** A real admin's direct pending INSERT stored `approved_at`, `created_at`, `updated_at` and `ordered_at` all `2026-01-01`, `line_count` 50, `est_total_cost` 99999 and `external_ref = 'https://evil.test/planted'`. A separate pending INSERT with `channel = 'instacart'` on a vendor that resolves to `manual` was stored, and A could then approve it (`ok:1`). Both rows carry A's honest stamp, so attribution holds. `instacart-cart-link` refuses a vendor with a blank retailer key (AC-16), so that instacart row can't be minted against a manual vendor with no key [read]. This is the "Limiting what a direct INSERT can set" follow-up, now limited to privileged callers. See L-R3 for the columns missing from that list.

### Owner-level inserts still work [ran]

| Caller | Insert | Result |
|---|---|---|
| postgres, no claims | `approved` and `ordered` naming A | ok, with A's snapshot |
| `service_role`, no claims | `approved` and `ordered` naming A | ok, with A's snapshot |
| `service_role`, claims `{"role":"service_role"}` with no `sub` | `ordered`, NULL approver | ok, NULL snapshot |
| `service_role` with A's `sub` | `approved` | must be pending |
| postgres with A's `sub` | `approved` | must be pending |

The last two are expected (`v_uid` is not NULL). No current path inserts that way: there are no SECURITY DEFINER inserters, edge functions only read and update, and the smokes insert as postgres with no claims [read]. See Notes.

### App RPC path unaffected [ran]

All of these returned `ok:1`, with the stamp and lines as designed:

| Step | Read-back |
|---|---|
| A, new row | pending, A |
| A, retry | `approved_at` kept |
| A on an approved row and on an ordered row (R-6) | returned, no write |
| B on A's pending row (re-stamp) | B, `approved_at` now |
| B approves with `external_ref` and expiry, then marks it ordered | `ordered_at` set |
| B through the race branch onto A's pending row | marker consumed, row B's |
| B through the race branch onto A's approved row | marker consumed, row still A's, R-6 |
| A master: RPC new row, then approve | approved, b0 |
| A super_admin with NULL brand: RPC new row, then approve | approved, c0 |

The RPC inserts only `'pending'` as an admin. So the new checks pass and the race branch still gets its 23505.

### Regression spot-checks [ran]

- **H1:** B's PATCH of `line_count`, of `status = 'approved'` and of `external_ref` on A's pending row each got `order approval belongs to another approver`.
- **H2:** each of these got `order approval caller is not an admin`:
  - D's PATCH approve and PATCH re-stamp on A's pending row
  - D2's PATCH re-stamp and lone `external_ref` on brand Y's pending row
  - ST's RPC re-stamp on A's pending row
- **`approved_by_id` survival:**
  - Deleting A's profile as postgres left all 19 of A's rows with `approved_by` NULL and the id, name and email intact. That covers pending, approved and ordered rows, rows from fixtures, A's direct INSERTs, the upsert-approved row, and the postgres and `service_role` owner-level rows.
  - Deleting B's `auth.users` row with ST's stale claims set did the same for B's two rows (the re-stamped day 80 row, now ordered, and the race-branch row).

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

**L-R3. The "what a direct INSERT can still set" list is missing `external_ref`, `external_ref_expires_at` and `source_submission_id`. [ran] for the first two, [read] for the third.**

- **Where:** `specs/187-order-approval-approver-snapshot.md:113` and `:230` (the L4 column lists), and the migration comment at `supabase/migrations/20261108130000_order_approval_approver_snapshot.sql:98-99`.
- **What I ran:** a real admin's direct pending INSERT stored `external_ref = 'https://evil.test/planted'`. Expiry is the same column class.
- **Impact:** no new capability. The same admin can already PATCH `external_ref` on their own pending row, and the row is stamped with their name. But `instacart-cart-link` returns a live, unexpired `external_ref` as the Instacart link without minting (`reused: true`, `index.ts:410-428`) [read]. So a planted URL on an instacart-channel row reaches every admin who opens it. `source_submission_id` is the L6 class.
- **Fix:** add the three columns to the two spec lists and to the migration comment, so the follow-up's scope is complete. When the follow-up is built, it should null or server-set `external_ref` and its expiry on INSERT. Comment and spec only, so it doesn't block.

**Notes, not scored:**
- **Error code for non-privileged INSERTs.** A plain staff INSERT now returns P0001 (HTTP 400, `order approval caller is not an admin`, or `must be inserted as pending` at a non-pending status) instead of 42501 (HTTP 403). The trigger reads only the caller's own `profiles` row before refusing, so no other row's data leaks. The message only states the rule. No test pins 42501 for that shape: the six files above pass.
- **Trusted roles carrying a user's `sub`.** postgres or `service_role` with a user's `sub` is now subject to the INSERT rule. That's correct as written, but a future SECURITY DEFINER RPC, or an edge function using a service-role client with the user's `Authorization` header forwarded, can't insert a non-pending row. Worth one sentence in the stamp's comment, which currently says only "postgres and service_role with no claims skip them" (`:96-97`).
- **Real-admin upserts carrying a non-pending status.**
  - A real admin's merge-duplicates upsert that carries `status = 'approved'` onto their own pending row is now refused. The same change as a PATCH, or as `DO UPDATE SET status = 'approved'` with a pending VALUES row, passes.
  - `ON CONFLICT DO NOTHING` at a non-pending status is now an error, not a silent no-op.
  - No app path does either [read].

### Status of earlier findings

| Finding | Status |
|---|---|
| M-R1 | **Closed** [ran] |
| AC-37b (stale claim `approved -> ordered`) | Open, owner-accepted, unchanged [ran] |
| H1 | Closed, no regression [ran] |
| H2 (in-spec part) | Closed for pending rows and for INSERT, no regression [ran] |
| M1 | Mitigated by `approved_by_id`, survival re-confirmed [ran] |
| L4 | Narrowed to privileged callers. `status` is closed for API callers. The rest stands, and its list needs L-R3's three columns |
| L-R1, L-R2 | Unchanged, recorded in the spec's Known limits and Follow-ups [read]. A planted `ordered_at` on a pending INSERT still survives the move to `ordered` (L-R2) |
| M2, L1, L2, L3, L5, L6, L7 | Unchanged. Not touched by this build |

### Dependencies

No `package.json` change in this build. `npm audit` was skipped.
