# Security audit for spec 016 — Reports Runner Foundation (REPORTS-1) — Round 2

Round-2 re-audit after the developer applied **Path A (minimal-diff)** per the
release proposal: new migration `supabase/migrations/20260510130000_report_runs_consistency.sql`
introducing a BEFORE INSERT/UPDATE trigger on `public.report_runs` and a
`default auth.uid()` on the `ran_by` column, plus client-side error
sanitization in `src/lib/db.ts`.

Live psql + PostgREST verification was rerun against `supabase_db_imr-inventory`
on 2026-05-10 against the same threat-model scenarios documented in round 1.

---

## Verdict on round-1 findings

| Round-1 finding                                                                 | Severity | Round-2 verdict       |
|---------------------------------------------------------------------------------|----------|-----------------------|
| `report_runs` cross-store INSERT spoof (forged `definition_id`)                 | Critical | **PASS — fixed**      |
| `ran_by` audit-trail forgery                                                    | High     | **PARTIAL — see High below** |
| `error_message` may surface raw PostgrestError text cross-tenant                | High     | **PASS — fixed**      |
| `report_run_stub` reachable to all authenticated users                          | Medium   | unchanged informational |
| Realtime publication includes `report_runs` despite spec claim                  | Medium   | unchanged informational |
| `auth_can_see_store` admin/super-admin/membership cases — verified correct      | (note)   | unchanged             |
| Defense-in-depth dispatcher gate — confirmed correct                            | Low      | unchanged             |
| Frontend rendering of envelope strings — safe                                   | Low      | unchanged             |
| `definition_id` falsy → NULL coercion — safe                                    | Low      | unchanged             |
| `console.warn` paths log only error messages, not payloads                      | Low      | unchanged             |

---

## Round-2 findings

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

#### High #1 (round-1 carry-over, partially closed): `ran_by` is still client-settable when explicitly supplied

- **File:** `supabase/migrations/20260510130000_report_runs_consistency.sql:89-90`
  (`alter column ran_by set default auth.uid()`); `src/lib/db.ts:1695-1697`
  (legitimate client now omits the field).

- **What was fixed.** The legitimate `db.runReport` INSERT no longer passes
  `ran_by` (verified in `src/lib/db.ts`), and the column now defaults to
  `auth.uid()`. A correctly-behaved client cannot lie about who ran a
  report.

- **What remains.** `default auth.uid()` only fires when the column is
  **omitted** from the INSERT. If a hand-crafted PostgREST request
  includes `ran_by` in its body, Postgres uses the client value verbatim —
  there is no trigger or generated-column constraint forcing the server
  value. CLAUDE.md's threat model explicitly says sibling-app and
  hand-crafted PostgREST callers are not friendly, so this is still
  exploitable from outside `imr-inventory`.

- **Reproduction (PostgREST, validated):**

  ```text
  $ JWT=<authenticated JWT for user 22222222 (manager, member of Towson)>
  $ ANON=<anon publishable key>

  # Test B: omit ran_by → server defaults to auth.uid() = 22222222
  $ curl -X POST 'http://127.0.0.1:54321/rest/v1/report_runs' \
      -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
      -H "Prefer: return=representation" \
      -d '{"definition_id":null,"template_id":"stub",
           "store_id":"00000000-0000-0000-0000-000000000001",
           "params":{},"output":{},"status":"ok"}'
  → ran_by = "22222222-2222-2222-2222-222222222222"   (correct)

  # Test C: client includes ran_by = 11111111 (admin's UUID) → accepted
  $ curl -X POST 'http://127.0.0.1:54321/rest/v1/report_runs' \
      -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
      -H "Prefer: return=representation" \
      -d '{"definition_id":null,"template_id":"stub",
           "store_id":"00000000-0000-0000-0000-000000000001",
           "params":{},"output":{},"status":"ok",
           "ran_by":"11111111-1111-1111-1111-111111111111"}'
  → ran_by = "11111111-1111-1111-1111-111111111111"   (FORGED — accepted)
  ```

- **Impact.** Audit attribution on a multi-tenant table is forgeable. A
  manager can persist a row claiming the brand admin ran a malicious or
  compromising report. With the cross-store spoof now closed, the row
  will live in the manager's own store (so the visible damage is limited
  to that store's history), but the attribution itself remains
  unfaithful — a brand admin investigating a suspicious run will be
  pointed at the wrong account. Same severity as round 1 because the
  attribution-integrity property is still broken on the same surface.

- **Fix (one of):**
  1. **Trigger override (matches the cleanest fix the round-1 audit
     called for):** in the new
     `report_runs_check_definition_consistency` function (or a sibling
     `BEFORE INSERT` trigger), unconditionally set `new.ran_by :=
     auth.uid()`. One line, no contract change for the legitimate client.
  2. **Generated column:** redefine `ran_by` as
     `generated always as (auth.uid()) stored` so client-supplied values
     are rejected with `428C9` rather than silently accepted. Cleanest
     but slightly more invasive (need a column rewrite).
  3. **PostgREST column-level grant:** revoke `INSERT (ran_by), UPDATE
     (ran_by)` on `report_runs` from `authenticated` so PostgREST refuses
     bodies that include the column. Database-level enforcement, no
     application-code change.

- **Note for the release-coordinator.** Per the round-2 instructions,
  this is "a partial fix — flag it." It does NOT introduce a new Critical
  and the original Critical (cross-store spoof) IS fully resolved, so I
  am not recommending a block. But the round-1 High remains a High under
  the project's threat model and should be closed before deploy. Three
  lines of SQL would do it.

### Medium

#### Carry-over: Realtime publication includes `report_runs` despite spec text

- **File:** observed at `pg_publication_tables`; spec claims at
  `specs/016-reports-runner-foundation/spec.md:317-321, 887-892`.

- **Status.** Unchanged from round 1. `pg_publication.puballtables = t`
  for `supabase_realtime`, so `report_runs` IS replicated. RLS still
  gates by store, so a non-member subscriber cannot see foreign rows.

- **Note.** Now that the cross-store INSERT spoof is closed, the
  realtime channel can no longer propagate forged-row poison; it just
  becomes a "second tab will see this user's own legit run earlier than
  expected" UX surprise instead of a security issue. Downgraded from
  round-1 risk wording but kept as informational.

#### Carry-over: `report_run_stub` reachable to every authenticated user

- **File:** `supabase/migrations/20260510120000_report_runs.sql:168-211`.
- **Status.** Unchanged. Stub returns hardcoded dummy data; data-leak
  risk is zero. Informational only.

### Low

All round-1 Low findings remain unchanged (defense-in-depth dispatcher
gate, frontend rendering safety, `definition_id` falsy coercion, log
hygiene). No new Low findings introduced by this round.

---

## Round-2 verification transcripts

### Trigger / column installation

```text
$ docker exec ... psql -c "select tgname from pg_trigger
                            where tgrelid='public.report_runs'::regclass;"
report_runs_check_definition_consistency_trg     ← installed

$ docker exec ... psql -c "select column_default from
   information_schema.columns where table_name='report_runs'
   and column_name='ran_by';"
auth.uid()                                        ← default set

$ docker exec ... psql -c "select prosecdef, proconfig from pg_proc
   where proname='report_runs_check_definition_consistency';"
prosecdef = f          ← security invoker (correct, not definer)
proconfig = {search_path=public}                  ← locked (correct)
```

### Critical re-test (round-1 reproduction)

#### Test 1 — Canonical spoof (definition=Charles, store_id=attacker's Towson)

```text
$ docker exec ... psql -f spoof_canonical.sql
BEGIN
SET
set_config = '{"sub":"22222222-...","app_metadata":{"role":"user"}}'

INSERT INTO public.report_runs (definition_id, template_id, store_id, ...)
VALUES ('a0...02' /* Charles */, 'variance', '00...01' /* Towson */, ...);

ERROR: 42501: report_runs row inconsistent with parent definition
CONTEXT: PL/pgSQL function report_runs_check_definition_consistency()
         line 20 at RAISE
ROLLBACK
```

Trigger raised at line 20 (the "parent definition not visible / not
found" branch — RLS hides Charles' definition from the manager).
**PASS.**

Same attack via PostgREST:

```text
$ curl -X POST .../rest/v1/report_runs ... (manager JWT, Charles
   definition_id, Towson store_id, INJECTED kpis) ...
HTTP/1.1 403 Forbidden
Proxy-Status: PostgREST; error=42501

{"code":"42501", "details":null, "hint":null,
 "message":"report_runs row inconsistent with parent definition"}
```

**PASS.**

#### Test 2 — Same spoof, correct store, wrong template

```text
$ docker exec ... psql -f spoof_wrong_template.sql
BEGIN
... (admin JWT — can see Charles)
INSERT INTO public.report_runs (definition_id, template_id, store_id, ...)
VALUES ('a0...02' /* Charles, template=variance */,
        'cogs',                                      -- wrong template
        '1ea549bb-...' /* Charles, correct */, ...);

ERROR: 42501: report_runs row inconsistent with parent definition
CONTEXT: PL/pgSQL function report_runs_check_definition_consistency()
         line 25 at RAISE
ROLLBACK
```

Trigger raised at line 25 (the second branch — `(store_id, template_id)`
mismatch). **PASS.**

#### Test 3 — UPDATE re-pointing definition_id to a foreign definition

```text
$ docker exec ... psql -f spoof_update.sql
BEGIN
... (admin JWT)
INSERT INTO public.report_runs (id, definition_id, template_id, store_id, ...)
VALUES ('b0...01', 'a0...01' /* Towson */, 'variance', '00...01', ...);
INSERT 0 1

UPDATE public.report_runs
   SET definition_id = 'a0...02'                     -- repoint to Charles
 WHERE id = 'b0...01';

ERROR: 42501: report_runs row inconsistent with parent definition
CONTEXT: PL/pgSQL function report_runs_check_definition_consistency()
         line 25 at RAISE
ROLLBACK
```

UPDATE-path also blocked. **PASS.**

#### Test 4 — Negative paths (legit operations still work)

```text
$ docker exec ... psql -f legit_null_def.sql
BEGIN
... (manager JWT)

-- 4a: ad-hoc run, definition_id = NULL (REPORTS-2 stub-test path)
INSERT INTO public.report_runs (definition_id, ...)
VALUES (NULL, 'stub', '00...01' /* Towson */, ...) RETURNING ...;
   id = 0951efc9-..., definition_id = NULL,
   ran_by = 22222222-...                              ← auto-populated

-- 4b: matching definition_id + store_id + template_id (legit Towson run)
INSERT INTO public.report_runs (definition_id, ...)
VALUES ('a0...01' /* Towson */, 'variance', '00...01' /* Towson */, ...)
RETURNING ...;
   id = 093a4b08-..., definition_id = 'a0...01',
   ran_by = 22222222-...                              ← auto-populated

ROLLBACK
```

Both legit inserts succeed. NULL `definition_id` short-circuits at
function line 17 (`if new.definition_id is null then return new;`).
Matching `(store_id, template_id)` passes the `is distinct from` check.
**PASS.**

### `ran_by` audit-trail forgery — partial pass

#### Test B — omit `ran_by`

```text
POST /rest/v1/report_runs (manager JWT)
Body: {"definition_id":null, ...}                    -- no ran_by field
Response: 201 Created, ran_by = "22222222-..."       ← auth.uid() default
```

**PASS.**

#### Test C — client supplies forged `ran_by` = admin's UUID

```text
POST /rest/v1/report_runs (manager JWT)
Body: {..., "ran_by":"11111111-1111-1111-1111-111111111111"}
Response: 201 Created, ran_by = "11111111-..."       ← FORGED, accepted
```

**PARTIAL.** `default auth.uid()` only fires on column omission. A
hand-crafted PostgREST INSERT that names the column overrides the
default. See High #1 above for the recommended trigger / generated-column
fix.

### `error_message` PostgrestError leak — pass

`src/lib/db.ts:1672-1678` now branches:

```ts
if (rawMessage.startsWith('Not authorized')) {
  errorMessage = rawMessage;          // intentional dispatcher raise
} else {
  console.warn('[Supabase] runReport RPC failed:', rpcError);
  errorMessage = 'Run failed — check server logs';
}
```

Live verification of the dispatcher's `Not authorized` raise (the only
class REPORTS-1 actually emits):

```text
$ POST /rest/v1/rpc/report_run (manager JWT, store=Charles)
Body: {"p_template_id":"stub","p_store_id":"1ea549bb-...","p_params":{}}
Response: 401-shape with
  {"code":"42501","message":"Not authorized for store 1ea549bb-..."}

→ rawMessage starts with "Not authorized" → passes through verbatim.
```

The non-`Not-authorized` branch cannot be exercised in REPORTS-1
(dispatcher only raises auth errors today), but the code path is
clearly correct — any future RPC error class will be replaced with the
generic copy and the raw `rpcError` object goes to `console.warn` for
developer triage. The detail frame's `ErrorPanel` at
`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:313-338` reads
the sanitized `errorMessage` string into a plain `<Text>` node — no
HTML parsing, no leakage path. **PASS.**

### Trigger as new attack surface — pass

- **`security invoker`:** confirmed via `pg_proc.prosecdef = f`. The
  trigger's `SELECT FROM report_definitions` runs as the caller, so
  RLS hides foreign definitions and the trigger raises the same
  generic message regardless of why the row was rejected.

- **`set search_path = public`:** confirmed via `pg_proc.proconfig`.
  No schema-shadowing attack surface.

- **No information leak via the error message.** Both branches raise
  the identical string `'report_runs row inconsistent with parent
  definition'` — does not echo the foreign `definition_id`,
  `store_id`, or `template_id`, so a probing attacker cannot
  distinguish "definition exists but I can't see it" from "definition
  doesn't exist" from "fields don't match."

- **No privilege escalation.** Because the function is `security
  invoker`, the trigger cannot read rows the caller cannot already see.
  An admin's INSERT into Charles store remains gated by the per-store
  `WITH CHECK` policy; the trigger only adds the consistency rule.

- **Side-effect-free.** The function is read-only (one SELECT) plus a
  RAISE; no INSERT/UPDATE inside the trigger. No side-effect risk.

- **DELETE is unaffected.** `BEFORE INSERT OR UPDATE` does not fire on
  DELETE; verified by deleting a freshly-inserted row inside a
  transaction.

**No new Critical or High introduced by the trigger.**

---

## Dependencies

`package.json` and `package-lock.json` are unchanged this round. Round-1
`npm audit --audit-level=high` results stand: 6 pre-existing advisories
in dev tooling (expo CLI / metro / build pipeline), none introduced by
spec 016. No action required for this spec.

---

## Summary

Round-2 result: **0 Critical, 1 High (carry-over, partially fixed),
2 Medium (informational), 4 Low (informational)**.

- Round-1 Critical (`report_runs` cross-store INSERT spoof) is **fully
  resolved**. The trigger correctly raises `42501` on all three attack
  variants (canonical spoof, wrong-template variant, UPDATE re-point)
  and does NOT block legitimate inserts (NULL `definition_id`, fully
  matching `(store_id, template_id, definition_id)`). The trigger
  function itself is `security invoker` with locked `search_path` and
  introduces no new attack surface.

- Round-1 High #2 (PostgrestError text leak) is **fully resolved**.
  Sanitization at `src/lib/db.ts:1672-1678` keeps `Not authorized` raises
  verbatim and replaces all other classes with a generic copy.

- Round-1 High #1 (`ran_by` audit-trail forgery) is **partially
  resolved**. The legitimate client path is correct, but a hand-crafted
  PostgREST INSERT that includes `ran_by` in its body still overrides
  the `default auth.uid()`. Recommend closing with a one-line trigger
  override (`new.ran_by := auth.uid()`), a generated column, or a
  column-level INSERT/UPDATE revoke before deploy.

**No new Critical was introduced and the round-1 Critical IS fully
resolved.** Per the round-2 brief, this audit does NOT issue a block
recommendation. The carry-over High should be closed before deploy
under the project's threat model, but it is the release-coordinator's
call whether to gate REPORTS-1 on it or accept it as a pre-existing-
finding to fix in a follow-up.
