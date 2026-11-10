# Spec 190: Number purchase orders from a sequence, not from max()

Status: READY_FOR_REVIEW

## Problem

`public.generate_po_number()` is the BEFORE INSERT trigger function behind
`set_po_number` on `purchase_orders` (`WHEN (new.po_number IS NULL)`). The current
body is in `supabase/migrations/20260819000000_generate_po_number_malformed_guard.sql`:

```
next = coalesce(max(substring(po_number from '^PO-([0-9]+)$')::int), 0) + 1
new.po_number = 'PO-' || lpad(next::text, 3, '0')
```

`purchase_orders_po_number_key` is a global unique constraint. `purchase_orders`
has no `brand_id`, only `store_id`. The function is SECURITY INVOKER with
`search_path = public`. Local and prod bodies match (prod `prosrc` checked
2026-11-09).

Main Claude reproduced four defects locally on 2026-11-09. Details are in its
findings note (side-session `generate-po-number-findings.md`).

| # | Defect | Reproduction | Effect |
|---|---|---|---|
| 1 | **max() is limited by RLS.** The function is SECURITY INVOKER, so `max()` only sees POs the caller can read under `auth_can_see_store()`. | **Same brand, another store:** seed manager 2222 (role `user`, member of Towson and Frederick). The owner inserts Frederick `PO-001` and Charles `PO-002`. 2222 inserts a Frederick PO with a NULL `po_number`, gets `PO-002`, and the insert fails with `23505`. **Another brand:** reproduced by spec 186's build (`specs/186-retention-purge-server-job.md` lines 610 and 666). The spec 186 test works around it with an explicit `po_number` (`retention_prune_job.test.sql:259`). | The insert fails for any caller who can't see the highest-numbered PO. |
| 2 | **Concurrent inserts collide**, even without RLS. | Two owner sessions. A inserts (gets `PO-001`) and keeps its transaction open. B reads the committed max, also gets `PO-001`, blocks on the unique index, and fails with `23505` once A commits. | One of two racing inserts fails. |
| 3 | **`lpad` truncates at 1000.** | `lpad('1000', 3, '0') = '100'`. | The 1000th PO is generated as `PO-100`, which already exists, so it fails with `23505`. `max()` never gets past 999, so **every later insert fails too**. This is the same kind of total outage as the 2026-08-09 `PO-SAMS-PASS-1` incident. |
| 4 | **Numbers get reused.** | Delete the highest-numbered PO, then insert. | That PO's number is issued again. Spec 186's retention purge deletes old POs, so this will happen. |

### Prod exposure (read-only SELECTs, 2026-11-09)

- There are 4 POs, `PO-016` to `PO-019`. `PO-001` to `PO-015` are gone.
- 2 brands. 2AM PROJECT has 6 stores and the other brand has 1.
- Only admins create POs, through the Cmd UI. The staff app only reads `purchase_orders`. The one super_admin sees every store, and the one 2AM PROJECT admin sees that whole brand. The second brand has no admin.
- **So prod is not failing today.** It will start failing when any of these happens:
  - The second brand gets an admin. Their POs start from what they can see (none), so their first PO is `PO-001`. That collides with a 2AM PROJECT number if one still exists, and once they reach `PO-016` every new PO collides.
  - Two FILL CARTs run at the same time: two tabs or devices, or auto-place racing a manual fill.
  - Any non-admin insert path appears. The RLS insert policy already lets store members insert.
  - The counter reaches 1000.
- 5 or 6 of the 8 non-admin profiles with partial store membership cannot see the current top PO (Charles, `PO-019`).

### Where `po_number` is used

Only `send-order-failure-email`, which prints "Purchase order: PO-xxx"
(`supabase/functions/send-order-failure-email/index.ts:104,169`). It does not
appear in `src/lib/db.ts`, the UI, or vendor exports. The US Foods CSV "PO NUMBER"
column is a separate field that the operator fills in and that we leave blank.

## User story

As a store manager or brand admin creating a purchase order (Reorder → FILL CART,
auto-place, or a manual draft), I want the PO to always save, whatever stores I
can see, whoever else is ordering at the same moment, and however many POs the
system has issued, so that ordering never fails with a duplicate-number error.

## Proposed change

These are the proposed answers. Each one is also listed under "Open questions
(owner confirmation)" with this proposal as the default.

1. **Numbering stays global.** One counter covers the whole `purchase_orders`
   table. `purchase_orders_po_number_key` is unchanged.
2. **A Postgres sequence backs the counter.** The trigger takes its number from
   `nextval()`. `nextval()` is atomic, ignores RLS, and never gives out the same
   value twice, even when transactions roll back. That fixes defects 1, 2 and 4.
3. **The sequence starts after the current numeric maximum.** The migration seeds
   it from the highest `po_number` matching `^PO-([0-9]+)$`, using the same
   anchored regex as today, so malformed rows are ignored. Prod's next number is
   therefore `PO-020`. If no row matches, the first number is `PO-001`.
4. **Same format, no truncation.** The `PO-` prefix stays, and numbers are padded
   with zeros to at least 3 digits but never cut short: `PO-007`, `PO-999`,
   `PO-1000`, `PO-12345`. That fixes defect 3.
5. **The `WHEN (new.po_number IS NULL)` gate stays.** An insert that supplies its
   own `po_number` still skips the trigger. Hand inserts and test fixtures rely on
   this.
6. **Gaps are acceptable.** A rolled-back insert uses up its number, and so does
   any number skipped under item 7.
7. **If the next number is already taken, the trigger skips past it.** An insert
   can supply its own `PO-<digits>` number that is ahead of the sequence, as the
   historical hand inserts did. When the trigger's next number is already in the
   table, it calls `nextval()` again until it finds a free number. The loop is
   bounded: past the limit it raises a clear error instead of looping forever.
   Without this, each such row makes one future insert fail with `23505` before
   the sequence moves past it. That clears itself, unlike today's permanent
   failure, but the manager sees a "Draft not created" toast for no reason. The
   check for an existing number must see every row, ignoring RLS, or defect 1
   returns in another form. In practice that means SECURITY DEFINER, which the
   architect decides (see "Design constraints").
8. **Existing rows are not renumbered.**
9. **No client, UI, `db.ts`, store, or edge-function change.**

## Acceptance criteria

All pgTAP criteria go in a new file, `supabase/tests/generate_po_number_sequence.test.sql`
(Track 2), unless a criterion names the existing file.

**Sequence values persist across tests.** `nextval()` and `setval()` are not rolled
back by a test's `begin; … rollback;`, and the local database is shared with other
sessions. So:
- No assertion may depend on an absolute sequence value unless the test sets that
  value itself.
- No test may ever lower the sequence below the table's highest numeric
  `po_number`.
- Moving it upward is harmless, because gaps are acceptable.

### Defects 1, 2 and 4: correctness

- [ ] **AC-1 (same brand, another store).** Fixture: a store-member caller (role
  `user`, claims set with `set local role authenticated` plus `request.jwt.claims`)
  belongs to store X in brand B but not to store Y in the same brand. Store Y holds
  the highest-numbered PO. That caller inserts a PO for store X with a NULL
  `po_number`. The insert succeeds with no `23505`, and the generated number
  matches no other row in `purchase_orders`.
- [ ] **AC-2 (another brand).** Fixture: an admin of brand A, while brand B holds
  the highest-numbered PO, inserts a PO for a brand-A store with a NULL
  `po_number`. The insert succeeds with no `23505`, and the generated number is
  unique table-wide.
- [ ] **AC-3 (numbers go up across callers).** At least 3 generated inserts
  alternate between at least two different callers (the owner, the AC-1 caller and
  the AC-2 caller). All the numbers are distinct, and each one's numeric part is
  greater than the one before.
- [ ] **AC-4 (concurrency).** Satisfied by `nextval()` semantics: values are handed
  out atomically and never reused, whatever the transaction isolation, so
  concurrent callers can't get the same value from the sequence. The design doc
  must state this argument.
  - Optional Track 3 shell smoke (`scripts/smoke-po-number-concurrency.sh`, against
    the local stack): session A inserts and keeps its transaction open, session B
    inserts, and both commit.
  - The smoke passes when both inserts succeed with distinct numbers. Before the
    fix, B fails with `23505`.
- [ ] **AC-5 (a deleted number is not reissued).** Generate a PO, note its number
  N, delete that row, then generate another PO. The new number's numeric part is
  greater than N.

### Defect 3: format

- [ ] **AC-6 (padding).** Generated numbers for counter values 7, 42 and 999 are
  `PO-007`, `PO-042` and `PO-999`.
- [ ] **AC-7 (no truncation at 1000 or above).** Counter value 1000 gives
  `PO-1000`, and 12345 gives `PO-12345`. At least the 1000 case must go through
  the real trigger path: an actual insert into `purchase_orders`, not only a
  formatting helper on its own. The architect decides how the test reaches 1000:
  moving the sequence upward is allowed under the persistence rule above.

### Seeding and the explicit-number gate

- [ ] **AC-8 (seeded past existing numbers).** At any time after the migration,
  the sequence's next value is greater than every existing `po_number` that
  matches `^PO-([0-9]+)$`. This can be tested in pgTAP against whatever rows
  exist. The prod check is in "Prod apply".
- [ ] **AC-9 (explicit number still skips the trigger).** An insert with an
  explicit `po_number` keeps it unchanged and does not advance the sequence. The
  sequence state is the same before and after.
- [ ] **AC-10 (the trigger skips a taken number).** Insert a row whose explicit
  `po_number` is the trigger's next candidate, worked out from the current
  sequence state. The next generated insert succeeds and skips that number. The
  explicit row must be inserted by a caller who cannot see it under RLS, or by a
  privileged caller with the generated insert done by one who cannot see it, so
  that the test proves the check ignores RLS.
  - If the owner rejects item 7 (open question Q5), replace AC-10 with an AC that
    documents the clears-itself single `23505`, and write that behaviour down in
    the migration header.
- [ ] **AC-11 (malformed rows still ignored).** With `PO-SAMS-PASS-1` and
  `LEGACY-99` in the table, generated inserts succeed (`lives_ok`) and get
  well-formed `PO-<digits>` numbers. This keeps spec 2026-08-19's regression
  covered.

### Function and test-suite invariants

- [ ] **AC-12 (search_path pin).** `proconfig` of `public.generate_po_number()`
  is still exactly `{search_path=public}`. The existing assertion at
  `generate_po_number_malformed_guard.test.sql:102-106` passes unchanged.
- [ ] **AC-13 (existing malformed-guard test updated only where the meaning
  changed).** `supabase/tests/generate_po_number_malformed_guard.test.sql` still
  has a plan of 8 or more and passes.

  | Line | Assertion | Change |
  |---|---|---|
  | 43-47 | Empty table gives `PO-001` | **Changes.** Deleting rows no longer resets the counter, so expect the sequence's next value, formatted |
  | 52-56 | `PO-002` continues from the max | **Changes.** Expect the previous generated number + 1 when one session inserts with nothing else running |
  | 59-65 | Explicit `PO-015` kept | **Kept.** The fixture value may change to one that can't collide with the sequence's current value, or that deliberately tests AC-10 |
  | 73-77 | Inserts survive a malformed row | **Kept as is** |
  | 79-83 | `PO-016` continues past `PO-015` | **Changes.** The sequence doesn't jump to an explicit maximum. Expect the next generated value, formatted |
  | 89-93 | Inserts survive an unprefixed row | **Kept as is** |
  | 95-99 | `PO-017` | **Changes.** Expect the next generated value, formatted |
  | 102-106 | `proconfig` | **Kept as is** |

  The file's header comment must say why the absolute expectations became relative
  ones. The unfiltered `delete from public.purchase_orders` at line 38 may stay;
  spec 186 AC-27 refers to it.
- [ ] **AC-14 (whole suite).** `scripts/test-db.sh` passes every file, including
  `retention_prune_job`, `po_loop`, `permissive_policy_lint` and every other file
  that inserts into `purchase_orders` (19 files today). Full `npx jest` and
  `npm run typecheck:test` still pass. No TypeScript changes are expected, so this
  is a no-regression check.
- [ ] **AC-15 (no new RPC).** No new function that clients can call over
  PostgREST is added. A function that only runs as a trigger is fine, because
  Postgres won't let it be called directly. If the architect adds a helper (for
  example a formatter), it must not be callable by `anon` or `authenticated`, or
  must have no side effects. The design states which.

### Prod (after owner go-ahead)

- [ ] **AC-16 (prod rollout).** Applied through the project's MCP migration
  process (see "Prod apply"). Afterwards, prod's next generated number would be
  `PO-020`. The design doc names a check that confirms this without inserting a
  row, for example the sequence's `last_value = 19` and `is_called = true`.

## In scope

- One migration that:
  - creates the sequence;
  - seeds it from the current numeric max;
  - replaces `generate_po_number()` with a body that uses `nextval()`, pads to at
    least 3 digits without truncating, and skips taken numbers within a bounded
    loop;
  - sets the grants or ownership needed for `nextval()` to work for every caller
    who can insert.
- The new pgTAP file, and updating `generate_po_number_malformed_guard.test.sql` as
  AC-13 specifies.
- Optionally, the Track 3 concurrency smoke from AC-4.
- Removing the stale workaround comments in `retention_prune_job.test.sql:259-262`
  and `report_run_variance_formula.test.sql:147-152`, which describe the old
  behaviour. Their explicit `po_number` fixtures may stay. This is a comment-only
  change, and only if the architect agrees it is in scope; otherwise list it under
  "Noticed, not changed".

## Out of scope (explicitly)

- **Separate numbering per brand or per store,** including prefixes such as
  `2AM-PO-001`. Global numbering already fixes every reproduced defect.
  `purchase_orders` has no `brand_id`, so this would be a schema change of its own.
- **Showing `po_number` in the Cmd UI, `db.ts`, the staff app or vendor exports.**
  Nothing needs it beyond the failure email today.
- **Renumbering or deleting existing rows,** including `PO-SAMS-PASS-1` if it
  still exists anywhere. Following the 2026-08-19 precedent, history keeps its
  audit trail.
- **Closing gaps or guaranteeing consecutive numbers.** A sequence can't give
  gap-free numbers safely under concurrency, and nothing needs them.
- **Validating explicit `po_number` values,** for example rejecting
  `PO-SAMS-PASS-1`-style text. The trigger is gated on NULL, and constraining
  explicit values is a separate decision.
- **Changing who can insert into `purchase_orders`.** The RLS insert policy that
  admits store members is unchanged. This spec only makes inserts the policy
  already allows succeed.
- **Changing the `app.json` slug.** Not touched.

## Open questions (owner confirmation; each has a default, none blocks design)

**Resolved 2026-11-09: the owner accepted every default below as written.**
Q1 global, Q2 continue from the current max (prod next is `PO-020`), Q3 at least
3 digits with no truncation, Q4 gaps are fine, Q5 the trigger skips taken numbers
in a bounded loop whose existence check ignores RLS (so AC-10 stands as written),
Q6 prod only after a separate explicit go-ahead. The questions are kept below for
the record.

- Q1: Should numbering be global or separate per brand? → **Proposed: global.**
  One sequence, and the global unique key is unchanged. The owner can override.
- Q2: Should the series continue from the current max, or restart? → **Proposed:
  continue.** Seed from the max numeric `po_number`, so prod's next is `PO-020`.
- Q3: What format above 999? → **Proposed: no truncation, at least 3 digits**
  (`PO-1000`).
- Q4: Are gaps from rolled-back inserts or skipped numbers acceptable? →
  **Proposed: yes.**
- Q5: What happens when an explicit `PO-<digits>` row is ahead of the sequence? →
  **Proposed: the trigger skips past taken numbers** (bounded loop, check ignores
  RLS). The alternative is to accept one clears-itself `23505` per such row and
  document it. The owner can choose the alternative, and AC-10 changes as described
  there.
- Q6: When does it go to prod? → **Only after the owner explicitly says go.** It
  uses the MCP process below. Prod isn't failing today, so there is no emergency
  window, but each trigger listed under "Prod exposure" turns it into an outage.

## Design constraints left to the architect

- **SECURITY DEFINER vs INVOKER.** The skip-past check (item 7) must see every row.
  If the trigger function becomes SECURITY DEFINER (owner `postgres`, which skips
  RLS because `purchase_orders` has no FORCE RLS), that also covers sequence access.
  If it stays INVOKER, `nextval()` relies on the spec 097 default privileges
  (`grant all on sequences to anon, authenticated, service_role`,
  `20260618000000_public_grants_explicit.sql:199`), and the skip check needs an
  RLS-blind helper. Either way the design must:
  - state the security argument, as spec 178 did for its guard;
  - say whether `anon` keeps privileges on the new sequence. PostgREST doesn't
    expose `setval` or `nextval`, but the design should take a position.
- **Sequence details:** name, type (`bigint` recommended), `NO CYCLE`, and whether
  it is `OWNED BY purchase_orders.po_number`.
- **Reference the sequence by schema-qualified name** in the function body, so it
  doesn't depend on the `search_path` pin.
- **Bound and error message for the skip loop.**
- **Migration version:** later than the latest one on disk (currently
  `20261108130000`, spec 187).

## Dependencies

- Current function: `supabase/migrations/20260819000000_generate_po_number_malformed_guard.sql`.
  Its header already calls a sequence "the real answer".
- Trigger: `set_po_number`, from `supabase/migrations/20260405000759_init_schema.sql:234`.
  Unchanged.
- `search_path` pin: from spec 024 (`20260424211733_security_fixes.sql:132`).
- Default sequence grants: spec 097, `20260618000000_public_grants_explicit.sql`.
- Spec 186 (retention purge deletes old POs, which feeds defect 4). Its migration
  `20261108120000_retention_prune_job.sql` is untracked and not yet on prod as of
  this spec, so this spec's migration must sort after it and must not assume it has
  or hasn't been applied.
- Consumer: `supabase/functions/send-order-failure-email/index.ts`, display only.
  It needs no change for numbers of 4 or more digits.
- `supabase/seed.sql` contains no `purchase_orders` rows. On a fresh `db reset` the
  migration seeds from an empty table, so the first number is `PO-001`.

## Project-specific notes

- Cmd UI section: none. This is a backend-only fix. FILL CART / Reorder and
  auto-place simply stop failing.
- Per-store or admin-global: the numbering is global across the whole table and
  must not depend on what the caller can see. Per-store RLS on `purchase_orders`
  doesn't change.
- Realtime channels touched: none. Inserts already publish as they do today.
- Migrations needed: yes, one.
- Edge functions touched: none. `send-order-failure-email` reads `po_number` and
  doesn't change.
- Web/native scope: not applicable (database only), so it covers both.
- Test tracks:
  - Track 2 (pgTAP): required, as the new file plus the updated malformed-guard
    file.
  - Track 3 (shell smoke): optional, for concurrency.
  - Track 1 (jest): full run as a no-regression check only.

## Prod apply

Requires the owner's explicit go-ahead. Apply before pushing, or
`db-migrations-applied.yml` goes red.

1. Run the migration body through the Supabase MCP `execute_sql`, project
   `ebwnovzzkwhsdxkpyjka`.
2. Insert the exact migration version into `supabase_migrations.schema_migrations`.
3. Confirm the function's normalized md5 matches local.
4. Confirm `proconfig` is `{search_path=public}`, and `prosecdef` and the owner are
   as the design specifies.
5. Confirm the sequence state shows the next value is 20 (AC-16), without
   inserting a PO.
6. After pushing, confirm the latest `main` runs of both `test.yml` and
   `db-migrations-applied.yml` are green.

Rollback: re-create the function body from
`20260819000000_generate_po_number_malformed_guard.sql`. The sequence can stay or
be dropped. Rolling back is safe only while every `po_number` is below 1000:
the old `max()` body then continues from the highest number the sequence issued.
Once any `PO-1000` or higher exists, the old `lpad(…, 3)` body collides on every
insert, so rolling back would restore a permanent outage. Rolling back brings
all four defects back either way (D-10).

## Backend design

Backend-only. One additive migration, one new pgTAP file, one rewritten pgTAP
file, and up to two comment-only edits. No change to `src/lib/db.ts`,
`src/store/useStore.ts`, edge functions, RLS policies, or the realtime
publication.

### D-1. Decision summary

| Constraint | Decision |
|---|---|
| DEFINER vs INVOKER | **SECURITY DEFINER**, owner `postgres` (unchanged; `CREATE OR REPLACE` keeps the owner). Argument in D-4. |
| Sequence name | `public.purchase_orders_po_number_seq` (the name Postgres would give a serial on that column) |
| Sequence shape | `AS bigint INCREMENT BY 1 MINVALUE 1 NO MAXVALUE START WITH 1 CACHE 1 NO CYCLE` |
| Ownership | `OWNED BY public.purchase_orders.po_number`. Its lifecycle follows the column, and `pg_get_serial_sequence('public.purchase_orders','po_number')` finds it. |
| `CACHE` | **Must be 1.** A cache above 1 gives each session its own block, so numbers from different sessions come out of order, which breaks AC-3. |
| anon / authenticated on the sequence | **Revoke all** (USAGE, SELECT, UPDATE) from `public, anon, authenticated`. `service_role` keeps the spec 097 default `ALL`. |
| Trigger fn EXECUTE | **Revoke** from `public, anon, authenticated`. Same as spec 177 (`20261025000000_cross_store_item_rejection.sql:213`) and spec 187 (`20261108130000:82`). |
| Formatter | New `public.format_po_number(bigint) returns text`: pure, IMMUTABLE, EXECUTE revoked from `public, anon, authenticated`. It meets **both** AC-15 clauses (not callable by client roles, and no side effects). |
| `search_path` | Unchanged: `set search_path = public` on both functions. **AC-12 stands as written.** Every non-catalog reference in the bodies is schema-qualified anyway. |
| Skip-loop bound | **100** attempts, then `raise ... using errcode = '54000'` (program_limit_exceeded). Message and hint are in D-3. |
| Seeding | `setval` from the anchored-regex max (as `numeric`) inside the migration, under a table lock. Details in D-2. |
| Migration version | `supabase/migrations/20261109140000_po_number_sequence.sql`. The latest on disk is now `20261109120000_admin_eod_replace.sql` (spec 189), not `20261108130000`. |
| AC-7 path to 1000 | Move the sequence **upward only**, to 999, when its next value is below 1000. Otherwise use the next value as it is. Details in D-6. |
| New policies | **None.** See D-5. |

### D-2. Data model: migration `20261109140000_po_number_sequence.sql`

Additive. No table rewrite, no column change, no policy change, and the trigger
`set_po_number` (with its `WHEN (new.po_number IS NULL)` gate) is untouched.
Wrap the whole body in `begin; … commit;` as spec 187 does, and start it with
`set local lock_timeout = '5s'`.

Order inside the transaction:

1. `lock table public.purchase_orders in share row exclusive mode;` This conflicts
   with ROW EXCLUSIVE, so no insert can land between reading the max and the
   `setval`. The skip loop would cover that race anyway; the lock makes AC-16
   deterministic. Prod has 4 rows, so the lock is held for milliseconds.
2. `create sequence public.purchase_orders_po_number_seq` with the D-1 shape and
   `owned by public.purchase_orders.po_number`. Use a plain `create`, not
   `if not exists`, so a re-apply fails loudly instead of silently re-seeding.
3. `revoke all on sequence public.purchase_orders_po_number_seq from public, anon, authenticated;`
   **This is mandatory.** The spec 097 default privileges
   (`20260618000000_public_grants_explicit.sql:198-199`) grant ALL on the new
   sequence to anon and authenticated as it is created.
4. Seed (pseudocode):
   ```
   m := coalesce(max((substring(po_number from '^PO-([0-9]+)$'))::numeric), 0)
          from public.purchase_orders            -- runs as postgres: RLS does not apply
   if m >= 1: setval(seq, m::bigint, true)       -- next = m + 1; prod: last_value 19, is_called true
   else:      setval(seq, 1, false)              -- next = 1 (empty table or only 'PO-000')
   ```
   Cast through `numeric` so a long hand-typed number cannot raise `22003`
   partway through the `max()`. If the max exceeds bigint, the `::bigint` fails
   loudly and the migration rolls back. Prod's max is 19.
5. `create function public.format_po_number(n bigint) returns text language sql immutable strict parallel safe set search_path = public`.
   Body: `'PO-' || lpad(n::text, greatest(3, length(n::text)), '0')`. This gives
   7 → `PO-007`, 999 → `PO-999`, 1000 → `PO-1000`, 12345 → `PO-12345`.
   Negative input can't happen because of `MINVALUE 1`, so no guard is needed.
6. `revoke execute on function public.format_po_number(bigint) from public, anon, authenticated;`
   Also mandatory, because spec 097 grants ALL on future functions.
7. `create or replace function public.generate_po_number()` as SECURITY DEFINER
   with `set search_path = public`, using the D-3 body.
8. `revoke execute on function public.generate_po_number() from public, anon, authenticated;`
9. `comment on sequence` / `comment on function` for all three objects. Name
   spec 190, say "must stay SECURITY DEFINER" and why, and warn that
   `TRUNCATE public.purchase_orders RESTART IDENTITY` would reset the sequence
   because of `OWNED BY`.

Migration header must include: the four defects in one line each; the D-4
security argument; "No publication change, so NO
`docker restart supabase_realtime_imr-inventory` step"; the prod-apply pointer to
this spec; and rollback (D-10).

### D-3. Trigger body (pseudocode, not committed SQL)

```
generate_po_number() returns trigger
  language plpgsql  security definer  set search_path = public
declare v_n bigint; v_candidate text; v_attempts int := 0;
begin
  loop
    v_n         := nextval('public.purchase_orders_po_number_seq');
    v_candidate := public.format_po_number(v_n);
    exit when not exists (select 1 from public.purchase_orders
                           where po_number = v_candidate);   -- unique index probe, RLS-blind (definer)
    v_attempts := v_attempts + 1;
    if v_attempts >= 100 then
      raise exception 'generate_po_number: no free PO number after 100 attempts (last tried %)', v_candidate
        using errcode = '54000',
              hint = 'Rows with explicit po_number values occupy this range. Move public.purchase_orders_po_number_seq past them with setval().';
    end if;
  end loop;
  new.po_number := v_candidate;
  return new;
end;
```

- `nextval` takes the sequence as a schema-qualified text literal, so the
  reference does not depend on `search_path`.
- The `exists` probe sees committed rows and the current transaction's own rows,
  which is what AC-10 needs. It uses `purchase_orders_po_number_key`.
- **Why 100 and 54000.** The skip only triggers for rows inserted with an
  explicit `PO-<digits>` number ahead of the sequence. Historically these were
  hand inserts, one at a time. Each probe is one unique-index lookup, so 100
  attempts take well under a millisecond, and a run of 100 taken numbers means a
  bulk explicit insert, which an operator should see. `54000`
  (program_limit_exceeded) is the honest class: this is a server-side limit, not
  a caller mistake, and PostgREST maps class 54 to HTTP 500 instead of the 400
  that `P0001` would give. The client's existing "Draft not created" toast path
  (`notifyBackendError`) handles it with no change. The failure also clears
  itself: the failed insert's 100 `nextval` calls are not rolled back, so each
  retry moves 100 numbers further. A block of K taken numbers costs at most
  ⌈K/100⌉ failed inserts. Today a single bad row can block inserts permanently.

### D-4. Security argument (SECURITY DEFINER)

**Why not INVOKER.** An INVOKER trigger has two problems. First, `nextval` would
run as the caller, so anon and authenticated would have to keep USAGE/UPDATE on
the sequence. Second, the RLS-blind skip check would need a separate SECURITY
DEFINER helper, and the caller would need EXECUTE on it. That helper would be a
PostgREST RPC that answers "does PO number X exist?" for **any caller-chosen X,
across brands**. That is a new cross-tenant oracle and it would fail AC-15.
DEFINER avoids both problems.

**What the definer body can do with caller input: nothing.**
1. *Inputs.* The trigger only fires when `new.po_number IS NULL`. It reads no
   other `NEW` field, and its only write is `new.po_number`. The privileged
   `exists` probe is keyed only on a value from `nextval`, never on anything the
   caller supplies.
2. *Disclosure.* The caller only ever sees their own new `po_number`. From it
   they can learn (a) roughly how many POs were created table-wide since their
   last one, and (b) that one number they never chose was taken (a gap). (a) is
   inherent to global numbering, which the owner accepted in Q1; an INVOKER plus
   `nextval` design leaks exactly the same. (b) is at most one bit about a
   number the server picked, and the caller can't aim it, because they lose
   `setval`/`nextval` on the sequence (D-1). That is the concrete reason to
   revoke from authenticated, beyond "PostgREST doesn't expose `setval`".
3. *Escalation.* The body writes nothing besides `NEW` and the sequence. The
   search path is pinned. `pg_catalog` is always searched first when it isn't
   listed, so `lpad`, `length`, `nextval`, `greatest` and `=` can't be shadowed
   by objects in `public`. `public.purchase_orders`,
   `public.format_po_number` and the sequence are schema-qualified.
4. *RLS bypass is real and pinned.* `purchase_orders` has `relforcerowsecurity = false`,
   and the function owner (`postgres`) owns the table, so the probe ignores RLS.
   DP-1 below asserts both facts, so a later `FORCE ROW LEVEL SECURITY` or owner
   change fails CI instead of quietly bringing defect 1 back.
5. *Not callable.* Postgres refuses to call a `returns trigger` function outside
   a trigger (`0A000`), and PostgREST leaves trigger functions out of `/rpc`.
   EXECUTE is revoked anyway, as defense in depth. Revoking it does not affect
   firing: Postgres checks EXECUTE on a trigger function only at `CREATE TRIGGER`
   time, which spec 177's revoked trigger functions already show in CI.
6. *Abuse via explicit numbers.* A store member can already INSERT with an
   explicit `po_number` (the RLS insert policy allows it, and validating
   explicit numbers is out of scope). Filling a block of 100 or more numbers
   ahead of the sequence makes one other insert fail with `54000` per 100
   numbers, and it clears itself (D-3). Those rows are visible and attributable
   in the attacker's own store. Today one such row can block inserts forever.

`service_role` keeps the spec 097 `ALL` on the sequence. It is trusted, already
bypasses RLS, and nothing in the app uses it on this sequence. Revoking it would
change the spec 097 posture for no gain.

### D-5. RLS impact

None. No policy is added, dropped or altered on `purchase_orders` or anywhere
else. CLAUDE.md permissive-policy rule: nothing here creates a permissive policy,
so `permissive_policy_lint.test.sql` is unaffected and needs no allowlist row.
The four `purchase_orders` policies from
`20260504173035_per_store_rls_hardening.sql:184-200` (and spec 186's restrictive
delete policy, if applied) stay as they are. This spec only lets an insert the
policy already allows succeed. `public_grants_explicit.test.sql` only checks
`pg_tables`, not sequences, so revoking on the sequence does not trip its arm (1)
and needs no allowlist row.

### D-6. Tests

**New file `supabase/tests/generate_po_number_sequence.test.sql`** (Track 2,
`begin; … rollback;`). Rules for the developer:

- Read sequence state **as postgres**:
  `select last_value, is_called from public.purchase_orders_po_number_seq`, with
  next = `case when is_called then last_value + 1 else last_value end`. Do it
  before `set local role authenticated` or after `reset role`, because
  authenticated now has no SELECT on the sequence. `currval(...)` after a
  generated insert in the same session is also fine as postgres.
- Call `public.format_po_number(...)` only as postgres (EXECUTE is revoked from
  authenticated).
- Never `setval` downward (spec rule).

Mapping:

| AC | How |
|---|---|
| AC-1 | As postgres, build brand B with stores X and Y and a role-`user` profile that is a member of X only. Generate a PO in Y (it now holds the highest number). Switch to the member (`set local role authenticated` plus `request.jwt.claims`) and insert a NULL-number PO into X. Assert `lives_ok`, exactly one row with that number table-wide, and that its numeric part is greater than Y's. This also proves `nextval` works with no sequence grant, which shows DEFINER is in effect. |
| AC-2 | A brand-A admin, with brand B holding the highest generated number. Same assertions. |
| AC-3 | At least 3 generated inserts alternating owner / AC-1 caller / AC-2 caller. Distinct, and strictly increasing (`CACHE 1` guarantees this within a serial run). |
| AC-4 | Argument in D-7. Optional smoke described there. |
| AC-5 | Generate (N), delete it, generate again: numeric part > N. |
| AC-6 | `format_po_number(7/42/999)` gives `PO-007` / `PO-042` / `PO-999`. |
| AC-7 | `format_po_number(1000)` gives `'PO-1000'` and `12345` gives `'PO-12345'` (isolation). **Real trigger path:** as postgres, read next. If next < 1000, `setval(seq, 999, true)` (upward only) and expected = 1000; otherwise expected = next. Delete any row equal to `format_po_number(expected)` inside the transaction (rolled back), insert a NULL-number PO, and assert `po_number = format_po_number(expected)` and `substring(po_number from 4)::bigint >= 1000`. On CI (fresh DB) and on the first local run this is literally `PO-1000`. After that, the local sequence stays above 1000 until `npm run dev:db`/`db reset`, and local dev POs get 4-digit numbers. That is harmless because gaps are accepted. |
| AC-8 | First assertion in the file, before any fixtures: next > `coalesce(max(<anchored regex>::numeric), 0)` over all rows. |
| AC-9 | Read `(last_value, is_called)`, insert an explicit `PO-<digits>` that is far ahead (next + 500) and won't be reached in this transaction, and assert the value is kept and the state is unchanged. |
| AC-10 | As postgres, candidate = `format_po_number(next)`. Insert an explicit row with that number into store Y. As the AC-1 member (who cannot see Y), insert into X. Assert `lives_ok`, generated = `format_po_number(next + 1)`, and (after `reset role`) that the sequence advanced by 2. |
| AC-11 | Insert `PO-SAMS-PASS-1` and `LEGACY-99` explicitly, then `lives_ok` on a generated insert, plus `matches(po_number, '^PO-[0-9]{3,}$')`. |
| AC-12 | The existing assertion, unchanged. |
| AC-15 | DP-2 below. |

**Design-pinned assertions** (add these to the same file; they pin D-1/D-4):

- **DP-1** `prosecdef` is true for `generate_po_number()`. `purchase_orders` has
  `relforcerowsecurity = false`. The function's `proowner` equals the table's
  `relowner`, or has `rolbypassrls`.
- **DP-2** `has_function_privilege` is false for `anon` and `authenticated` on
  EXECUTE for both `public.generate_po_number()` and
  `public.format_po_number(bigint)`.
- **DP-3** `has_sequence_privilege` is false for `anon` and `authenticated` on
  each of USAGE, SELECT, UPDATE for `public.purchase_orders_po_number_seq`.
- **DP-4** Sequence shape from `pg_sequence`: `seqtypid = 'bigint'::regtype`,
  `seqcycle = false`, `seqcache = 1`, `seqincrement = 1`, `seqmin = 1`. Also
  `pg_get_serial_sequence('public.purchase_orders','po_number') = 'public.purchase_orders_po_number_seq'`.
- **DP-5** `format_po_number`: `provolatile = 'i'`, `prosecdef = false`,
  `proconfig = array['search_path=public']`.
- **DP-6** Bound. As postgres, insert explicit rows for the next 100 candidates
  (`generate_series`), then
  `throws_ok(<generated insert>, '54000', 'generate_po_number: no free PO number after 100 attempts (last tried PO-…)')`.
  Build the expected message from the computed last candidate, or use
  `throws_like` on the prefix. Put DP-6 **last** in the file, because it moves
  the sequence forward by 100. That costs about 100 numbers per local run, which
  is acceptable.

**Rewrite `supabase/tests/generate_po_number_malformed_guard.test.sql`** as AC-13
says. Keep `plan` at 8 or more. Keep the unfiltered `delete` at line 38 (spec 186
AC-27). The header must say that after spec 190 the counter is a sequence that
does not reset when rows are deleted and whose values survive `rollback`, so the
absolute `PO-001/002/016/017` expectations become
`format_po_number(currval(...))` or "previous + 1". Change the explicit fixture
at 59-65 from `PO-015` to `format_po_number(next + 500)`, computed at run time.
On CI, earlier test files (alphabetically `auto_*`, `cross_*` …) have already
used up some low numbers, so a literal `PO-015` could be the sequence's next
value and send the following assertions through the skip loop by accident.
AC-10 covers the deliberate collision in the new file.

**Comment-only cleanups (decision):**
- `supabase/tests/report_run_variance_formula.test.sql:147-152`: **in scope.**
  Its "substrings positions 4+" text has been stale since 20260819. Rewrite it to
  say that the explicit `po_number` is a fixture convenience. Keep the fixture.
- `supabase/tests/retention_prune_job.test.sql:259-262`: **in scope only if spec
  186 is committed when this builds.** That file is still untracked and belongs
  to spec 186's in-flight build. If it is uncommitted, do not touch it, and list
  it under "Noticed, not changed".

### D-7. Concurrency argument (AC-4)

`nextval()` is non-transactional and atomic. Each call takes a brief lock on the
sequence and returns a value never returned before (`NO CYCLE`), whatever the
isolation level, and even if the calling transaction later rolls back. Two
concurrent inserts therefore get different candidates. Each probe looks only at
its own candidate, so they never wait on each other at the unique index, and
neither can get `23505` from the other. The old design failed because both read
the same committed `max()`.

One race remains, and it is out of scope: an uncommitted insert with an
**explicit** `po_number` equal to the sequence's next value is invisible to the
probe. The generated insert then waits on the unique index and gets `23505` once
the explicit insert commits. That needs a hand insert of exactly the next number
at the same moment.

Optional smoke `scripts/smoke-po-number-concurrency.sh`: **recommended, not
blocking.** Two `psql` sessions against the local stack. A runs `begin; insert …;
select pg_sleep(3); commit;` in the background, B runs its insert once A has
inserted, and both commit. Pass if both commit and `po_number` values differ.
Clean up the two rows by id at the end.

### D-8. API contract, edge functions, `db.ts`, store, realtime

- **API contract:** unchanged. Clients keep inserting into `purchase_orders`
  through PostgREST with `po_number` omitted. No new RPC.
  `format_po_number` is in PostgREST's schema cache but returns 42501 for every
  client role. The only new error is `54000` → HTTP 500, reached only through
  D-3's bound.
- **Edge functions:** none changed. `send-order-failure-email` already
  interpolates `po_number` as text through its `escapeHtml`. Four or more digits
  need nothing. Service-role inserters, if any, get the same DEFINER path.
- **`src/lib/db.ts`:** no new helper. `po_number` is still not mapped on the
  client (spec "Where `po_number` is used").
- **`src/store/useStore.ts`:** no slice change. The existing
  optimistic-then-revert plus `notifyBackendError` around PO draft creation
  covers the new `54000` with no edit.
- **Realtime:** no publication change. Inserts publish on the same channel as
  today (`store-{id}` via `useRealtimeSync`). **No
  `docker restart supabase_realtime_imr-inventory` step.** Sequences are not
  publishable.

### D-9. Prod apply additions (to "Prod apply" above; still gated on the owner's explicit go-ahead)

(Tightened in fix round 1 after review: architect S-1, M-1, M-2, M-3, M-5 and
security-auditor D-9 Lows #1-#3.)

Before step 1 (read-only). Any unexpected result means STOP:
- `select current_user;` Expect `postgres`. Under another role the
  `create sequence … owned by` fails ("sequence must have same owner as table
  it is linked to"), and the formatter would be owned by a role the
  `postgres`-owned definer trigger can't call once EXECUTE is revoked from
  PUBLIC.
- `select to_regclass('public.purchase_orders_po_number_seq'), to_regprocedure('public.format_po_number(bigint)');`
  Expect `null, null`. Anything else means the migration (or part of it) is
  already there; the plain `create sequence` would fail loudly (D-2.2).
- `select 1 from supabase_migrations.schema_migrations where version = '20261109140000';`
  Expect no row.
- `select count(*), max((substring(po_number from '^PO-([0-9]+)$'))::numeric) from public.purchase_orders;`
  Expect 4 and 19 as of 2026-11-09. If the max has moved, AC-16's expected value
  moves with it (last_value = new max). Record this max as `<pre-check max>`.
- `select pg_get_userbyid(proowner), prosecdef from pg_proc where oid = 'public.generate_po_number()'::regprocedure;`
  Expect `postgres` and `false`. If the owner is not `postgres`, STOP: the
  `CREATE OR REPLACE` would fail, and the D-4 argument has to be redone for that
  owner.
- `select relforcerowsecurity from pg_class where oid = 'public.purchase_orders'::regclass;` Expect `false`.
- The DP-1 query (the RLS-blind probe depends on it):
  ```sql
  select c.relowner = p.proowner as table_owner_is_function_owner,
         r.rolbypassrls          as function_owner_bypasses_rls,
         pg_get_userbyid(c.relowner) as table_owner
    from pg_class c, pg_proc p, pg_roles r
   where c.oid = 'public.purchase_orders'::regclass
     and p.oid = 'public.generate_po_number()'::regprocedure
     and r.oid = p.proowner;
  ```
  Expect `table_owner_is_function_owner` true OR `function_owner_bypasses_rls`
  true (locally: owner `postgres`, both true). If both are false, STOP: the
  `exists` probe would be RLS-filtered and defect 1 comes back as `23505`.

Step 1 and step 2 (apply and record the version):
- Send the migration body through MCP `execute_sql`. Do NOT use MCP
  `apply_migration`: it writes its own generated version, which turns
  `db-migrations-applied.yml` red.
- Record the version with
  `insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261109140000', 'po_number_sequence', '{}');`
- Optional runbook step (architect M-3): paste that `insert` just before the
  migration's final `commit;` in the text sent to `execute_sql`, so the body and
  its version row commit together. This changes only the text sent, not the
  migration file, and no function body, so the normalized md5 is unaffected.
  Sent separately after `commit;` it runs in its own transaction, which is the
  same non-atomicity the CLI has and is harmless (a missing row fails the drift
  gate loudly; a re-apply fails on the plain `create sequence`).

After step 2 (replacing steps 4 and 5). Insert no PO for these checks:
- `select last_value, is_called from public.purchase_orders_po_number_seq;`
  Expect `last_value = <pre-check max>` and `is_called = true` (`19, true` as of
  2026-11-09, meaning the next number is `PO-020`, AC-16). Prod is live (FILL
  CART, auto-place), so a PO created between the apply and this check
  legitimately moves `last_value` higher. If it is higher, confirm every extra
  number belongs to a PO created after the apply:
  `select po_number, created_at from public.purchase_orders order by created_at desc limit 5;`
  In every case `last_value + 1` must be greater than the current numeric max
  (re-run the count/max query): that is the AC-8 invariant.
- `pg_get_serial_sequence('public.purchase_orders','po_number')` returns
  `public.purchase_orders_po_number_seq`.
- `select pg_get_userbyid(relowner) from pg_class where oid = 'public.purchase_orders_po_number_seq'::regclass;`
  Expect `postgres`.
- Normalized md5 matches local for **both** `generate_po_number()` and
  `format_po_number(bigint)`.
- For both functions: `proconfig = {search_path=public}`; `prosecdef` true for
  the trigger and false for the formatter; owner `postgres`.
- Privileges, through the same calls DP-2 and DP-3 use. These account for
  PUBLIC grants and role membership, which a string check for `anon=` /
  `authenticated=` in `proacl` / `relacl` would miss (a PUBLIC grant is written
  `=X/postgres`). All nine must be false:
  ```sql
  select has_function_privilege(r, 'public.generate_po_number()', 'EXECUTE')      as gen_exec,
         has_function_privilege(r, 'public.format_po_number(bigint)', 'EXECUTE') as fmt_exec,
         has_sequence_privilege(r, 'public.purchase_orders_po_number_seq', 'USAGE,SELECT,UPDATE') as seq_any
    from unnest(array['anon', 'authenticated', 'public']) as r;
  ```
  (A comma list in `has_sequence_privilege` is true if any one of the
  privileges is held, which is the right test. `'public'` is accepted as the
  PUBLIC pseudo-role.) As a belt-and-braces read, no element of either
  function's `proacl` or the sequence's `relacl` starts with `=`.

Ordering with in-flight specs: this migration has no dependency on 186
(`20261108120000`), 187 (`20261108130000`), 189 (`20261109120000`) or 194
(`20261109170000`, sorts after this one), and it can go to prod before or after
any of them. It does not read or write their objects, and spec 194 adds no
INSERT trigger on `purchase_orders` and does not touch the sequence or either
function. (Spec 194 does depend on 186 being applied first, but that constraint
does not involve 190.) Its repo version must still sort after 186, 187 and 189,
which `20261109140000` does. If another spec claims a migration timestamp first,
bump this one only as long as it keeps that ordering.

### D-10. Rollback

Forward-only by repo convention. If needed, re-run the
`20260819000000_generate_po_number_malformed_guard.sql` body. `CREATE OR REPLACE`
without a `SECURITY` clause resets it to INVOKER. The EXECUTE revoke from D-2
step 8 stays, which is harmless. Optionally
`drop sequence public.purchase_orders_po_number_seq`; the `OWNED BY` link does
not block the drop. Rolling back brings all four defects back.

Rollback is safe only while every `po_number` is below 1000. Once any
`PO-1000` or higher exists, the old body's `lpad(…, 3)` truncation collides with
an existing number on every insert, so rolling back would restore a permanent
outage, not just the four defects. (Prod is at 19 as of 2026-11-09.)

### D-11. Risks and tradeoffs

1. **Cross-brand volume signal** (D-4 point 2a). This is inherent to the global
   numbering the owner accepted, not to DEFINER. Low sensitivity. Per-brand
   numbering stays out of scope.
2. **Spec 097 default-privilege gotcha.** Without the explicit revokes in D-2
   steps 3, 6 and 8, the new sequence and formatter are born with ALL for anon
   and authenticated. DP-2 and DP-3 catch a missing revoke.
3. **Test-sequence drift.** Sequence values persist across `rollback`. Locally,
   AC-7 lifts the sequence to at least 1000 once, and DP-6 burns about 100 per
   run. CI starts fresh every run. No test may assert an absolute generated
   number unless it sets the sequence first. No existing test outside the
   malformed-guard file asserts one (grep: only that file and two explicit
   fixtures touch `po_number`).
4. **`OWNED BY` + `TRUNCATE … RESTART IDENTITY`** would reset the sequence to 1.
   (Corrected in fix round 1.) `authenticated` does hold TRUNCATE on
   `purchase_orders` (the image default ACL includes `D`, and spec 097's
   no-TRUNCATE list never removed it). The reset path is still closed:
   `RESTART IDENTITY` requires ownership of the owned sequence, which no client
   role has, and PostgREST, Realtime and pg_graphql expose no TRUNCATE verb. No
   code path truncates this table. The sequence comment documents the reset
   risk. Revoking TRUNCATE from `anon` and `authenticated` on `public` tables is
   being handled as a separate follow-up, outside this spec.
5. **Explicit-number race** (D-7): one residual `23505`, out of scope.
6. **Lock during the migration:** SHARE ROW EXCLUSIVE on a 4-row table for
   milliseconds, with `lock_timeout = '5s'` so it fails fast instead of queueing
   behind a long transaction.
7. **Performance:** one `nextval` plus one unique-index probe per generated
   insert, against today's full `max()` scan. Faster. `seed.sql` has no PO rows,
   so the seed dataset size doesn't matter. No edge function, so no cold start.
8. **Spec-number collision (process, non-blocking):** four specs are numbered 190
   (`190-po-number-sequence`, `190-kept-records-delete-hardening`,
   `190-staff-eod-date-bound`, `190-user-stores-own-row-writes`). Reviewer
   output for this one goes to `specs/190-po-number-sequence/reviews/`. The PM
   should renumber the drafts before they reach build.

### D-12. Files expected to change

- `supabase/migrations/20261109140000_po_number_sequence.sql` (new)
- `supabase/tests/generate_po_number_sequence.test.sql` (new)
- `supabase/tests/generate_po_number_malformed_guard.test.sql` (AC-13 rewrite)
- `supabase/tests/report_run_variance_formula.test.sql` (comment only)
- `supabase/tests/retention_prune_job.test.sql` (comment only, only if spec 186 is committed)
- `scripts/smoke-po-number-concurrency.sh` (optional)

## Implementation notes (backend-developer, 2026-11-09)

Built to D-1..D-12 and DP-1..DP-6 with no design deviation.

- **Migration** `20261109140000_po_number_sequence.sql`: steps in the D-2 order
  inside `begin; set local lock_timeout = '5s'; … commit;`. Plain `create
  sequence` (no `if not exists`), the D-1 shape with `CACHE 1`, `owned by
  public.purchase_orders.po_number`. Revokes on the sequence and both functions
  from `public, anon, authenticated`. Seed via a `do` block, cast through
  `numeric`. The trigger body is the D-3 pseudocode verbatim, including the
  error and hint text. No explicit `alter … owner`: `create or replace` keeps
  `postgres`, and the new formatter is owned by the applying role (`postgres`).
  Header carries the four defects, the D-4 argument, the D-7 concurrency
  argument, the no-realtime-restart note, the prod-apply pointer and D-10
  rollback.
- **Local apply**: applied with `docker exec -i supabase_db_imr-inventory psql
  -U postgres -v ON_ERROR_STOP=1 < migration` and recorded as version
  `20261109140000` / `po_number_sequence` in local
  `supabase_migrations.schema_migrations` (empty `statements`, matching how the
  186/187/189 sessions recorded theirs). The local table had 0 POs, so the seed
  gave `last_value 1, is_called false` (next `PO-001`). Verified:
  `pg_get_serial_sequence` finds the sequence; sequence `relacl`
  `{postgres=rwU/postgres,service_role=rwU/postgres}`; both functions
  `proconfig {search_path=public}`, owner `postgres`, `proacl`
  `{postgres=X/postgres,service_role=X/postgres}`; `prosecdef` t (trigger) / f
  (formatter). No publication change, so no realtime restart. Prod untouched.
- **New pgTAP** `generate_po_number_sequence.test.sql`: plan 57. Order is AC-8
  first, then DP-1..DP-5, AC-6/AC-7 formatter, fixtures (two fresh brands,
  stores X/Y in brand B and Z in brand A, a role-`user` member of X only, a
  brand-A admin), AC-1, AC-2, AC-3, AC-5, AC-7 trigger path, AC-9, AC-10,
  AC-11, DP-6 last. AC-1, AC-2 and AC-10 each have an anti-vacuity probe (run as
  the caller) showing RLS really hides the top/colliding row. DP-6 uses
  `throws_ok(…, '54000', <exact message built from next+99>)`, with the
  explicit block inserted `on conflict on constraint
  purchase_orders_po_number_key do nothing`. Two DP-6 assertions beyond the
  design pin D-3's "clears itself" claim: the retry succeeds and takes
  `format_po_number(next + 100)`.
- **Rewritten** `generate_po_number_malformed_guard.test.sql`: plan stays 8, all
  8 assertions kept in the AC-13 order. Absolute `PO-001/002/016/017` became:
  (1) the sequence's next value read as postgres before the insert, (2)/(5)/(7)
  previous generated + 1, and the explicit fixture is `format_po_number(next +
  500)`. Header explains why. The unfiltered `delete from public.purchase_orders`
  is kept, but it now sits at line 70, not 38 (the header grew); see "Noticed,
  not changed".
- **Comment-only** `report_run_variance_formula.test.sql`: the stale
  "substrings positions 4+" text now says the explicit `po_number` is a fixture
  convenience. Fixture unchanged.
- **Smoke** `scripts/smoke-po-number-concurrency.sh` (Track 3, local only): two
  postgres sessions (the "two owner sessions" repro). A inserts and sleeps 3s
  inside its transaction; B inserts once `pg_stat_activity` shows A in
  `pg_sleep`. Checks A and B both commit, B finished while A was still open (no
  wait on the unique index), and both numbers are well formed and distinct.
  Fixed-id rows are deleted before the run and in the EXIT trap.

### Verification

| Check | Result |
|---|---|
| Full pgTAP suite **before** the migration (baseline) | 98/98 files pass |
| `generate_po_number_sequence.test.sql` | 57/57 pass |
| `generate_po_number_malformed_guard.test.sql` | 8/8 pass |
| Full pgTAP suite **after** the migration | 98/99 files pass. `retention_prune_job` (70), `po_loop` (30), `permissive_policy_lint` (5), `public_grants_explicit` (13), `report_run_variance_formula` (7) all pass. The one failure is `order_approvals_approver_snapshot.test.sql`: `column "approved_by_id" does not exist`. Spec 187's session edited its migration (22:26) and test (22:31) to add `approved_by_id` after my baseline run but has not re-applied it to the shared local DB. It fails identically with spec 190 reverted inside a rolled-back transaction (old function body restored, formatter and sequence dropped, then the test run), so it is not caused by this spec |
| `scripts/smoke-po-number-concurrency.sh` | passes: A `PO-1226`, B `PO-1227`, B finished while A was open, both commit; rows cleaned up |
| `npx jest` | 299 suites / 3826 tests pass |
| `npm run typecheck:test` | exit 0 |
| `npm run typecheck` (base) | exit 2, only `TS2688 Cannot find type definition file for '<name> 2'` from duplicate `node_modules/@types/* 2` directories (Finder-style copies). Environment artefact; this spec changes no TypeScript |

Local sequence drift (expected, D-11 #3): after these runs the local sequence is
past 1300, so local dev POs now get 4-digit numbers until the next `db reset`.

### Noticed, not changed

- `supabase/tests/retention_prune_job.test.sql:259-262` still describes the old
  INVOKER `max()` behaviour. Spec 186 is staged but not committed, so per D-6 it
  is left alone. Once 186 lands, its comment can say the explicit `po_number` is
  a fixture convenience (the fixture itself can stay).
- `specs/186-retention-purge-server-job.md` (lines 182, 355, 727) cites
  `generate_po_number_malformed_guard.test.sql:38` for the unfiltered delete. The
  delete is kept but is now at line 70. Spec 186's file was not edited.
- `node_modules/@types/* 2` duplicate directories break base `npm run
  typecheck` locally (not CI). Not touched.

### Fix round 1 (2026-11-09, release-proposal part A items 1-4)

Owner-approved fixes from `specs/190-po-number-sequence/reviews/release-proposal.md`.
No SQL statement in the migration, no function body and no pgTAP assertion
changed; the migration's non-comment lines are byte-identical to before (checked
with `diff` on `grep -v '^--'`). The optional nits (including the `54000` hint
wording) were skipped.

1. **D-9 prod checklist and the migration's PROD-APPLY header comment.** Added
   read-only pre-checks (`current_user = postgres`; the sequence and formatter
   don't exist yet via `to_regclass` / `to_regprocedure`; version
   `20261109140000` not in `schema_migrations`), the DP-1 table-owner /
   `rolbypassrls` query, and a sequence-owner post-check. Replaced the
   `anon=` / `authenticated=` ACL string check with `has_function_privilege` /
   `has_sequence_privilege` for `anon`, `authenticated` and `public`, all
   expected false. The AC-16 post-check now expects `last_value = <pre-check
   max>`, tolerates POs created on prod between apply and check, and always
   requires `last_value + 1` > the current numeric max. Documented the optional
   runbook step of pasting the version insert just before the final `commit;`
   in the text sent to `execute_sql`, and that `apply_migration` must not be
   used. The new queries were run read-only against the local DB and return the
   expected shape (privilege calls all `f`; DP-1 `t, t, postgres`; sequence
   owner `postgres`).
2. **`scripts/smoke-po-number-concurrency.sh`.** If session A never reaches
   `pg_sleep`, the script now prints A's output, terminates A's backend by
   application name and exits 1 without running B. A now holds for 8s
   (`A_HOLD_S`, was 3s), and B times its own insert server-side
   (`clock_timestamp()` before and after, so `docker exec` start-up isn't
   counted) and must finish under `B_MAX_MS` (2000 ms). The "A still open when
   B returned" check is kept as a second signal. Run after the edit: all 7
   checks pass (A `PO-4161`, B `PO-4162`, B's insert 10 ms, 8.9 s wall), exit 0.
   The abort path was exercised with a scratch copy whose readiness query never
   matches: it printed FAIL, exited 1 after about 8s, never ran B, and left no
   fixture rows or session-A backend behind.
3. **`tests/README.md`.** One Track 3 entry: the smoke is manual-only, not part
   of `test:smoke`, needs the local `supabase_db_imr-inventory` container
   (`docker exec psql`, not curl), and each run moves the local sequence up by
   two.
4. **Spec text.** D-11 #4 corrected: `authenticated` does hold TRUNCATE on
   `purchase_orders`; the reset path stays closed because `RESTART IDENTITY`
   needs sequence ownership and no client surface exposes TRUNCATE; the revoke
   is a separate follow-up. The rollback notes in "Prod apply", D-10 and the
   migration's ROLLBACK header comment now say rollback is safe only while every
   `po_number` is below 1000. The D-9 ordering note lists spec 194
   (`20261109170000`) as independent.

Still open, not part of this round: AC-14 on a freshly reset database
(release-proposal item 5, owner-scheduled; `supabase db reset` was not run
because the local database is shared with in-flight specs) and AC-16 (prod
apply, owner-gated).

## Files changed

**Migrations**
- `supabase/migrations/20261109140000_po_number_sequence.sql` (new; fix round 1
  edited header comments only)

**pgTAP tests (Track 2)**
- `supabase/tests/generate_po_number_sequence.test.sql` (new)
- `supabase/tests/generate_po_number_malformed_guard.test.sql` (AC-13 rewrite)
- `supabase/tests/report_run_variance_formula.test.sql` (comment only)

**Shell smokes (Track 3)**
- `scripts/smoke-po-number-concurrency.sh` (new; hardened in fix round 1)

**Docs**
- `tests/README.md` (fix round 1: Track 3 manual-only entry for the smoke)

**Spec**
- `specs/190-po-number-sequence.md` (status, implementation notes, this list;
  fix round 1: D-9, D-10, D-11 #4, "Prod apply" rollback note, fix-round note)

No change to `src/lib/db.ts`, `src/store/`, edge functions, `supabase/config.toml`,
RLS policies, the realtime publication, or `app.json`.

## Handoff
next_agent: code-reviewer, security-auditor, test-engineer, backend-architect
prompt: Review the implementation of this spec. Each reviewer writes its
  findings to specs/190-po-number-sequence/reviews/<your-name>.md. The
  backend-architect runs in post-impl drift-review mode.
payload_paths:
  - specs/190-po-number-sequence.md
  - supabase/migrations/20261109140000_po_number_sequence.sql
  - supabase/tests/generate_po_number_sequence.test.sql
  - supabase/tests/generate_po_number_malformed_guard.test.sql
  - supabase/tests/report_run_variance_formula.test.sql
  - scripts/smoke-po-number-concurrency.sh
  - tests/README.md
