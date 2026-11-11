# Security audit for spec 198 (invitations hardening)

Auditor: security-auditor, 2026-11-10. Spec status at review: READY_FOR_REVIEW.

Tags: **[ran]** = I executed it. **[read]** = from source or catalog reading only. **[simulated]** = sign-up simulated by a SQL-created `auth.users` row plus `request.jwt.claims`, not real GoTrue.

**How I probed:**
- Three probe scripts against `supabase_db_imr-inventory`. Each ran as a single `begin; ... rollback;` under psql `ON_ERROR_ROLLBACK`.
- One two-session lock test on the seed row `1111`. Both sessions ended in `rollback`.
- Read-only or refused PostgREST HTTP calls, as anon and with a locally signed HS256 JWT for seed admin `1111`. No login, no account created, no write admitted.
- No `db reset`, no prod access, no `smoke-edge-roles.sh`, no committed data.
- Re-ran `supabase/tests/invitations_hardening.test.sql`: 88/88, rolled back [ran]. `jest` `inviteLink` + `sendInviteEmail.source`: 23/23 [ran].

## Verdict

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 0 |
| Low | 4 |

- The headline probes now fail as intended: 195-H1, the direct 191-M1 replay, 164-M1, cross-brand creation and the grants.
- **One High:** a consumed invitation can be revived by an in-scope admin, so the "one-time" code works again. That re-opens 191-M1 through the inviter re-check (D3), which this spec exists to close.

---

### Critical (BLOCKS merge)

None.

---

### High (must fix before deploy)

**H1. An in-scope admin can revive a used invitation. The old code then claims again. A demoted admin can use this to return as a durable brand admin, which bypasses D-2/D3 (191-M1). [ran, signUp simulated]**

- **Where:**
  - The provenance trigger freezes only `invited_by` and `code_hash` on client UPDATE: `supabase/migrations/20261110120000_invitations_hardening.sql:186-189`.
  - The UPDATE policy admits used rows and lets `used`, `email`, `profile_id`, `role` and `expires_at` change: `:315-356`.
  - The claim's single-use check is just `v_inv.used`: `:420-426`.
  - R7 re-checks `invited_by`, the *original* inviter, not whoever revived the row: `:450-460`.
  - The nightly prune deletes only `used = false` rows (`20261108120000_*.sql:51`), so consumed rows persist indefinitely.
- **What I ran (probe C, one rolled-back transaction):**
  1. Master `3333` calls `create_invitation('x-admin@…', role admin, brand A)`. X claims with the code and becomes `admin`, brand A.
  2. X, still admin, runs `update invitations set used=false, email='x-burner@…', profile_id=<sentinel>, expires_at=now()+7d where email='x-admin@…'`. Result: **`UPDATE 1`**. The row now reads `used=false`, `invited_by=3333`.
  3. The super_admin demotes X through `demote_profile_to_user`. X becomes `user`.
  4. `delete-user`'s cleanup predicate (`profile_id = X`, `supabase/functions/delete-user/index.ts:513`) matches **0 rows**, so it would not catch this either.
  5. A fresh account `x-burner@…` (simulated open sign-up) runs `check_invitation_code`, which returns **1 row**. It then runs `register_invited_profile(<X's original code>)`, which **succeeds**. The new profile is `admin`, brand A, with `raw_app_meta_data.role = 'admin'` synced.
  6. In probe B (P8), a second variant: admin `1111` revived a used staff invitation, re-pointed the email and set `role='admin'`. A second account claimed it as `admin` with the old code.
- **Why it matters:**
  - D-2 and AC D3 exist to make "a demotion ends the ability to mint admins" true. The direct 191-M1 replay is closed: my P4 run, and the spec's D3-b arm, both refuse it.
  - This route reaches the same end state. The demoted insider only needs a code they legitimately held: the link from their own invitation. Because `invited_by` points at their still-privileged inviter, R7 passes.
  - It also breaks the "It works once" promise in the UI copy (`InviteLinkPanel.tsx:119`) and the B3 "used invitation refuses" guarantee. Both hold only while `used` stays true, and any in-scope admin can flip it back.
- **Why High and not Critical:**
  - It needs a then-privileged insider.
  - It is same-brand only: SCOPE plus R7's brand comparison pin it to the original inviter's brand.
  - It expires at most 7 days after the insider's last pre-demotion UPDATE.
  - Exposure starts only for admins and masters invited after 198 ships. Legacy rows have a NULL `code_hash`, and the trigger stops a client from setting one.
  - It defeats a control this spec claims to deliver, so it must be fixed before deploy.
- **Fix (small; either option works):**
  - **(a) Preferred: drop the client UPDATE policy, or make it super_admin-only.**
    - No app path issues a client UPDATE on `invitations`. I grepped `src/`, `e2e/` and `supabase/functions/`: only selects, the service-role delete in `delete-user`, and `create_invitation`'s delete-then-insert.
    - Re-invite (B8) already covers "change this invitation" and rotates the code.
    - The A8/K-a "exactly 1 permissive UPDATE policy" pins and the DO block at `:679-689` would move from 1/1/1/1 to 1/1/0/1.
  - **(b) Keep UPDATE and narrow it:**
    - Add `invitations.used = false` to UPDATE USING and WITH CHECK.
    - In the trigger's UPDATE branch, also freeze `used`, `profile_id` and `email` for `authenticated`/`anon`. Only the DEFINER claim (postgres) may set `used = true`.
    - Optionally freeze `role`, so a code already delivered can't be silently upgraded. Re-invite is the supported path.
  - **Either way, add pgTAP arms:**
    - an in-scope admin's `update … set used=false` on a consumed row affects 0 rows, or leaves `used` true
    - the consumed code still refuses afterwards
    - the probe-C sequence refuses at the claim

---

### Medium

None.

---

### Low

**L1. The invite code travels in the URL query string, so it reaches Vercel request logs and browser history. It stays in the address bar if the browser is already signed in. [read]**
- **Where:** link shape `?register=true&invite=<code>` (`supabase/functions/send-invite-email/index.ts:81`, `src/lib/inviteLink.ts:44-46`). Only `LoginScreen.tsx:57-65` strips it, with `replaceState`.
- **The leaks:**
  - The first GET (path plus query) is logged by Vercel.
  - The browser records the pre-`replaceState` URL in its global history.
  - When a session already exists (for example, an admin test-opening the link), RoleRouter never mounts LoginScreen, so the query stays put.
  - Resend also keeps the rendered HTML, and click tracking, if enabled, routes the link through Resend.
- **What limits it:**
  - It is not a Referer leak: there is no cross-origin load on the page, and browsers default to `strict-origin-when-cross-origin`.
  - It is not a route-param round trip: React Navigation `linking` is intentionally off (`src/navigation/RoleRouter.tsx:20-25`).
  - A code is useless without the matching email.
  - Opening the link doesn't consume the code, so mail-scanner prefetches are harmless.
- **Fix (optional):** carry the code in the fragment (`/#register=true&invite=…`). Fragments are never sent to the server. `recoveryUrl.ts` only reacts to `token_hash`, `code` and `access_token`, so `invite` in the hash is safe there; re-check supabase-js `detectSessionInUrl` if you do this. Also strip the query on boot regardless of auth state.

**L2. The trigger function `assert_invitation_provenance()` keeps a PUBLIC/anon/authenticated EXECUTE ACL. [ran]**
- `proacl` = `{=X/postgres, …, anon=X, authenticated=X, …}` (P7c).
- It is inert:
  - a direct call raises "trigger functions can only be called as triggers" (P7a)
  - PostgREST returns PGRST202 because it doesn't expose functions that return a trigger [ran HTTP]
- Hygiene only: `revoke all … from public, anon, authenticated` would make the "no PUBLIC entry" sweep in the spec's step 5 uniform.

**L3. In-scope admins can read `code_hash`, and the dead `resendInvite` selects `*`. [ran]**
- `1111` reads `code_hash` on brand-A rows (P3k).
- `src/lib/auth.ts:546-553` `resendInvite` (no callers) selects `*`, which would now include `code_hash`.
- The value is a SHA-256 of a uniform 128-bit secret: not invertible, not accepted by the claim (P1l: passing the hash as the code refuses), and not re-plantable (P3n: the unique index rejects a duplicate).
- **Optional:** a column-level `revoke select (code_hash) on public.invitations from authenticated`. That would make `select('*')` callers fail loudly, which today means only the dead `resendInvite`.

**L4. `send-invite-email` doesn't bind `inviteCode` to an invitation or the recipient. [read]**
- Any caller who passes `requireAdminCaller` can send app-branded mail with any well-formed code to any address. That includes a stale-JWT demoted admin, because the gate reads `app_metadata.role` first (`index.ts:30-31`), as already noted in spec §4.
- What limits it:
  - the host is the fixed `APP_URL` (`:8`)
  - the code is pinned to `^[0-9a-f]{32}$` (`:74`), so there is no open redirect and no URL or HTML injection
  - every HTML interpolation goes through `escapeHtml` (`:98`: `name`, `role`, `storeNames`, `inviteUrl` twice, `expiresText`), and the source probe asserts this [ran jest]
  - an arbitrary code is inert at claim
- This is the pre-existing "admins can send invite mail to anyone" surface, so no change is required. A future hardening could take an `invitation_id` and have the function check it against a caller-visible row.

---

### Probe results: what the spec asked me to try to break

| Attempt | Result | Tag |
|---|---|---|
| **195-H1 re-run:** brand-A admin `1111` SELECT/DELETE of brand-B rows (admin `brand_id=B`; staff brand NULL + store B1) | SELECT 0, total visible 0, DELETE 0 (P1a-c) | [ran] |
| Stale claim (`2222` profile `user`, JWT admin): SELECT/DELETE/`create_invitation` | 0 / 0 / `42501 forbidden` (P1d-f) | [ran] |
| Squat a brand-B invitation without the code: zero-arg `register_invited_profile()`, `get_pending_invitation`, NULL code, wrong code, another invitation's code, the hash as the code, `consume_invitation` | function does not exist ×2; `no pending invitation` ×4; `permission denied` (P1g-m) | [ran, simulated] |
| Positive control (right code, case and space variant) | succeeds → admin brand B, JWT role synced (P1n/p), so the refusals above are meaningful | [ran, simulated] |
| Claim twice: same account; another account with the used code; another account with someone else's code | `profile already exists`; `no pending invitation` ×2 (P1o, q, r). **But see H1 (revival).** | [ran] |
| Existence oracle via `check_invitation_code` | right email + wrong code, unknown email, used, right code + wrong email, NULL, empty → all 0 rows; right pair → 1 row with `name` only (P2a-f). The claim gives one refusal string for every code, email, expiry and inviter failure. | [ran] |
| Read `code_hash` | anon 0 rows (HTTP); in-scope admin yes (L3) | [ran] |
| Forge `invited_by` on INSERT / UPDATE; null `code_hash` on UPDATE | overwritten to `1111`; frozen; frozen (P3d, g, w) | [ran] |
| `expires_at` NULL / 2099 / +8d on INSERT and UPDATE | `42501` each (P3b, c, e, f) | [ran] |
| Insert without `code_hash` (old-bundle shape) | `42501` (P3a) | [ran] |
| Cross-brand creation as admin: `create_invitation` with brand B, store B1 (also upper-case), brand A + store B1; direct `role='master'`; UPDATE brand/stores/role across scope | `42501` (RLS) or `invalid role` / `admin invitation requires a brand` (P3h-t) | [ran] |
| Brand-less store-less (D-7) | the inviter sees it; a second brand-A admin sees 0 and deletes 0; a brand-B admin sees 0 (P6a-d) | [ran] |
| Re-invite across brands | `1111` re-inviting an email that has a brand-B pending row leaves that row in place (P3v/x) | [ran] |
| Plaintext code stored anywhere | 0 columns match a 32-hex value (P3y) | [ran] |
| **191-M1 direct replay** (DEMOTEE plants an admin invite, the super_admin demotes, then a claim) | the demoted DEMOTEE can't see, extend or create invitations; pre-check 0; claim `no pending invitation` (P4a-h). The row stays pending, which is inert and expected under D-2. | [ran, simulated] |
| Inviter deleted / inviter moved to brand B | `no pending invitation`; pre-check 0 (P4j, P5a/b) | [ran, simulated] |
| Claim racing demotion | `FOR SHARE` (claim R7) vs `FOR NO KEY UPDATE` (the demote RPC's lock, confirmed in `prosrc`): session B timed out "while locking tuple" while A held `FOR SHARE` on `1111`. The READ COMMITTED re-read after a committed demotion is standard EvalPlanQual behaviour. | [ran] lock conflict; [read] post-commit re-read |
| AD-4 brand stamp | `1111`'s zero-store staff invite is stored with `brand_id = A`; the claim gives a `user`, brand A, 0 links. This is a reduction versus NULL brand: `user_stores_brand_match()` lets a NULL-brand user's first link be any brand, while brand A pins links to A. A super_admin's zero-store invite stays brand-less. Secure as designed. | [ran] |
| Grants | `get_pending_invitation` and zero-arg `register_invited_profile` are dropped (anon and authenticated PostgREST → PGRST202). anon: `check_invitation_code` yes; `register_invited_profile(text)`, `create_invitation`, `assert_not_last_of_role`, `consume_invitation` → HTTP 401 / 42501. `consume_invitation` is gone from authenticated. No PUBLIC entry except the inert trigger function (L2). | [ran] |
| SECURITY DEFINER posture | `register_invited_profile(text)` and `check_invitation_code` are DEFINER, owner postgres, `search_path=public`, with every relation schema-qualified (`public.*`, `auth.users`). Unqualified calls are pg_catalog builtins, and function lookup never searches `pg_temp`. anon and authenticated have no CREATE on `public` or `extensions`. `create_invitation` and the trigger are INVOKER. The DEFINER `public` profiles-writer set is exactly `{register_invited_profile(text), demote_profile_to_user(uuid)}`. | [ran] |
| Old bundle | old register → PGRST202 before `signUp` (no orphan); old zero-arg claim → PGRST202; old direct insert → 42501 (loud). This matches spec §11. | [ran] |
| Link / email | no open redirect (fixed `APP_URL`, hex-only code); `escapeHtml` on every HTML interpolation; `to:` and subject aren't HTML; the code isn't logged by the client, `callEdgeFunction` or the edge function; supabase-js `rpc` sends the code in a POST body, not the URL. URL exposure: L1. | [read] + [ran jest] |

### Accepted residuals (from the spec, not counted)

- **Email squatting DoS** (spec §12). With open sign-up and no confirmation (`supabase/config.toml:227,232`), anyone who knows an invitee's email can register it first. They can't claim without the code, but the real invitee is blocked. The fix is the "disable open sign-up + server-side claim" follow-up.
- **`requireAdminCaller` trusts a stale `app_metadata.role`** (spec §4, "Known, out of scope"). Codes minted or mailed that way are inert under R7.
- **The rollback** (`specs/198-invitations-hardening/rollback.sql`) re-opens 195-H1, 164-M1 and 191-M1 by design. It is emergency-only, as documented.

### Dependencies

`package.json` differs from HEAD only in the `test:smoke` script line (adds `smoke-delete-user.sh`), and `package-lock.json` is unchanged. Spec 198 changes no dependencies.

`npm audit --audit-level=high` [ran] reports a pre-existing baseline of 46 vulnerabilities: 1 critical (`shell-quote`, transitive), 17 high (including `@react-navigation/*`, `ws`, `node-forge`, `dompurify`, `form-data`), 19 moderate, 9 low. None was introduced by this spec, and none is in the invitation path.

---

## Re-audit (2026-11-10)

Scope: the backend-developer's "Review fix pass" (spec §"Review fix pass", 2026-11-10). Re-ran probe C and its variants, plus the four follow-up checks the dispatcher asked for.

**How I probed:**
- One probe script, `begin; ... rollback;` under psql `ON_ERROR_ROLLBACK`, on `supabase_db_imr-inventory`. Synthetic fixtures (super_admin, brand-B admin, X, burners, a disposable admin) plus seed `1111` (admin, brand A), `2222` (profile `user`), `3333` (master, brand A). Every UPDATE/upsert variant ran inside its own subtransaction and was undone; a post-matrix snapshot compare confirmed both target rows were byte-identical afterwards.
- One mutation run for D-11 (drop only the super_admin leaf from the UPDATE policy, then run `profiles_insert_hardening.test.sql`), inside a transaction the test file's own `rollback;` undid. The live UPDATE policy md5s were re-checked afterwards and still equal `bfe1da65…` / `8dc14413…`.
- No `db reset`, no prod, no real accounts, no HTTP writes. Sign-ups are simulated (SQL-created `auth.users` rows plus `request.jwt.claims`).
- Live catalog matches the spec's updated md5 table: policy md5s, the four function `prosrc` md5s (I hashed the file's `$$` bodies independently: all four equal live), and `assert_invitation_provenance()` ACL = `{postgres, service_role}` [ran].

### Re-audit verdict

| Severity | Before | After |
|---|---|---|
| Critical | 0 | 0 |
| High | 1 (H1) | **0: H1 closed** |
| Medium | 0 | 0 |
| Low | 4 | 4 open: L1 (owner: follow-up), L3 (owner: deferred), L4 (owner: no change), **new L5**. L2 is closed. |

Nothing in this pass blocks. From a security standpoint 198 can advance. The release-coordinator still owns the CI-gate and prod-apply checks: 198 is not on prod or `main`.

### H1: closed [ran, signUp simulated]

The UPDATE policy (`supabase/migrations/20261110120000_invitations_hardening.sql:331-376`) now carries `public.auth_is_super_admin() and invitations.used = false` in both USING and WITH CHECK. `auth_is_super_admin()` is profiles-backed (`role = 'super_admin'` for `auth.uid()`, SECURITY DEFINER), so a JWT claim cannot satisfy it.

**UPDATE matrix.** Every caller ran 17 statements against U (consumed admin invitation, invited by `3333`) and the same 17 against P (unused staff invitation, invited by `1111`). The statements set `used=false`, `used=true`, `email`, `profile_id`, `role` (to admin, user and master), `expires_at` (+2d, NULL and +8d), `store_ids` (an A store and a B store), `brand_id`, `name`, the combined probe-C revival, `invited_by` and `code_hash=null`.

| Caller | U (used) | P (unused) |
|---|---|---|
| admin `1111` (JWT admin) | 0 rows ×17 | 0 rows ×17 |
| master `3333` | 0 rows ×17 | 0 rows ×17 |
| stale `2222` (profile `user`, JWT admin) | 0 rows ×17 | 0 rows ×17 |
| stale `2222` (profile `user`, **JWT super_admin**) | 0 rows ×17 | 0 rows ×17 |
| admin `1111` with a forged **JWT super_admin** | 0 rows ×17 | 0 rows ×17 |
| real super_admin | **0 rows ×17** | 13 admitted, 4 refused (see below) |

**Upserts** (`INSERT … ON CONFLICT … DO UPDATE`, the PostgREST `upsert` shape):

| Variant | admin / master | stale (JWT super_admin) | super_admin |
|---|---|---|---|
| `on conflict (id)` revive U | 42501 (USING) | 42501 | **42501 (USING)** |
| `on conflict (code_hash) where code_hash is not null` revive U with its own hash | 42501 (USING) | 42501 | **42501 (USING)** |
| `on conflict (id)` on P, re-point email and set `role='admin'` | 42501 (USING) | 42501 | rows=1 (same as plain UPDATE) |
| `on conflict (id)` on P, `set used = true` | 42501 | 42501 | 42501 (WITH CHECK) |
| `on conflict (id) do nothing` on U | rows=0 | 42501 (INSERT check) | rows=0 |

The upserts fail loudly rather than silently, because Postgres raises on an ON CONFLICT DO UPDATE whose target row fails UPDATE USING. U and P were unchanged after the upsert block.

**Probe C, end to end:**
1. Master `3333` runs `create_invitation(X, admin, brand A)`, and X claims as admin, brand A.
2. X's revival UPDATE (`used=false`, `email=burner`, `profile_id=sentinel`, `expires_at=+7d`) → **0 rows**.
3. **New variant, delete and re-plant:** X can still DELETE its own consumed row, because the pre-existing DELETE scope admits used rows. X then re-INSERTs a row carrying its original code's hash, the burner email and a forged `invited_by = 3333`. The provenance trigger stamps `invited_by = X`.
4. The super_admin demotes X. The burner's pre-check returns 0 rows, the burner's claim fails with `no pending invitation`, and no profile is created.

So the delete-and-re-plant route lands on R7, which checks X, who is now demoted. That is the D-2 design working as intended.

**H1 verdict:** closed. No client role, including a real super_admin, can bring back a consumed row through UPDATE or upsert. Delete-and-re-insert re-stamps provenance to the caller, so R7 refuses after a demotion. The claim (DEFINER, owner postgres) is the only path that sets `used = true`.

### What a super_admin can still do on an unused row [ran]

**Admitted** (rows=1):
- `used = false` (a no-op)
- `email`
- `profile_id`, set to any value
- `role` user↔admin
- `expires_at`, if within `now()+7d`
- `store_ids`, including another brand's store
- `brand_id`, to any brand
- `name`
- the combined statement

`invited_by` and `code_hash` are silently frozen by the trigger (rows=1, values unchanged).

**Refused** (42501):
- `used = true`
- `role = 'master'`
- `expires_at` NULL or +8d

**Is any of this a concern?** Only a minor one, recorded as L5 below. The super_admin is the top of the trust model and can mint any invitation through `create_invitation` anyway. It cannot learn a plaintext code, because only the hash is stored, so re-pointing the email on someone else's invitation makes that code unusable unless the original code holder also controls the new address. A brand or store change on another inviter's row is pinned by R7: when the inviter is an admin or master whose brand no longer matches, the result is `no pending invitation`. An arbitrary `profile_id` only means `delete-user`'s cleanup (`profile_id = <user>`) may later delete that pending row, which is harmless.

### New Low

**L5. A super_admin edit to another inviter's pending row keeps the original `invited_by`, so the code is re-checked against the original inviter (not the editor), and `role`/`email` are not frozen. [ran]**
- **Where:** the trigger's UPDATE branch freezes only `invited_by` and `code_hash` (`20261110120000_invitations_hardening.sql:188-193`). The UPDATE policy admits `role` and `email` changes for the super_admin (`:331-376`).
- **Effect:**
  - A super_admin can upgrade an already-delivered staff code to `admin`, or move it to a different address, while `invited_by` still names, say, admin `1111`.
  - R7/D3 then evaluates `1111`'s standing, not the super_admin's.
  - The audit trail misattributes the edit.
  - If that super_admin is later demoted, codes they edited survive. They are bounded by the 7-day `expires_at` cap, and the original inviter must still be privileged in-brand.
- **Why Low:**
  - Only a currently-profiled super_admin can do this.
  - It grants nothing a super_admin can't already do through `create_invitation`.
  - No app path issues an UPDATE on `invitations`. I re-grepped: `src/lib/db.ts:239`, `:5597`, `src/lib/auth.ts:549` and the e2e reads are all selects, and `delete-user` does a service-role delete.
- **Optional fix:** in the trigger's UPDATE branch, also freeze `email` and `role` for `authenticated`. Re-invite (B8) is already the supported way to change either, and it rotates the code and re-stamps `invited_by`. Alternatively, the policy comment could state the attribution caveat. This needs an owner decision; I'm not blocking on it.

### Observation (not counted)

- **Inviter-chosen codes are possible.** A privileged client can skip `create_invitation` and INSERT directly with any hex-64 `code_hash`, for example `sha256('a')` or `sha256(E'\t')`. The INSERT policy requires only `code_hash is not null`, plus the format CHECK. That lets an inviter issue a guessable code. It is an insider weakening their own invitation, though: they already hold the strong code and could share it, and R7 still binds the code to them. So this is outside the threat model. It is recorded so that a future "disable direct INSERT, RPC only" tightening knows about it.

### Blank-code guard: pre-check and claim agree [ran, signUp simulated]

`check_invitation_code` now has `nullif(btrim(p_code), '') is not null` (`:546`), and the claim has R3b (`:430-434`). Both use the same `lower(btrim(...))` normalisation before hashing.

I tested against a fixture row with `code_hash = sha256('')` and another with `sha256(E'\t')`:

| Code | Pre-check rows | Claim |
|---|---|---|
| `''` | 0 | P0001 `no pending invitation` |
| `'   '` | 0 | P0001 |
| NULL | 0 | P0001 |
| U+00A0 (NBSP: `btrim` does not strip it; no matching row) | 0 | P0001 |
| `E'\t'` (row planted with `sha256(tab)`; `btrim` doesn't strip tabs on either side) | 1 | claimed |
| The real code in upper case with padding, and the email in upper case with padding (positive control) | 1 | n/a |

In every case the two sides agree. The tab row can only exist through postgres or the inviter-chosen INSERT above. `create_invitation` only issues 32-hex codes.

### L2: closed; the trigger still fires for client writes [ran]

- `has_function_privilege('authenticated', assert_invitation_provenance(), 'EXECUTE')` returns `f`. A direct call is refused: `permission denied for function assert_invitation_provenance`.
- An authenticated INSERT as `1111` with a forged `invited_by = 3333` is stored as `invited_by = 1111`, so the trigger fired.
- A super_admin UPDATE that sets `invited_by`, `code_hash` and `name` gives rows=1. `invited_by` and `code_hash` stay frozen, and `name` changes, so the trigger fired.

This confirms the developer's note that EXECUTE on a trigger function is checked at CREATE TRIGGER time, not when the trigger fires. The fail-closed DO block (8.5) and K-d pin the revoke.

### D-9..D-11 (`supabase/tests/profiles_insert_hardening.test.sql:917-952`) [ran + read]

- **D-9:** the super_admin sets `role = 'super_admin'` → 42501. This still pins WITH CHECK's role leaf, now through the only caller that reaches WITH CHECK.
- **D-10:** the super_admin sets `store_ids = ['not-a-uuid']` → 42501. It pins the fail-closed store arm. The old assertion was a brand admin adding a brand-B store, which is now unreachable because brand admins match 0 rows. It is also meaningless for a super_admin, who sees all brands. The cross-brand case is covered by D-11 plus `invitations_hardening` C2.
- **D-11:** a brand-A admin's UPDATE of its own visible, unused brand-A invite affects 0 rows. The row is not vacuous: `:1042` asserts `d1-164` exists, and D-9/D-10 only throw because the row is matched.
- **Mutation [ran]:** with only the super_admin leaf removed from the UPDATE policy, the file goes red at D-11. Line 952 raises a WITH CHECK 42501 and aborts. `scripts/test-db.sh` runs with `ON_ERROR_STOP=1`, so that is a FAIL.
- **No regression elsewhere [ran]:**
  - `profiles_insert_hardening` 80/80
  - `invitations_hardening` 102/102
  - `invitations_super_admin_rls` 4/4
  - `consume_invitation_sets_profile_id` 9/9
  - `permissive_policy_lint` 5/5
- E-1 now carries a `code_hash`, so it again isolates the privilege leaf [read].
- I did not re-run the full `npm run test:db` or jest suites. The developer's pass reports 106/106 and 3972/3972.

### Earlier passes: spot checks [ran, signUp simulated]

- **195-H1 still fails as intended:**
  - Admin `1111` sees 0 brand-B rows and deletes 0 of them.
  - `create_invitation(…, brand B)` → 42501.
  - Stale `2222` sees 0 rows in total.
- **191-M1 replay still refused:**
  1. The disposable brand-A admin runs `create_invitation(burner, admin, brand A)`.
  2. The super_admin demotes it through `demote_profile_to_user`.
  3. The demoted caller's extend-expiry UPDATE gives 0 rows, and it can see 0 rows.
  4. The burner's pre-check returns 0, the burner's claim fails with `no pending invitation`, and no profile is created.

### Dependencies

Not re-run: this pass changes no `package.json` dependency lines. The baseline from the first audit stands.
