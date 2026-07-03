# Security audit for spec 106 — count-screen save-draft + resume

Auditor: security-auditor. Read-only on code. Scope: the new `user_count_drafts`
migration + its pgTAP RLS test, the pure `countDrafts.ts` module, the admin
`countDraftLocal.ts`, the staff `src/screens/staff/lib/countDrafts.ts` carve-out,
the `db.ts` helper block, and the two screen wirings
(`InventoryCountSection.tsx`, `WeeklyCount.tsx`).

**Verdict: PASS. No Critical, no Should-fix, no Nits.** The feature is a
private, owner-scoped, single-author scratch table with a device-local offline
copy — it is byte-parallel to the already-audited spec-103 `user_count_orders`
pattern, and every threat-model check for this codebase passes. Nothing blocks.

---

### Critical (BLOCKS merge)
None.

### Should-fix (before deploy)
None.

### Nits
None.

---

## What I verified (positive findings)

### RLS — new table is correctly owner-scoped, no bypass
- `supabase/migrations/20260703000000_user_count_drafts.sql:143` — RLS is
  `ENABLE`d, and all four commands have explicit policies
  (`:146` SELECT, `:151` INSERT, `:156` UPDATE, `:161` DELETE).
- Every policy predicate is `auth.uid() = user_id` as the WHOLE clause
  (`:148,153,158-159,164`). No `USING (true)`, no `auth.uid() IS NOT NULL`,
  no OR-tail — so the spec-053 permissive-policy lint passes with **no
  allowlist edit** (matches spec 103's four policies exactly).
- **No `auth_is_admin()` / no `super_admin` bypass** — correct and intentional
  (AC-10): a draft is private to its author, so a privileged user must NOT read
  it. This is the right call. Using `auth_can_see_store()` would also be wrong
  (the row belongs to the user; `store_id` is a key field, not the access axis)
  — the migration correctly avoids it. This is the deliberate inverse of the
  "admin-only data needs `auth_is_admin()`" rule and is well-reasoned in the
  migration header (`:125-134`).
- Owner-scoped-not-store-scoped is the correct axis and is not a finding.

### Cross-user isolation is proven by real pgTAP assertions (not tautologies)
`supabase/tests/user_count_drafts_rls.test.sql` — I read every assertion:
- (3) `:134` B SELECTs A's row → real `count(*) = 0`.
- (4) `:150-165` B UPDATE of A's row → `GET DIAGNOSTICS ROW_COUNT = 0` (genuine
  data-modifying statement, stashed and asserted; not a read-only stub).
- (5) `:168-182` B DELETE of A's row → same real `ROW_COUNT = 0`.
- (6) `:188-199` **the spoofed-user_id insert the prompt called out**: B inserts
  a row with `user_id = A` under a different screen key and expects SQLSTATE
  `42501` via the WITH CHECK. This is a real spoof guard, correctly asserted.
- (7) `:214-222` a synthetic `super_admin` JWT SELECTs A's row → `count(*) = 0`
  (proves NO admin bypass — AC-10).
- (8) `:250-267` single-slot overwrite: 2nd upsert of the same slot → exactly
  ONE row, payload reflects the 2nd write (whole-draft overwrite via the FULL
  `ON CONFLICT`).
- The JWT-claims injection (`set local role authenticated` + `request.jwt.claims`
  with a real `app_metadata.role`) mirrors the audited `user_count_orders_rls`
  shape. Hermetic `begin; … rollback;`.

### Payload safety — no injection surface, no HTML sink, no PII beyond count text
- `payload jsonb` is bound through PostgREST/supabase-js (`.upsert(...)`,
  `.select('payload, saved_at')`) — **no string-concatenation / dynamic-SQL /
  `EXECUTE` path anywhere.** The DB stores it opaquely; the CHECK
  (`jsonb_typeof(payload) = 'object'`, migration `:72-73`) rejects a non-object
  as defense-in-depth.
- **No HTML-rendering sink.** Grepped the entire spec-106 change set for
  `dangerouslySetInnerHTML` / `innerHTML` / `WebView` / `eval(` /
  `new Function` / `__html` / `setNativeProps` — **none found.** Item notes are
  rendered/edited via a React Native `<TextInput value={itemNotes[it.id]}>`
  (`InventoryCountSection.tsx:917`) — RN `Text`/`TextInput` do not interpret
  markup, so a note like `<script>` is inert. No mail-body interpolation (no
  edge function in this feature), so the `escapeHtml` rule does not apply.
- Drafts contain only the counter's verbatim typed count strings + note text,
  scoped to the owner. No secrets, no cross-store rows, no other-user PII.

### Device-local copies are user-scoped on the key AND on the read path
- Admin key `imr.countDraft.<screen>.<storeId>.<userId>`
  (`countDraftLocal.ts:42-48`); staff key
  `imr-staff:count-draft:v1:<screen>:<storeId>:<userId>`
  (`src/screens/staff/lib/countDrafts.ts:165-171`) — **both embed the userId.**
- The read path resolves the id from the **current authenticated session**, not
  from any attacker-controlled value: admin `uid = currentUser?.id`
  (`InventoryCountSection.tsx:440,447`); staff
  `userId = currentStaffUserId(s.authState)` (`WeeklyCount.tsx:207,407`). So a
  signed-out or different user on the same device reads a **different key** and
  cannot restore another user's local draft. Belt-and-suspenders on top of the
  server RLS.
- **Corrupt-payload handling never evals.** Both local readers `JSON.parse`
  inside try/catch and run a shape-validator (`isLocalCountDraft` /
  `isLocalStaffDraft`) that rejects a malformed record → treated as no-draft.
  The staff `backupCorrupt` (`:259-270`) writes the bad bytes to a
  `<slotKey>-corrupted:<ISO>` key that is **itself userId-scoped** (derived from
  the slot key), so a corrupt backup cannot be cross-read either. No `eval`,
  no `Function`, no dynamic require.

### db.ts / staff carve-out — RLS-bound client only, no service key, no raw fetch
- All three admin helpers (`db.ts:2112,2153,2184`) go through the RLS-bound
  `supabase` client, are `useInflight.track()`ed with `.abortSignal(signal)`,
  and pin `.eq('user_id', userId)` as defense-in-depth on top of RLS. Errors
  are thrown (no silent-success). `saveCountDraft` uses the correct
  `.upsert({ onConflict: 'user_id,screen,store_id' })` (the FULL unique
  constraint is a valid target — the deliberate spec-103 divergence).
- The staff carve-out (`src/screens/staff/lib/countDrafts.ts:71-143`) re-authors
  the same three ops against `supabase.from('user_count_drafts')` directly (the
  documented spec-063 carve-out) with identical owner-pinned filters. **No raw
  `fetch()`** to the drafts table anywhere (grepped). **No `service_role` key,
  no service token, no bearer, no `EXPO_PUBLIC_*`** in any spec-106 file (the
  only `service_role` reference is the standard `grant all … to service_role`
  in the migration, which is a DB-side grant, not a client-reachable secret).

### Insecure-defaults / exposure checks
- **Not added to the `supabase_realtime` publication** — confirmed no
  `alter publication … add table user_count_drafts` in any migration (the only
  match is a comment documenting the deliberate absence, migration `:27`). A
  private single-author scratch is correctly kept off the wire, so a client
  subscribing to `store-{id}` receives nothing for this table.
- **Not added to the `public_grants_explicit` allowlist** — correct: the table
  HOLDS its SELECT grant, so the probe's positive arm (arm 1) asserts it
  automatically; adding an allowlist row would wrongly stop asserting the grant.
  Confirmed the table name does not appear in
  `public_grants_explicit.test.sql`.
- Explicit grants (`grant select, insert, update, delete, references, trigger …
  to anon, authenticated;` + `grant all … to service_role;`, migration
  `:121-123`) mirror `user_count_orders`/`item_vendors`, with TRUNCATE
  deliberately omitted for anon/authenticated (the anti-escalation baseline).
- **Save/Submit gate independence (AC-1/AC-12, an authz-adjacent correctness
  check).** The admin Save button is disabled only by
  `savingDraft || isAllOrEmpty` (`InventoryCountSection.tsx:999`), where
  `isAllOrEmpty = !storeId || storeId === '__all__'` (`:200`) — this is the
  "no single active store" guard, NOT the count-everything gate. Submit remains
  gated by `nonBlankCount === 0 || hasNegative` (`:1020`). So Save cannot be
  used to bypass the Submit completeness gate, and a partial/empty draft
  persists as designed.
- No SQL fragments / stack traces / raw other-store rows in any client-returned
  error; the local readers/writers log only a key string (no payload values) on
  failure.

### Dependencies
No `package.json` / lockfile changes in this spec — `npm audit` skipped
(confirmed via `git diff --stat` on `package.json`/`package-lock.json`: empty).

---

## Threat-model coverage summary
- Missing/incorrect authz → none (owner-scoped RLS + defense-in-depth `.eq`).
- Input validation (SQLi/XSS/SSRF/path-traversal/cmd-injection) → none (bound
  jsonb, no dynamic SQL, RN-only render, no URL fetch/redirect/file path).
- Secrets in code/logs → none.
- PII in responses/logs → none beyond owner-scoped count text.
- Insecure defaults (CORS/cookies/CSRF/rate-limit) → N/A (PostgREST
  token-bearer, no cookie auth, private single-row ops).
- Vulnerable deps → no dep change.
- Auth-flow flaws (realtime leak, token handling) → none (table off the
  publication; ids from the authenticated session only).
