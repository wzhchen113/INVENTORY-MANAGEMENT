# Spec 196: Make `purchase_orders.po_number` server-assigned for API callers

Status: READY_FOR_REVIEW

Origin: the Medium finding in `specs/190-po-number-sequence/reviews/security-auditor.md` (L24-66), dispatched by the main session on 2026-11-09. The owner's brief answered every open question the same day (see "Owner's decisions"). The write-path audit is in the side-session note `po-number-server-assigned-audit.md` (2026-11-09) and is summarised under "What the code does today". Line numbers are pointers, read from the working tree on 2026-11-09.

## User story

As the **owner of 2AM PROJECT**, I want PO numbers to be issued only by the server for every app, staff and extension caller, so that no store member (staff accounts included) can squat on upcoming PO numbers and make other stores' and brands' "Fill cart" or draft-PO inserts fail.

## Problem

Spec 190 (migration `supabase/migrations/20261109140000_po_number_sequence.sql`, staged, **not yet on prod**) makes `generate_po_number()` a SECURITY DEFINER trigger that takes numbers from one global sequence, skips numbers that are already taken, and gives up after 100 tries with SQLSTATE `54000`.

Its security audit shows that any store member can still:

1. insert one PO with a NULL `po_number` in their own store to learn the sequence position, then delete it inside spec 186's 1-day window;
2. send one PostgREST bulk insert (array body) of 100×K rows with explicit numbers `PO-<next>` to `PO-<next+100K-1>`, or UPDATE their own store's POs onto those numbers.

Numbering is global, so the next K generated inserts **in every brand** fail with `54000` ("Draft not created"). The attack clears itself (each failure moves the sequence 100 further) and is not a regression: the old `max()` body could be blocked permanently. But there is no legitimate client reason to supply or change `po_number`, so the route should be closed.

The audit's suggested fix: a BEFORE INSERT/UPDATE guard that refuses a caller-supplied non-NULL or changed `po_number` when the effective role is `anon` or `authenticated`, with a `P0001` refusal string. Table-level INSERT/UPDATE grants cannot be narrowed per column without re-granting column lists, so a trigger is the practical shape.

## Owner's decisions (2026-11-09)

| Question | Decision |
|---|---|
| Who is refused | Callers whose **effective Postgres role** (`current_user`) is `anon` or `authenticated`. This is every PostgREST caller: admin Cmd UI, staff app, Chrome extension, and any edge function forwarding a user JWT. The app role does not matter: **super_admins and admins are refused too** |
| INSERT | A non-NULL `po_number` is refused. An explicit NULL, or omitting the column, is allowed (that is "let the server assign") |
| UPDATE | Only a **changed** value is refused (NULL counts as a value, so a change to or from NULL is a change). An UPDATE that leaves `po_number` as it is, including a PATCH that echoes the same value, is allowed. Status-only and total-only updates keep working |
| Who keeps explicit numbers | `postgres` and `service_role`: migrations, pgTAP fixtures, hand repairs through the SQL editor or MCP, service-role edge functions. INSERT and UPDATE both |
| Refusal | SQLSTATE `P0001`, message exactly `po_number is server-assigned` (CLAUDE.md refusal-string convention). PostgREST maps `P0001` to HTTP 400 |
| SECURITY DEFINER RPCs | Accepted residual. An authenticated user calling a `postgres`-owned SECURITY DEFINER RPC runs as `postgres` and passes the guard. No such RPC sets or changes `po_number` today |
| Client, store, edge-function, UI changes | None expected |
| Existing rows | Not touched |
| Prod | Only with the owner's explicit go-ahead, through the project's MCP route, and after or together with spec 190's migration |

## What the code does today

From the 2026-11-09 audit. Nothing outside test fixtures sends or changes `po_number`.

| Writer | Operation | Touches `po_number`? |
|---|---|---|
| `src/lib/db.ts:1644` (Mark as Submitted) | INSERT `purchase_orders` | No |
| `src/lib/db.ts:1740` (`createPurchaseOrder` draft) | INSERT | No |
| `src/lib/db.ts:1921` (`upsertVendorDraftOrder`), `:1911` | INSERT; UPDATE `total_cost` | No |
| `src/lib/db.ts:2124` (`markPurchaseOrderSent`) | UPDATE `status` | No |
| `extension/src/lib/imrClient.ts:103` (`markOrdered`) | UPDATE `status` where `status = 'draft'` | No |
| `supabase/functions/send-po-email/index.ts:204` (service role) | UPDATE `status` | No |
| BJ's auto-place (`20260829000000_auto_place_order_attempts.sql:336`) | UPDATE `status` | No |
| SQL RPCs (`po_loop`, `cost_on_receipt`, `staff_receiving_price_gate`, auto-receive) | UPDATE `status`, `received_*` | No |
| Staff app (`src/screens/staff/lib/receiving.ts:115`) | SELECT only | n/a |
| `seed.sql`, `e2e/` | none | No |

The only reader that shows `po_number` is `send-order-failure-email` (escaped).

**pgTAP fixtures that set `po_number` explicitly:**

| File | Runs as | Effect of this spec |
|---|---|---|
| `supabase/tests/report_run_variance_formula.test.sql:155` | **`authenticated`** (`set local role` at :92, no reset before :155) | **Breaks.** Must drop `po_number` from the insert and let the trigger assign one. Spec 190 made the trigger SECURITY DEFINER, so RLS no longer affects it |
| `supabase/tests/generate_po_number_malformed_guard.test.sql` | `postgres` | Unaffected |
| `supabase/tests/generate_po_number_sequence.test.sql` (AC-9, AC-10, AC-11, DP-6; L418, 437, 472, 486, 507) | `postgres` | Unaffected |
| `supabase/tests/retention_prune_job.test.sql:263` | `postgres` | Unaffected |

**Triggers on `purchase_orders` on disk today** (BEFORE triggers fire in name order, C collation):
- `set_po_number`: BEFORE INSERT, `WHEN (new.po_number IS NULL)`, runs `generate_po_number()` (`20260405000759_init_schema.sql:234`, body replaced by spec 190).
- `purchase_orders_lock_store_id_trg`: BEFORE UPDATE OF `store_id` (spec 177, `20261025000000_cross_store_item_rejection.sql:217`).
- `purchase_orders_lock_created_at_trg`, `purchase_orders_no_return_to_draft_trg`: BEFORE UPDATE (spec 194, `20261109170000_kept_records_delete_hardening.sql:118,164`, not yet on prod).
- `notify_purchase_order`: AFTER INSERT OR UPDATE (`20260715000000_submission_notifications.sql:273`).

`purchase_orders.po_number` is `text unique` and **nullable** (`20260405000759_init_schema.sql:155`).

## Requirements

### R1. API callers cannot supply a PO number on INSERT
An INSERT into `public.purchase_orders` whose row has a non-NULL `po_number` is refused when `current_user` is `anon` or `authenticated`, for every app role. A multi-row INSERT with any such row is refused as a whole and writes no rows. A NULL or omitted `po_number` is allowed and gets a number from spec 190's trigger, exactly as spec 190 defines.

### R2. API callers cannot change a PO number on UPDATE
An UPDATE where `new.po_number IS DISTINCT FROM old.po_number` is refused when `current_user` is `anon` or `authenticated`, for every app role. An UPDATE that leaves `po_number` unchanged is allowed, whether or not the column appears in the SET list.

### R3. Owner paths keep explicit numbers
When `current_user` is `postgres` or `service_role`, explicit `po_number` values on INSERT and changes on UPDATE work as they do today. This includes a `postgres` session that still carries user JWT claims (for example pgTAP after `reset role`): the test is the effective role, not the claims.

### R4. Refusal shape
SQLSTATE `P0001`, message byte for byte `po_number is server-assigned`. The guard fires before any row is written.

### R5. Nothing else changes
Generated numbering, the spec 190 skip loop, RLS policies, grants on `purchase_orders`, existing rows, clients, edge functions and the realtime publication are unchanged.

## Acceptance criteria

Track names follow `tests/README.md`. New pgTAP arms go in a new file, `supabase/tests/po_number_server_assigned.test.sql` (Track 2), hermetic (`begin; … rollback;`), unless a criterion names another file.

**Callers.** "Staff" is a `profiles.role = 'user'` member of the fixture store. "Admin" is a brand admin who can see the store. "Super_admin" is a `profiles.role = 'super_admin'` caller. All three act as `set local role authenticated` plus `request.jwt.claims`. "Owner" means `postgres` and, separately, `set local role service_role`.

**Read-back rule (spec 186/194).** Every arm that claims a row was or was not written, or a value did or did not change, reads it back by fixture id **as `postgres`** in a later block.

**Sequence rule (spec 190).** No arm may assert an absolute generated number unless it sets the sequence itself, and no arm may lower the sequence.

### Refusals (pgTAP)

- [x] **AC-1 (INSERT, explicit number).** As staff, as admin and as super_admin (one arm each), `insert into public.purchase_orders (..., po_number) values (..., 'PO-<n>')` raises `throws_ok(…, 'P0001', 'po_number is server-assigned')`. Read back: no row with that number exists.
- [x] **AC-2 (bulk INSERT).** As staff, a single multi-row INSERT of at least 3 rows, all with explicit numbers, raises the AC-1 error. A second multi-row INSERT mixing NULL-number rows with one explicit-number row also raises it. Read back: none of the rows from either statement exists (by fixture id).
- [x] **AC-3 (UPDATE changes the number).** As staff and as admin, on a PO in their store, `update ... set po_number = '<other value>'` raises the AC-1 error. Also `set po_number = null` on a PO with a number raises it. Read back: the original number is unchanged.
- [x] **AC-4 (bulk UPDATE).** As staff, one UPDATE that renumbers at least 2 POs in the store raises the AC-1 error, and every row reads back with its original number.

### Allowed paths (pgTAP)

- [x] **AC-5 (generated INSERT).** As staff and as admin, an INSERT that omits `po_number`, and one that sets `po_number = null` explicitly, both succeed (`lives_ok`). Each row reads back with a number matching `^PO-[0-9]{3,}$` that equals the sequence's next value read as `postgres` just before the insert, formatted with `public.format_po_number`.
- [x] **AC-6 (status and total updates).** As staff, on the fixture store's POs, each of these succeeds and reads back with the new value and the original `po_number`: `status` draft→sent (the `markPurchaseOrderSent` shape), the extension shape (`... set status = 'sent' where id = … and status = 'draft'`), and a `total_cost` update.
- [x] **AC-7 (same-value echo).** As staff, `update ... set po_number = po_number`, and `update ... set po_number = '<its current literal value>', status = 'sent'` (a PATCH that echoes the number), both succeed, and the number reads back unchanged.
- [x] **AC-8 (SQL RPC status path).** As a store member allowed to call it, `public.receive_purchase_order` (current body from `20260707000000_staff_receiving_price_gate.sql`) on a `sent` fixture PO succeeds, and the PO reads back with its original `po_number`.
- [x] **AC-9 (owner INSERT).** As `postgres`, and separately as `service_role`, an INSERT with an explicit `po_number` succeeds and keeps the value. Use a value far ahead of the sequence (spec 190 AC-9 style) so the arm does not interact with the skip loop.
- [x] **AC-10 (owner UPDATE).** As `postgres`, and separately as `service_role`, an UPDATE that changes `po_number` succeeds and reads back with the new value.
- [x] **AC-11 (`postgres` with stale user claims).** As `postgres` after `reset role` while staff claims are still set in `request.jwt.claims`, an explicit-number INSERT succeeds. This pins R3: the test is `current_user`, not the claims.

### `anon`

- [x] **AC-12 (`anon` covered).** The guard's role test includes `anon`. Do not use `set role anon` in pgTAP (spec 067 segfault, as noted in spec 194 D-8). The design states how `anon` is evidenced (for example a catalog or body assertion, or a safe arm if one exists). `anon` has no INSERT/UPDATE policy on `purchase_orders`, so this is defence in depth.

### Catalog facts (pgTAP)

- [x] **AC-13 (guard function).** The guard function the design names has `prosecdef = false` (SECURITY INVOKER), `proconfig = {search_path=public}`, owner `postgres`, and `has_function_privilege` is false for EXECUTE for `public`, `anon` and `authenticated` (spec 097 default-privilege pattern: revoke explicitly, because new functions are born with ALL for those roles).
- [x] **AC-14 (trigger wiring and order).** The guard trigger(s) exist on `public.purchase_orders`, are enabled (`tgenabled = 'O'`), are BEFORE ROW, and cover INSERT and UPDATE. The INSERT guard's name sorts **before** `set_po_number` in C collation, asserted directly (`'<guard name>' collate "C" < 'set_po_number' collate "C"`). If the UPDATE guard uses a column list or a `WHEN` clause, the arm pins it.
- [x] **AC-15 (spec 190 objects unchanged).** `public.generate_po_number()` keeps `prosecdef = true` and `proconfig = {search_path=public}`, and `set_po_number` keeps `WHEN (new.po_number IS NULL)`. This spec does not edit either.

### Existing tests

- [x] **AC-16 (variance fixture).** `supabase/tests/report_run_variance_formula.test.sql` no longer sets `po_number` in its PO insert (L155, L162), and its comment at L147-151 is rewritten to say the number is server-assigned (spec 196) and the fixture lets the trigger assign it. `plan(7)` and all seven assertions are unchanged and pass.
- [x] **AC-17 (spec 190 tests).** `generate_po_number_sequence.test.sql` and `generate_po_number_malformed_guard.test.sql` pass unchanged.
- [x] **AC-18 (whole suite).** `scripts/test-db.sh` passes every file, including `retention_prune_job`, `kept_records_delete_hardening` (if spec 194 is applied locally), `po_loop`, `extension_ordering`, `submission_notifications`, `cross_store_item_rejection` and `permissive_policy_lint`. Full `npx jest` and `npm run typecheck:test` still pass as a no-regression check (no TypeScript change is expected). If any existing file needs a change other than AC-16, the implementation notes explain it; do not silently re-pin.

### Proof the tests can fail

- [x] **AC-19.** Each mutation below is tried by hand in a scratch transaction and the result recorded in the implementation notes (spec 186/194 practice):

  | Temporary change | Arms that must fail |
  |---|---|
  | Guard trigger(s) dropped | AC-1, AC-2, AC-3, AC-4 |
  | Guard function made SECURITY DEFINER | AC-1, AC-3 (the role test always sees `postgres`) |
  | INSERT guard renamed to sort after `set_po_number` | AC-5 (every generated insert is refused), AC-14 |
  | UPDATE guard compares "column in SET list" instead of OLD vs NEW | AC-7 |
  | Role test widened to every role | AC-9, AC-10, AC-11 |

### Production (owner go-ahead required)

- [ ] **AC-20 (prod apply).** Applied through the Supabase MCP (`execute_sql`, project `ebwnovzzkwhsdxkpyjka`), with the exact migration version inserted into `supabase_migrations.schema_migrations`, **after or together with** spec 190's `20261109140000`. Before applying, confirm spec 190's version is on prod or is being applied in the same session.
- [ ] **AC-21 (prod verification).** On prod: the guard function's normalized md5 matches local; `prosecdef = false`; `proconfig = {search_path=public}`; owner `postgres`; `proacl` has no `anon=` or `authenticated=` entry **and no entry starting with `=`** (PUBLIC, per spec 190 audit Low #2); the trigger(s) exist with the local name, timing, events and order. No PO row is inserted or updated to verify.
- [ ] **AC-22 (CI after push).** The latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green, and `e2e.yml` is checked by hand.

## In scope

- One migration adding the guard function and its trigger(s) on `public.purchase_orders`, with the explicit EXECUTE revoke and comments that name spec 196.
- The new pgTAP file `supabase/tests/po_number_server_assigned.test.sql`.
- The AC-16 fixture and comment change in `supabase/tests/report_run_variance_formula.test.sql`.
- The prod apply and verification, gated on the owner.

## Out of scope (explicitly)

- **Renumbering or rewriting existing rows.** Existing numbers, including any hand-typed or malformed ones, stay.
- **Validating the format of owner-supplied numbers** (`postgres`, `service_role`). Owner paths are trusted, matching spec 190's "validating explicit `po_number`" exclusion.
- **Removing or changing spec 190's skip loop, its 100-try bound or its `54000` message.** Owner paths can still insert explicit numbers ahead of the sequence, so the loop still has a job.
- **Spec 190 audit Low items:** the `54000` hint text sent to clients, the cross-brand volume signal, spec 190's D-9 checklist gaps, the TRUNCATE grant on `public` tables, and the rollback-above-1000 note. Each is its own decision.
- **Closing the SECURITY DEFINER RPC route.** Accepted by the owner. A future RPC that writes `po_number` must be reviewed against this rule.
- **Harmonising with spec 194's claims-based exemption.** Spec 194's date guard looks at JWT claims as well as `current_user`. The owner chose the simpler `current_user` test here; the design must not copy spec 194's rule.
- **Changing who can insert or update `purchase_orders`.** RLS policies and table grants stay as they are.
- **Client, store, edge-function, extension or UI changes.** None needed (see "What the code does today").
- **Editing spec 190's documents or migration** to note that client-supplied numbers are now refused (for example spec 190 D-4 point 6). Spec 190 is staged and reviewed; leave it, and list any stale text under "Noticed, not changed".
- **The `app.json` slug.** Not touched.

## Open questions resolved

Answered in the owner's brief, relayed by the main session on 2026-11-09.

- Q: Which callers are refused, and does the app role matter? → A: Effective Postgres role (`current_user`) in `anon` or `authenticated`. App role does not matter; super_admins and admins are refused too.
- Q: Is an explicit NULL on INSERT allowed? → A: Yes. It means "let the server assign".
- Q: Is an UPDATE that sends `po_number` unchanged refused? → A: No. Only a changed value is refused. Status-only updates (mark ordered, receive RPCs, `send-po-email`) must keep working.
- Q: Which paths keep explicit numbers? → A: `postgres` and `service_role`, on INSERT and UPDATE.
- Q: What does a refused caller see? → A: SQLSTATE `P0001`, message `po_number is server-assigned`.
- Q: Are generated inserts by store members affected? → A: No. They keep working exactly as spec 190 defines.
- Q: Are client, store, edge-function or UI changes, or changes to existing rows, expected? → A: No.
- Q: When does it go to prod? → A: Only with the owner's explicit go-ahead, through the MCP route, after or together with spec 190.

No new question came up while writing this spec.

## Constraints and risks for the design

Listed for the architect; not designed here.

- **SECURITY INVOKER is required.** Inside a SECURITY DEFINER function `current_user` is the owner (`postgres`), so a `current_user` check would always pass. AC-13 and AC-19 pin this.
- **Trigger order against `set_po_number`.** BEFORE triggers fire in name order, and a later trigger sees `NEW` as modified by earlier ones. `set_po_number` fills `NEW.po_number` when it is NULL, so an INSERT guard that sorts after it would refuse every generated insert. AC-14 pins the order.
- **UPDATE test is OLD vs NEW.** Use `IS DISTINCT FROM`, not "the column is in the SET list" (`UPDATE OF po_number` on its own), so a PATCH echoing the same value passes (AC-7) and status-only updates never refuse. If the design uses `UPDATE OF po_number` as a filter, the body must still compare OLD and NEW.
- **SECURITY DEFINER RPCs pass the guard** (they run as `postgres`). Accepted; none writes `po_number` today.
- **Interaction with spec 194's UPDATE triggers.** `purchase_orders_lock_created_at_trg` and `purchase_orders_no_return_to_draft_trg` also fire BEFORE UPDATE. An UPDATE that breaks two rules reports whichever trigger sorts first. No AC depends on a multi-rule update; the design states the resulting order.
- **Spec 097 default privileges.** A new function in `public` is born with EXECUTE for `anon` and `authenticated`. The migration must revoke explicitly (AC-13). Postgres does not check EXECUTE when a trigger fires (spec 177 and spec 190 precedent).
- **`P0001` vs other guards.** Specs 177 and 194 use `42501` for "is immutable". This spec deliberately uses `P0001` per the CLAUDE.md refusal-string convention and the owner's decision; PostgREST returns HTTP 400 rather than 403.
- **No `set role anon` in pgTAP** (spec 067 segfault). See AC-12.
- **Migration slot.** Must sort after spec 190's `20261109140000` and after every migration on disk at build time (currently `20261109195000_user_stores_drop_own_row_writes.sql`). Other sessions are adding migrations; the developer re-checks `ls supabase/migrations | tail` at build time.

## Dependencies

- **Spec 190** (`specs/190-po-number-sequence.md`, `supabase/migrations/20261109140000_po_number_sequence.sql`): staged, not on prod. This spec's generated-insert ACs (AC-5, AC-16) rely on its SECURITY DEFINER trigger and `public.format_po_number`. Prod order: spec 190 first, or both in one apply.
- Spec 190's tests: `supabase/tests/generate_po_number_sequence.test.sql`, `supabase/tests/generate_po_number_malformed_guard.test.sql` (must stay green, AC-17).
- Spec 194 (`20261109170000_kept_records_delete_hardening.sql`, not on prod): adds BEFORE UPDATE triggers on the same table (see risks). No functional dependency.
- Spec 097 (`20260618000000_public_grants_explicit.sql`): the default-privilege pattern behind AC-13.
- CLAUDE.md refusal-string convention (`P0001`, stable byte-for-byte strings; PostgREST maps `P0001` to HTTP 400).
- Prod apply through the Supabase MCP, because `db push` lacks the prod password.

## Project-specific notes

- **Cmd UI section / legacy:** None. Backend-only. No Cmd UI section changes; the admin Cmd UI never sends `po_number`.
- **Which app:** Admin repo. The rule is enforced in the database, so it also binds the staff subtree (`src/screens/staff/`), the Chrome extension and any edge function that forwards a user JWT.
- **Per-store or admin-global:** Admin-global rule applied per row. It applies to every API caller whatever their store or brand scope. Per-store RLS (`auth_can_see_store()`) on `purchase_orders` is unchanged.
- **Edge function or PostgREST:** Neither new. A Postgres trigger on an existing table. No new RPC.
- **Realtime channels touched:** None. No publication change, so the `docker restart supabase_realtime_imr-inventory` step does not apply. Refused writes produce no change events.
- **Migrations needed:** Yes, one (see "Migration slot").
- **Edge functions touched:** None. `send-po-email` updates `status` as `service_role`; `send-order-failure-email` only reads `po_number`.
- **Web/native scope:** Database only, so it covers both. No client build is needed.
- **`app.json` slug:** Not touched.
- **Tests:** Track 2 (pgTAP) required: the new file plus the AC-16 fixture change. Track 1 (jest) full run as no-regression only. No Track 3 smoke.

## Prod apply

Requires the owner's explicit go-ahead. Apply before pushing, or `db-migrations-applied.yml` goes red.

1. Confirm spec 190's `20261109140000` is in prod `supabase_migrations.schema_migrations`, or apply it first in the same session (spec 190's own "Prod apply" steps).
2. Run this spec's migration body through the Supabase MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`.
3. Insert the exact migration version into `supabase_migrations.schema_migrations`.
4. Run the AC-21 checks.
5. After pushing, confirm the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.

Rollback: drop the guard trigger(s) and function. Nothing else depends on them, and no data changes.

## Backend design

(backend-architect, 2026-11-09. Built on spec 190's staged `20261109140000_po_number_sequence.sql` as it is on disk; its open revisions are comment-only and don't affect this design. Spec 194's `20261109170000_kept_records_delete_hardening.sql` is on disk and sorts before this migration, so it is present locally and in CI.)

### D-1. Decision summary

| Decision | Choice | Why |
|---|---|---|
| Shape | **One function, one trigger.** `public.purchase_orders_po_number_guard()` on trigger `purchase_orders_po_number_guard_trg`, `BEFORE INSERT OR UPDATE ... FOR EACH ROW`, **no column list, no `WHEN`** | One name to order, one object to verify on prod. A column list (`UPDATE OF po_number`) would only skip a few comparisons on status-only updates, and it would let a value changed by another BEFORE UPDATE trigger through, because column triggers look at the SET list, not the final row. With no column list the guard sees the final `NEW` on every update. A `WHEN` can't cover both events anyway, because `OLD` doesn't exist on INSERT |
| Name | `purchase_orders_po_number_guard_trg` | Follows the `purchase_orders_*_trg` pattern from specs 177 and 194. In C collation `'p' (0x70) < 's' (0x73)`, so it fires before `set_po_number` on INSERT (D-4) |
| Role test | `current_user not in ('anon', 'authenticated')` means owner path, return early | Owner's decision. Uses the effective role only. It reads no claims and calls no `auth.*` function, so it is not spec 194's rule (out of scope) |
| INSERT rule | `new.po_number is not null` → refuse | R1. An explicit NULL or a missing column passes, and then `set_po_number` assigns |
| UPDATE rule | `new.po_number is distinct from old.po_number` → refuse | R2. A NULL change counts. An echoed value passes |
| Refusal | `raise exception 'po_number is server-assigned' using errcode = 'P0001'`, no DETAIL, no HINT | R4. The text is byte-exact. Spec 190's audit already flagged its own hint text as a Low, so add none |
| Security | `SECURITY INVOKER`, `SET search_path = public`, owner `postgres`, `revoke execute ... from public, anon, authenticated` | D-5 |
| Dependency on 190 | A guard `DO` block at the top of the migration refuses to apply if spec 190's objects are missing | Enforces AC-20's ordering on the MCP route, where a person could apply out of order. Locally and in CI, filename order always satisfies it |

### D-2. Data model: migration `supabase/migrations/20261109200000_po_number_server_assigned.sql`

**Version.** `20261109200000` sorts after `20261109195000_user_stores_drop_own_row_writes.sql`, the newest file on disk at design time, and after spec 190's `20261109140000`. **Developer: run `ls supabase/migrations | tail -5` at build time.** If another session has landed a later version, bump this one to sort after it. The design depends on nothing that comes after 190.

**Additive in schema terms, restrictive in behaviour.** It adds one function, one trigger and comments. No table, column, index, policy, grant (apart from the EXECUTE revoke), data or publication change.

Order of statements. This is a description, not committed SQL. The developer writes the file.

1. Header comment, spec 190/194 style. It covers: what the guard refuses and why (spec 190 security Medium); the SECURITY INVOKER requirement and the reason for it; that the name must sort before `set_po_number`; the P0001 string; the accepted SECURITY DEFINER residual; **no publication change, so NO `docker restart supabase_realtime_imr-inventory` step**; the PROD-APPLY summary pointing at D-11; the ROLLBACK note pointing at D-12; and `Tests: supabase/tests/po_number_server_assigned.test.sql`.
2. `begin;` and `set local lock_timeout = '5s';`. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on `purchase_orders`. On live prod (FILL CART, auto-place), a busy table makes the apply fail cleanly instead of queueing every PO write behind it.
3. **Dependency guard.** A `DO` block that raises if `to_regprocedure('public.format_po_number(bigint)')` is null or `to_regclass('public.purchase_orders_po_number_seq')` is null. The message is `'spec 196 requires spec 190 (20261109140000) to be applied first'` (default errcode P0001). The guard function doesn't use those objects. The check only enforces the owner's ordering (AC-20), the same way spec 194 fails on purpose when 186 is missing.
4. `create or replace function public.purchase_orders_po_number_guard() returns trigger language plpgsql security invoker set search_path = public`. The body is in D-3. Write `security invoker` explicitly, even though it is the default, so the intent shows in `pg_get_functiondef` and in review.
5. `revoke execute on function public.purchase_orders_po_number_guard() from public, anon, authenticated;`. This is mandatory: spec 097's default privileges give new functions ALL for anon, authenticated and service_role, and `CREATE FUNCTION` also grants PUBLIC. Revoke all three in one statement. Project memory records that revoking from `anon` alone does nothing, because anon inherits PUBLIC.
6. `comment on function`. Cover the rule, the exact message, SECURITY INVOKER ("must stay INVOKER: inside a DEFINER function current_user is the owner and every caller would pass"), "reads no claims, calls no functions, reads no tables", the trigger-name ordering requirement and the DEFINER-RPC residual.
7. `drop trigger if exists purchase_orders_po_number_guard_trg on public.purchase_orders;` then `create trigger purchase_orders_po_number_guard_trg before insert or update on public.purchase_orders for each row execute function public.purchase_orders_po_number_guard();`. This is idempotent like specs 177 and 194, so a re-apply is harmless (`create or replace` keeps the ACL, and the revoke re-runs as a no-op).
8. `comment on trigger purchase_orders_po_number_guard_trg on public.purchase_orders is '...'`. The comment must say: "Name must sort before set_po_number (C collation). BEFORE triggers fire in name order and set_po_number fills NEW.po_number, so a guard sorting after it refuses every generated insert. Pinned by po_number_server_assigned.test.sql."
9. `commit;`

Spec 190's objects (`generate_po_number()`, `format_po_number(bigint)`, the sequence, `set_po_number` and its `WHEN`) are **not touched** (R5, AC-15).

### D-3. Guard body (pseudocode, not committed SQL)

```
-- 0. Wiring check, fail closed (spec 194 "bad trigger argument" precedent).
--    A BEFORE DELETE attachment would otherwise return NEW (NULL) and silently
--    skip deletes; a STATEMENT-level attachment has no NEW.
if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op not in ('INSERT', 'UPDATE') then
  raise exception 'purchase_orders_po_number_guard: bad trigger wiring' using errcode = 'P0001';
end if;

-- 1. Owner paths: anything that is not a PostgREST client role
--    (postgres, service_role, pg_cron jobs, migrations, SQL editor, MCP).
--    Write the role list as this one literal; the AC-12 arm pins it.
if current_user not in ('anon', 'authenticated') then
  return new;
end if;

-- 2. Client roles.
if tg_op = 'INSERT' then
  if new.po_number is not null then
    raise exception 'po_number is server-assigned' using errcode = 'P0001';
  end if;
elsif new.po_number is distinct from old.po_number then
  raise exception 'po_number is server-assigned' using errcode = 'P0001';
end if;

return new;
```

Rules for the body:
- **No function calls apart from built-in keywords** (`current_user` is a SQL keyword). No `auth.uid()`, no `auth_is_privileged()`, no `current_setting('request.jwt…')`, no table reads. Two reasons. (a) In an INVOKER function every function it calls checks EXECUTE against the caller, so there is nothing the caller would need to be granted. (b) R3 then holds by construction: the guard can't depend on the claims because it never reads them. AC-12 also pins that the body contains no `jwt` and no `auth.`.
- The wiring check runs before the role check, so a miswired trigger fails for every caller, `postgres` included. Its message is different from the refusal string, so no `throws_ok` can confuse the two.
- On INSERT `NEW` is the caller's proposed row, because the guard fires first (D-4). On UPDATE `NEW` is the row after every earlier BEFORE UPDATE trigger. None of those triggers touches `po_number` today. If a future one did while running under a client role, the guard would refuse it, which is fail-closed and correct.
- **Bulk statements.** A row-level BEFORE trigger that raises aborts the whole statement, so AC-2 and AC-4 come from Postgres statement atomicity. In a mixed multi-row INSERT, the NULL rows before the explicit row have already passed through `set_po_number` and called `nextval()` before the explicit row is refused. Those numbers are burned (gaps, which spec 190 accepts). Nothing writes them, and no AC asserts the sequence there.
- **Upserts** (`INSERT ... ON CONFLICT DO UPDATE`, PostgREST `resolution=merge-duplicates`): the INSERT branch runs first on the proposed row and refuses a non-NULL value. On conflict, the UPDATE branch compares the existing row with the SET result. No client upserts `purchase_orders` today. This is covered by the same two rules, so it needs no arm.

**Why SECURITY INVOKER is load-bearing.** In a SECURITY DEFINER function, `current_user` is the function owner (`postgres`), so the role test would always take the owner branch and refuse nobody. In an INVOKER function, `current_user` is the role running the triggering statement: `authenticated` or `anon` for PostgREST (PostgREST connects as `authenticator` and switches with `SET ROLE` on each request), `service_role` for the service key, and `postgres` for migrations, cron and MCP. The `SET search_path` clause in `proconfig` doesn't change `current_user`. Only `SECURITY DEFINER` does.

### D-4. Trigger order on `public.purchase_orders` after this migration

BEFORE triggers for the same event fire in name order. Postgres sorts trigger names byte-wise, which is C collation. Each one gets the `NEW` the one before it returned, and a `WHEN` is evaluated against that modified `NEW` too. A column-specific trigger (`UPDATE OF x`) only fires when `x` is in the SET target list. Internal RI triggers (`tgisinternal`) are AFTER triggers and don't matter here.

**BEFORE INSERT, row** (fire order):

| # | Trigger | Spec | Filter |
|---|---|---|---|
| 1 | `purchase_orders_po_number_guard_trg` | **196** | none |
| 2 | `set_po_number` | init + 190 | `WHEN (new.po_number IS NULL)` |

The guard sees the caller's `po_number` before `set_po_number` fills it. A guard that sorted after it would see every generated row as non-NULL and refuse it (AC-19 mutation 3).

**BEFORE UPDATE, row** (fire order; specs 177 and 194 present, as on disk):

| # | Trigger | Spec | Filter | Refusal |
|---|---|---|---|---|
| 1 | `purchase_orders_lock_created_at_trg` | 194 | `OF created_at` | 42501 `purchase_orders: created_at is immutable` (claims-aware exemption) |
| 2 | `purchase_orders_lock_store_id_trg` | 177 | `OF store_id` | 42501 `purchase_orders: store_id is immutable` |
| 3 | `purchase_orders_no_return_to_draft_trg` | 194 | `OF status` | 42501 `purchase_orders: status cannot return to draft` |
| 4 | `purchase_orders_po_number_guard_trg` | **196** | none | P0001 `po_number is server-assigned` |

Check (C collation): `purchase_orders_lock_c…` < `purchase_orders_lock_s…` (`c` < `s`) < `purchase_orders_no_…` (`l` < `n`) < `purchase_orders_po_…` (`n` < `p`).

**AFTER INSERT OR UPDATE:** `notify_purchase_order`. A refused row never reaches it.

**Full `pg_trigger` listing** (non-internal, `order by tgname collate "C"`), used in the AC-21 comparison: `notify_purchase_order`, `purchase_orders_lock_created_at_trg`, `purchase_orders_lock_store_id_trg`, `purchase_orders_no_return_to_draft_trg`, `purchase_orders_po_number_guard_trg`, `set_po_number`. On a prod that doesn't have spec 194 yet, the two 194 rows are missing. Nothing in this design depends on them.

**Updates that break more than one rule.** The guard fires last on UPDATE, so an update that also breaks a 177 or 194 rule reports that trigger's 42501 (for example, a staff PATCH changing both `store_id` and `po_number` gets `purchase_orders: store_id is immutable`). Either way the statement is refused. No AC depends on which message wins.

**BEFORE triggers run before RLS `WITH CHECK`.** Postgres runs BEFORE ROW triggers before it checks the RLS insert policy. So a client that inserts an explicit number into a store it can't see gets this guard's P0001, not the RLS 42501. That leaks nothing: the result depends only on the caller's own `NEW` and its role. On UPDATE, RLS `USING` filters rows before any trigger runs, so a row the caller can't see is never reached (0 rows). The test plan accounts for this in its anti-vacuity arms (D-10).

### D-5. Security and privileges

- **The Medium is closed.** A client role has three ways to put a number ahead of the sequence: an explicit INSERT, an UPDATE onto a number, and the INSERT branch of an upsert. All three are refused. A client can still use up numbers: by generated inserts (in order, never ahead), insert-then-delete inside spec 186's window, the NULL rows of a refused mixed statement, or an RLS-refused insert (which runs `set_po_number` before `WITH CHECK`). All of these only leave gaps. Gaps never cause a `54000`. Only taken numbers ahead of the sequence do.
- **EXECUTE revoke and firing.** Postgres checks EXECUTE on a trigger function once, at `CREATE TRIGGER` time, for the role that creates the trigger (`postgres`, which owns the function). It does not check when the trigger fires. The precedents are specs 177, 190 and 194, whose revoked trigger functions already fire in CI. In this suite, AC-5, AC-6, AC-7 and AC-16 (successful client writes through the trigger) and AC-1 to AC-4 (refusals raised by the body) prove at runtime that the revoke doesn't stop it firing. The function can't be called over `/rpc` either way (a `returns trigger` function fails with `0A000`, and PostgREST hides trigger functions).
- **NULL `proacl` trap.** A NULL `proacl` means the default ACL, which includes PUBLIC EXECUTE. After the revoke, `proacl` is non-NULL. The AC-13 and AC-21 `has_function_privilege` checks cover this. The AC-21 string check on `proacl` must treat a NULL `proacl` as a failure.
- **`service_role` keeps the spec 097 default EXECUTE.** This is harmless (not callable, `0A000`) and consistent with spec 190 D-4. AC-13 doesn't check it.
- **Accepted residual: SECURITY DEFINER RPCs.** A statement inside a `postgres`-owned DEFINER function runs with `current_user = postgres` and passes. A grep of `supabase/migrations/` (2026-11-09) finds `po_number` written only by spec 190's own DEFINER trigger, so no RPC writes it. **A future RPC that writes `po_number` must be reviewed against this rule.** The function comment says so.
- **No new oracle.** The refusal depends only on the caller's own `OLD`/`NEW` and `current_user`. The guard reads no table.
- **Correction to AC-12's wording (no ask, it doesn't change the design).** AC-12 says "`anon` has no INSERT/UPDATE policy on `purchase_orders`". More precisely: the four `store_member_*` policies (`20260504173035_per_store_rls_hardening.sql:186-200`) have no `TO` clause, so they apply to `anon` as well. Spec 097 also grants `anon` INSERT/UPDATE on the table. What stops `anon` is that `auth_can_see_store(store_id)` (`20260517040000_auth_can_see_store_brand_scope.sql:88`) is false when there is no `auth.uid()` and no privileged claims. The defence-in-depth claim still holds. Only the reason is different.
- **Roles that are members of `authenticated`.** A custom role that inherits `authenticated` would have its own `current_user` and would pass. None exists. The owner chose an exact `current_user` match, and this note records the edge case.

### D-6. RLS impact

None. No policy is added, dropped or altered on any table. `permissive_policy_lint.test.sql` is unaffected and needs no allowlist row. `public_grants_explicit.test.sql` only checks table grants, so it is unaffected. Per-store RLS on `purchase_orders` (`auth_can_see_store`) still decides **which rows** a caller can write. The guard decides **which values** a client role may put in one column.

### D-7. API contract

Unchanged. Clients keep inserting and patching `purchase_orders` through PostgREST without `po_number`. No new RPC or view. The only new error a client could see is P0001 `po_number is server-assigned`, which PostgREST returns as **HTTP 400** with `{"code":"P0001","message":"po_number is server-assigned"}`. Only a request that sends a non-NULL or changed `po_number` can trigger it, and no current client, extension or edge function does (audit table above). `src/utils/usFoodsImport.ts:56` `poNumber` is a CSV export header field and never written to the database.

**Old installed builds.** Spec 190 D-8 records that the client has never mapped `po_number`, so older native/EAS builds and older extension installs don't send it either. Low risk, noted for completeness.

### D-8. Edge functions

None new or modified. `verify_jwt` settings in `supabase/config.toml` are unchanged. `send-po-email` writes `status` as `service_role`, which is the owner path, so the guard is skipped. `send-order-failure-email` only reads `po_number`. Any future edge function that forwards a user JWT and writes `po_number` will be refused, which is intended.

### D-9. `src/lib/db.ts`, `src/store/useStore.ts`, realtime

- **`db.ts`:** no new helper and no mapping change (`po_number` is still not mapped on the client).
- **Store:** no slice change. The existing optimistic-then-revert plus `notifyBackendError` around PO writes would show the P0001 message if a future bug sent `po_number`. Nothing needs editing.
- **Realtime:** no publication change. Refused writes produce no change events. Allowed writes publish on `store-{id}` as before. **The `docker restart supabase_realtime_imr-inventory` step does not apply.**
- **Edge-runtime bind-mount:** not relevant (no function change).

### D-10. Tests (exact plan)

#### New file `supabase/tests/po_number_server_assigned.test.sql` (Track 2)

Hermetic (`begin; … rollback;`). Fixture uuid prefix `b196…`, for example `b1960001-…` brands, `b1960002-…` stores, `b1960003-…` users, `b1960004-…` POs, `b1960005-…` po_items and items. Copy these helpers:
- From `generate_po_number_sequence.test.sql:56-93`: `pg_temp.login(uid, app_role)`, `pg_temp.seq_next()`, `pg_temp.po(id)`.
- From `kept_records_delete_hardening.test.sql:82-93`: `pg_temp.try_sql(sql)`, which returns `'ok:<rowcount>'` or the SQLSTATE.
- Fixture shape (brand, stores, `auth.users` with `''` token columns, `profiles` upsert, `user_stores`) from `generate_po_number_sequence.test.sql:229-258`.
- The receive fixture (item in the store, one `po_items` line, `receive_purchase_order` call) from `kept_records_delete_hardening.test.sql:466-471`.

**House rules for this file:**
- Every refusal arm uses `throws_ok(sql, 'P0001', 'po_number is server-assigned', '<desc>')`. The message pin means an RLS refusal (42501) or a spec 177/194 refusal can't pass as this guard.
- Every allowed-UPDATE arm uses `is(pg_temp.try_sql(...), 'ok:1', ...)`, not bare `lives_ok`. An UPDATE that matches 0 rows (RLS, or a wrong `where status = 'draft'`) would otherwise pass without proving anything.
- Read sequence state and call `public.format_po_number` **only as postgres** (authenticated has neither privilege after spec 190). Prepare every literal a client arm needs as postgres and pass it in a GUC (`set_config('test.x', …, true)`) that the client block reads with `current_setting`.
- **Sequence rule.** Every explicit number this file writes or tries is `format_po_number(seq_next() + 10000 + k)`, computed once as postgres after the fixtures are in. `k` is a distinct small offset per arm. That keeps every explicit value far ahead of the ~15 numbers this file generates, so no arm reaches spec 190's skip loop. The file never calls `setval`.
- **Role switches.** `set local role authenticated` plus `pg_temp.login(...)`. `set local role service_role` plus `set_config('request.jwt.claims', '{"role":"service_role"}', true)` (the spec 194 shape). For postgres, `reset role` plus `set_config('request.jwt.claims', '', true)`, except in the AC-11 block, which deliberately leaves the staff claims in place. **No `set role anon` anywhere** (spec 067).
- **Read-back rule.** Every "was written / not written / unchanged" claim is checked as postgres, in a later block, by fixture id.

**Fixtures (as postgres):** one fresh brand B and one store S in it. Three users: staff (`profiles.role='user'`, member of S via `user_stores`, claims `app_role='user'`), admin (`profiles.role='admin'`, `brand_id = B`, claims `app_role='admin'`), and super_admin (`profiles.role='super_admin'`, claims `app_role='super_admin'`; copy the shape from `auth_can_see_store_brand_scope.test.sql`). One inventory item in S. Draft POs P1 to P13 in S are inserted **with `po_number` omitted** (generated). P11 also gets one `po_items` line on the item and is then moved to `status='sent'` as postgres. Store each fixture PO's generated number in a GUC (`test.orig_P<n>`) for the read-backs.

**Block order and arms.** Approximate count 60. The developer sets `plan(N)` to the exact total.

| Block | Arms |
|---|---|
| **A. Catalog (postgres, before fixtures)** | **AC-13** (6): `prosecdef = false`; `proconfig = array['search_path=public']`; `pg_get_userbyid(proowner) = 'postgres'`; `not has_function_privilege(r, 'public.purchase_orders_po_number_guard()', 'EXECUTE')` for each `r` in `public`, `anon`, `authenticated`. **AC-12** (3): `prosrc ~* $re$current_user\s+not\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*\)$re$`, which pins that `anon` is in the refused list in the one role test; and two arms asserting `prosrc` does not match `jwt` and does not match `auth\.` (case-insensitive), which pin that the body reads no claims and calls no `auth.*` (R3 by construction). **AC-14** (7): one `pg_trigger` row for `(tgrelid='public.purchase_orders'::regclass, tgname='purchase_orders_po_number_guard_trg')` with `tgenabled = 'O'`; `tgtype = 23` (ROW 1 + BEFORE 2 + INSERT 4 + UPDATE 16, so not DELETE or TRUNCATE); `tgattr` empty (no column list, e.g. `cardinality(tgattr::int2[]) = 0`); `tgqual is null` (no `WHEN`); `tgfoid = 'public.purchase_orders_po_number_guard()'::regprocedure`; `'purchase_orders_po_number_guard_trg' collate "C" < 'set_po_number' collate "C"`; and **the guard is the first BEFORE ROW INSERT trigger**: `select tgname from pg_trigger where tgrelid = … and not tgisinternal and tgtype & 7 = 7 order by tgname collate "C" limit 1` returns the guard's name. This tripwire catches a future BEFORE INSERT trigger that sorts ahead of the guard. **AC-15** (3): `generate_po_number()` keeps `prosecdef = true` and `proconfig = array['search_path=public']`; `pg_get_triggerdef` of `set_po_number` matches `ilike '%when ((new.po_number is null))%'` |
| **B. Fixtures (postgres)** | As above. Compute the explicit-number GUCs last |
| **C. Staff (authenticated)** | **AC-1 staff** (throws_ok, explicit `id` + `test.n_ins_staff`). **AC-2** (2 throws_ok): (a) 3 rows, all explicit; (b) 3 rows, two with `po_number` omitted or NULL and **the explicit row LAST**, so the read-back shows that rows which had already passed both triggers were rolled back as well. **AC-3 staff** (2 throws_ok): P1 `set po_number = <test.n_upd_staff>`; P3 `set po_number = null`. **AC-4** (throws_ok): one `update … set po_number = case id when P4 then <n_a> when P5 then <n_b> end where id in (P4, P5)`. **AC-6** (3 × `try_sql = 'ok:1'`): P6 `set status='sent'`; P7 `set status='sent' where id = P7 and status = 'draft'`; P8 `set total_cost = 42`. **AC-7** (2 × `try_sql = 'ok:1'`): P9 `set po_number = po_number`; P10 `set po_number = '<test.orig_P10>', status = 'sent'`. **AC-8** (1): `is(try_sql('select public.receive_purchase_order(P11, <one line, received_qty = ordered_qty>, <uuid>)'), 'ok:1')`. `receive_purchase_order` is `SECURITY INVOKER` (`20260707000000_staff_receiving_price_gate.sql:120`), so its UPDATE (`:351`) really runs as `authenticated` and goes through the client branch of the guard. **AC-5 staff** (2 lives_ok, each preceded by `reset role` → stash `format_po_number(seq_next())` in a GUC → re-enter staff): omit `po_number`; `po_number = null` |
| **D. Admin (authenticated)** | Anti-vacuity first: `ok(auth_can_see_store(S))`. **AC-1 admin** (throws_ok). **AC-3 admin** (throws_ok, P2). **AC-5 admin** (2 lives_ok, same stash pattern) |
| **E. Super_admin (authenticated)** | Anti-vacuity: `ok(auth_can_see_store(S))`. **AC-1 super_admin** (throws_ok). These anti-vacuity arms matter because a BEFORE trigger fires before RLS `WITH CHECK` (D-4), so a refusal arm alone can't prove the caller could otherwise write |
| **F. service_role** | **AC-9 sr** (lives_ok, explicit `test.n_sr_ins`). **AC-10 sr** (`try_sql = 'ok:1'`, P13 `set po_number = <test.n_sr_upd>`) |
| **G. postgres, claims cleared** | **AC-9 pg** (lives_ok, explicit `test.n_pg_ins`). **AC-10 pg** (`try_sql = 'ok:1'`, P12 `set po_number = <test.n_pg_upd>`) |
| **H. postgres with stale staff claims** | `set local role authenticated; select pg_temp.login(staff, 'user'); reset role;` Anti-vacuity: `is(current_user::text, 'postgres')` and `is(current_setting('request.jwt.claims')::jsonb ->> 'sub', '<staff uid>')`. **AC-11** (lives_ok, explicit `test.n_stale`) |
| **I. Read-back (postgres, claims cleared)** | **AC-1**: `count(*) = 0` for the three fixture ids, and `count(*) = 0` for the three attempted numbers. **AC-2**: `count(*) = 0` over all six fixture ids of both statements. **AC-3**: P1, P2, P3 numbers equal `test.orig_P1/2/3` (one `is(format(...), 'a=t b=t c=t')`). **AC-4**: P4 and P5 unchanged. **AC-5**: each of the four rows `is(po, <its stashed expected>)`, plus one `ok(all four match '^PO-[0-9]{3,}$')`. **AC-6**: P6 and P7 `status='sent'`, P8 `total_cost=42`, all three `po_number` unchanged. **AC-7**: P9 unchanged; P10 unchanged and `status='sent'`. **AC-8**: P11 `status='received'` and `po_number` unchanged. **AC-9**: both rows keep their explicit values. **AC-10**: P12 and P13 read back with their new values. **AC-11**: the row keeps its explicit value |

**AC-5 expected values.** The expectation is "the next sequence value read as postgres just before the insert". It is reliable because nothing else in this transaction takes numbers between the stash and the insert, and the explicit numbers sit ≥ 10000 ahead, so the skip loop can't fire. Don't derive it from the fixture POs' numbers.

**AC-12 evidence summary.** Runtime arms prove the mechanism for `authenticated`, which is a member of the same literal list. The `prosrc` arm proves `anon` is in that list. `has_function_privilege('anon', …)` (AC-13) covers the privilege side. This is the catalog/body route AC-12 allows. A runtime `anon` arm is ruled out (spec 067).

#### AC-16: `supabase/tests/report_run_variance_formula.test.sql`

- L155: remove `, po_number` from the column list. L161-162: remove the `'SPEC023-A2-' || gen_random_uuid()::text` value and the trailing comma after the `'2026-05-02'::date` line.
- Rewrite the comment at L147-151 to say: `po_number` is omitted because it is server-assigned (spec 196). This block runs as `authenticated` (`set local role` at L92), and a client role can't supply one (P0001 `po_number is server-assigned`). The `set_po_number` trigger assigns the number. Since spec 190 it is SECURITY DEFINER, so RLS doesn't affect it. Numbering is unrelated to this test, and its coverage is in `generate_po_number_sequence.test.sql`, `generate_po_number_malformed_guard.test.sql` and `po_number_server_assigned.test.sql`.
- `plan(7)` and all seven assertions stay as they are. Nothing in the file reads `po_number` (grep: the only `SPEC023` hit is L162).

#### AC-17 / AC-18

No other file needs a change. A grep of `supabase/tests/`, `e2e/`, `scripts/` and `supabase/functions/` on 2026-11-09 finds `po_number` written only in the four files the spec lists, and the three besides the variance file run as postgres. `generate_po_number_sequence.test.sql:437` is a postgres insert with stale claims from earlier `login` calls. Under this design it passes, because the rule ignores claims. Under spec 194's rule it would not, and that is one reason the owner chose `current_user`. Run `scripts/test-db.sh` (whole suite), `npx jest` and `npm run typecheck:test`. If any other file fails, explain it in the implementation notes. Do not re-pin it quietly.

#### AC-19: mutation table (try each by hand in a scratch transaction, record the result)

Add one row to the spec's table:

| Temporary change | Arms that must fail |
|---|---|
| `'anon'` removed from the role list | AC-12 (`prosrc` arm) |

Also expect these extra failures from the spec's own rows: "made SECURITY DEFINER" also fails AC-13 `prosecdef` and AC-2/AC-4. "Renamed after `set_po_number`" also fails the AC-14 first-BEFORE-INSERT arm and `report_run_variance_formula` (its generated insert as `authenticated` is refused). The "SET list" row is best done as `before insert or update of po_number` plus a body that refuses any UPDATE. It fails AC-7 and the AC-14 `tgattr` arm.

### D-11. Prod apply (owner go-ahead required; the architect does not touch prod)

Follows project memory "Prod migration via Supabase MCP", project `ebwnovzzkwhsdxkpyjka`, and comes **after** spec 190's apply (spec 190 "Prod apply" plus D-9).

**Step 0. Spec 190 first.** `select version from supabase_migrations.schema_migrations where version in ('20261109140000', '<this version>');`
- If `20261109140000` is missing, run spec 190's D-9 runbook completely (pre-checks, apply, version row, its verification) in this session first. Use **separate** `execute_sql` calls for 190 and 196, and finish 190's verification (its `last_value` check assumes no unexplained PO writes) before step 1 here.
- If this spec's version is already present, STOP: it has been applied before.

**Step 1. Read-only pre-checks** (STOP on anything unexpected):
- `select current_user;` returns `postgres`. The function owner must be `postgres` (AC-21).
- `select to_regprocedure('public.format_po_number(bigint)') is not null, to_regclass('public.purchase_orders_po_number_seq') is not null;` returns `t, t`. The migration's own dependency guard checks the same thing, but the pre-check is easier to read.
- `select to_regprocedure('public.purchase_orders_po_number_guard()');` returns null.
- Record the current trigger listing: `select tgname, tgenabled, tgtype, tgattr::text, tgqual is null as no_when, tgfoid::regprocedure from pg_trigger where tgrelid = 'public.purchase_orders'::regclass and not tgisinternal order by tgname collate "C";`. Expect no guard row.
- **Bypass check: no prod-only object can write `po_number` past the guard** (security review Low #1). D-5 bases the accepted SECURITY DEFINER residual on the repo. This checks prod for DEFINER functions, views or rules created outside migrations (for example in the dashboard SQL editor). Run all three on prod and locally and compare:
  ```sql
  -- (a) SECURITY DEFINER functions that mention purchase_orders
  select n.nspname || '.' || p.proname as fn, p.prosrc ~* 'po_number' as mentions_po_number
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and p.prosrc ~* 'purchase_orders'
     and n.nspname not in ('pg_catalog', 'information_schema')
   order by 1;
  -- (b) views over purchase_orders (expect 0)
  select count(distinct r.ev_class)
    from pg_rewrite r
    join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
   where d.refobjid = 'public.purchase_orders'::regclass
     and r.ev_class <> 'public.purchase_orders'::regclass;
  -- (c) rules on purchase_orders itself (expect 0)
  select count(*) from pg_rewrite where ev_class = 'public.purchase_orders'::regclass;
  ```
  Local result on 2026-11-09: (a) lists `auto_receive_due_purchase_orders`, `generate_po_number`, `preview_brand_cascade`, `record_missed_orders_for_day` and `record_vendor_order_attempt`, and only `generate_po_number` has `mentions_po_number = t`. (b) and (c) return 0. **STOP** if any row other than `public.generate_po_number` has `mentions_po_number = t`, or if (b) or (c) is non-zero. Read the source of that object before going on, because it could write `po_number` as `postgres` and reopen the spec 190 Medium. A prod-only DEFINER function that mentions `purchase_orders` but not `po_number` is not a STOP, but note it as dashboard drift.

**Step 2. Apply.** Send the **committed migration file verbatim**, including its `begin; set local lock_timeout …; commit;` wrapper, in **one** `execute_sql` call. **Never send a `pg_get_functiondef` dump**: this is a trigger migration, and a dump has no `CREATE TRIGGER`, revoke or comments (spec 177 trap in project memory). **Never use `apply_migration`** (it writes its own version and turns `db-migrations-applied.yml` red). If the call fails with `55P03` (lock timeout because FILL CART or auto-place is busy), retry. Nothing was applied.

**Step 3. Record the version.** `insert into supabase_migrations.schema_migrations (version, name, statements) values ('<this version>', 'po_number_server_assigned', '{}');`. A plain insert, so recording twice fails loudly. Optionally, as in spec 190's M-3 runbook note, paste it just before the final `commit;` in the text sent in step 2 so the body and its version row commit together. That changes only the text sent, not the file or any function body.

**Step 4. Verify (AC-21). Insert and update no PO.**
- Normalized md5 matches local. Run on both sides: `select md5(lower(regexp_replace(regexp_replace(pg_get_functiondef('public.purchase_orders_po_number_guard()'::regprocedure), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')));` (local through `docker exec supabase_db_imr-inventory psql -At -c …`).
- `select prosecdef, proconfig, pg_get_userbyid(proowner), proacl from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure;` returns `f`, `{search_path=public}`, `postgres`, and a **non-NULL** `proacl` with no element starting with `anon=`, `authenticated=` or `=` (PUBLIC).
- `select r, has_function_privilege(r, 'public.purchase_orders_po_number_guard()', 'EXECUTE') from unnest(array['public', 'anon', 'authenticated']) r;` returns false for all three.
- Re-run the step 1 trigger listing. It now contains `purchase_orders_po_number_guard_trg | O | 23 | (empty) | t | purchase_orders_po_number_guard()` in the position D-4 gives. Compare it row by row with the same query run locally (equal once every on-disk migration is on prod. Before that, the only allowed difference is the missing spec 194 rows).
- AC-15 on prod: `generate_po_number()` normalized md5 still equals the value recorded at spec 190's verification, and `pg_get_triggerdef` of `set_po_number` still contains `WHEN ((new.po_number IS NULL))`.
- No live negative probe. AC-21 forbids writing a PO, and the local suite covers behaviour.

**Step 5. Push and CI.** Push only after step 3 is confirmed (`select version … where version = '<this version>'`), to avoid the push-before-apply false red (project memory, spec 121). Then confirm the latest `main` runs of `test.yml` **and** `db-migrations-applied.yml` are green, and check `e2e.yml` by hand (AC-22). The drift gate fails on **any** on-disk migration missing from prod (for example spec 194's `20261109170000` and `20261109195000`), so those must be on prod before the push whoever owns them. This design doesn't change that.

### D-12. Rollback

Forward-only by convention. If it is needed (owner decision, because it reopens spec 190's security Medium), hand-run `drop trigger if exists purchase_orders_po_number_guard_trg on public.purchase_orders;` and `drop function if exists public.purchase_orders_po_number_guard();`. Nothing else references them, no data changes, and spec 190's objects are unaffected. Leave the `schema_migrations` row (the file stays in the repo), or add a forward migration that drops both, so the drift gate stays consistent.

### D-13. Risks and tradeoffs

1. **Trigger-name drift.** A future rename, or a new BEFORE INSERT trigger that sorts ahead of the guard and sets `po_number`, would break the guarantee. The AC-14 first-BEFORE-INSERT arm and the trigger comment make this deliberate and visible. A harmless new trigger that sorts first will also trip the arm. That is intended, and the fix is a one-line update after review.
2. **A future column DEFAULT on `po_number`** (for example `default format_po_number(nextval(...))`) would make every client insert carry a non-NULL value into the guard and be refused. Spec 190 added no default (`20260704000000_po_loop.sql:36` confirms none). Any spec that adds one must change the guard. This is noted in the function comment.
3. **DEFINER residual** (D-5). Accepted by the owner. Nothing writes `po_number` from a DEFINER function today.
4. **Burned numbers.** Refused mixed inserts and RLS-refused inserts use up sequence values. Gaps are accepted (spec 190), and gaps can't cause `54000`.
5. **Performance.** O(1) per row: two comparisons, no queries, on every INSERT/UPDATE of `purchase_orders` (prod had 4 PO rows on 2026-11-09, per spec 190's pre-check). A 100×K-row attack body is refused at its first explicit row. The 286 KB seed loads as postgres, sets no `po_number`, and is unaffected.
6. **Lock on apply.** CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock. `lock_timeout = '5s'` turns contention into a clean retry (D-11 step 2).
7. **Edge-function cold start:** not applicable (no function change).
8. **Migration ordering.** Concurrent sessions are adding migrations. Re-check the slot at build time (D-2). The dependency guard makes an out-of-order prod apply fail loudly instead of quietly breaking AC-20.
9. **P0001 vs 42501.** P0001 differs from the 177/194 "is immutable" guards on purpose (owner, CLAUDE.md refusal-string convention). Clients get HTTP 400, not 403.

### D-14. Noticed, not changed (out of scope by the spec)

- `specs/190-po-number-sequence.md` D-4 point 6 ("A store member can already INSERT with an explicit `po_number`…") is stale once this lands. Leave it.
- `supabase/tests/retention_prune_job.test.sql:259` still says `generate_po_number()` is SECURITY INVOKER, which has been stale since spec 190. That cleanup belongs to spec 190 D-6, not here.
- AC-12's "anon has no INSERT/UPDATE policy" wording (D-5). The design evidence doesn't depend on it.

### D-15. Files expected to change

- `supabase/migrations/20261109200000_po_number_server_assigned.sql` (new; re-check the version at build time)
- `supabase/tests/po_number_server_assigned.test.sql` (new)
- `supabase/tests/report_run_variance_formula.test.sql` (AC-16 fixture and comment)
- This spec (implementation notes, AC-19 results, `## Files changed`, `Status: READY_FOR_REVIEW`)

No change to `src/`, `extension/`, `supabase/functions/`, `supabase/config.toml`, `seed.sql`, `e2e/` or `app.json`.

## Handoff
next_agent: backend-developer
prompt: Implement against the design in this spec (D-2 migration, D-3 guard body, D-10 test plan and AC-16 fixture change). Re-check `ls supabase/migrations | tail -5` and bump the version if needed. Do not apply to prod. D-11 is gated on the owner's explicit go-ahead and runs after spec 190's apply. Record the AC-19 mutation results in the implementation notes. After implementation, set Status: READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/196-po-number-server-assigned.md

## Implementation notes (backend-developer, 2026-11-09)

**Migration slot.** `ls supabase/migrations | tail -5` at build time showed `20261109195000_user_stores_drop_own_row_writes.sql` as the newest file, so the designed version `20261109200000` was free and is used unchanged (re-checked again after the suite run; still last). The prod `schema_migrations` insert (D-11 step 3) uses `20261109200000` / `po_number_server_assigned`.

**Migration** `supabase/migrations/20261109200000_po_number_server_assigned.sql` follows D-2 statement for statement: header (rule, INVOKER and name-order requirements, P0001 string, DEFINER residual, no-realtime-restart note, PROD-APPLY pointer to D-11, ROLLBACK SQL from D-12, test path); `begin;` + `set local lock_timeout = '5s'`; the spec 190 dependency `DO` block with the exact message; the function (D-3 body verbatim: wiring check, `current_user not in ('anon', 'authenticated')` early return, INSERT / UPDATE rules, no DETAIL or HINT); `revoke execute ... from public, anon, authenticated`; function comment; idempotent drop/create of `purchase_orders_po_number_guard_trg` (`before insert or update`, `for each row`, no column list, no `WHEN`); trigger comment; `commit;`. Spec 190's and spec 194's files are not edited.

**Local apply.** The stack was already up. Applied with `docker exec -i supabase_db_imr-inventory psql -U postgres -v ON_ERROR_STOP=1 < <migration>` and recorded `('20261109200000', 'po_number_server_assigned', '{}')` in local `supabase_migrations.schema_migrations`, the same way specs 190 and 194 did. Catalog after apply: `prosecdef f`, `proconfig {search_path=public}`, owner `postgres`, `proacl {postgres=X/postgres,service_role=X/postgres}` (no `anon=`, `authenticated=` or `=` entry). Trigger listing (`order by tgname collate "C"`): `notify_purchase_order` 21, `purchase_orders_lock_created_at_trg` 19 `{11}`, `purchase_orders_lock_store_id_trg` 19 `{2}`, `purchase_orders_no_return_to_draft_trg` 19 `{8}`, `purchase_orders_po_number_guard_trg` 23 (empty `tgattr`, no `WHEN`), `set_po_number` 7 (`WHEN`). This matches D-4. **Local normalized md5 of the guard (D-11 step 4 query): `f64474e39f32bb6b2a8c90995295b9eb`.** No publication change, so no realtime restart. Prod untouched (no MCP calls).

**New pgTAP** `supabase/tests/po_number_server_assigned.test.sql`, `plan(68)`, blocks A-I as D-10 lays out. Small points:
- Count: A 19 (AC-13 6, AC-12 3, AC-14 7, AC-15 3); C 14; D 5; E 2; F 2; G 2; H 3; I 21. The design estimated about 60. The AC-6 read-back is three arms (one per PO), not one.
- The `b1960005` prefix carries the catalog ingredient (`…01`), the inventory item (`…02`) and the P11 `po_items` line (`…03`), via a `pg_temp.fid(n)` helper.
- The AC-3/AC-4 read-backs compare `format('a=%s …', bool, …)` against `'a=t b=t c=t'` (Postgres formats a boolean as `t`), which is the string D-10 gives.
- Before the AC-16 edit, `report_run_variance_formula.test.sql` failed with `ERROR: po_number is server-assigned` at its PO insert, which confirms the fixture had to change.

**AC-16.** In `report_run_variance_formula.test.sql`, `po_number` is gone from the column list and the `'SPEC023-A2-' || gen_random_uuid()::text` value is removed. The comment is rewritten as D-10 asks. `plan(7)` and the seven assertions are unchanged, and all 7 pass. Note for staging: this file already had a staged (index) change from an earlier session (the spec 190 comment text). The spec 196 edit sits on top as an unstaged working-tree change (`git status` shows `MM`).

**Test results (local, 2026-11-09).**
- `scripts/test-db.sh` (whole suite): **103/103 files passed, 0 failed**, including `po_number_server_assigned` (68), `report_run_variance_formula` (7), `generate_po_number_sequence` (57), `generate_po_number_malformed_guard` (8), `kept_records_delete_hardening`, `retention_prune_job`, `po_loop`, `extension_ordering`, `submission_notifications`, `cross_store_item_rejection` and `permissive_policy_lint`. No existing file other than the AC-16 one needed a change.
- `npx jest`: 301 suites / 3836 tests passed. `npm run typecheck:test`: clean. No TypeScript change.

**AC-19 mutation results.** Each mutation ran in one psql session as `begin; <mutation>; <test file>`, so the file's own `rollback` undid both. Afterwards the catalog showed the guard trigger at `tgtype 23` with an empty `tgattr` and `prosecdef f`, and a clean re-run of the file passed 68/68.

| Temporary change | Result (arms that failed) |
|---|---|
| Guard trigger dropped | 20 of 68 failed: AC-1 (staff, admin, super_admin) + read-backs, AC-2 (a, b) + read-back, AC-3 (staff ×2, admin) + read-back, AC-4 + read-back, and the six name-keyed AC-14 catalog arms. As required |
| Function made SECURITY DEFINER (`alter function … security definer`) | 15 of 68 failed: AC-13 `prosecdef`, AC-1 ×3, AC-2 ×2, AC-3 ×3, AC-4 + their read-backs. As required (AC-1, AC-3, plus the expected extra AC-2/AC-4/AC-13) |
| INSERT guard renamed to `zz_purchase_orders_po_number_guard_trg` (sorts after `set_po_number`) | 15 of 68 failed: AC-5 ×4 `lives_ok` + 5 read-backs, and the AC-14 name-keyed arms, including the first-BEFORE-INSERT tripwire. With the same mutation, `report_run_variance_formula.test.sql` fails at its insert with `po_number is server-assigned` (the expected extra failure). As required |
| UPDATE rule "column in SET list": trigger re-created as `before insert or update of po_number`, body refuses every client UPDATE | 4 of 68 failed: AC-7 ×2 + P10 read-back, and AC-14 `tgattr` (no column list). AC-6 status/total updates still passed (the column trigger doesn't fire), as expected. As required |
| Role test widened to every role (`if false then return new`) | 11 of 68 failed: AC-9 ×2, AC-10 ×2, AC-11 + their 5 read-backs, and AC-12 `prosrc`. As required |
| `'anon'` removed from the role list (`current_user not in ('authenticated')`) | 1 of 68 failed: AC-12 `prosrc`. As required |

**Not done (gated).** AC-20, AC-21 and AC-22 (prod apply, prod verification, CI after push) wait for the owner's go-ahead and run after spec 190's apply (D-11). The D-14 "noticed, not changed" items are still open.

## Files changed

**Migrations**
- `supabase/migrations/20261109200000_po_number_server_assigned.sql` (new)

**pgTAP tests (Track 2)**
- `supabase/tests/po_number_server_assigned.test.sql` (new, plan 68)
- `supabase/tests/report_run_variance_formula.test.sql` (AC-16: the PO insert no longer sets `po_number`; comment rewritten)

**Spec**
- `specs/196-po-number-server-assigned.md` (Status, AC checkboxes AC-1 to AC-19, implementation notes, this list)

No change to `src/`, `extension/`, `supabase/functions/`, `supabase/config.toml`, `seed.sql`, `e2e/` or `app.json`. Nothing staged or committed.
