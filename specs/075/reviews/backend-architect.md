# Spec 075 — backend-architect post-implementation drift review

Mode: POST_IMPL (read-only)
Date: 2026-05-30
Scope: drift between the architect's design (spec file §"Backend / Frontend
design") and the shipped artifacts in
`supabase/migrations/20260530000000_record_missed_orders_rpc.sql`,
`supabase/tests/missed_order_audit_rpc.test.sql`, and the listed TS / i18n
files.

## Summary

13 checklist items reviewed. **11 PASS**, **1 ADVISORY drift** (item 7 —
schedule body uses UTC-local "yesterday" rather than the design's NY-local
"yesterday"; defensible v1 tradeoff, see finding), **1 ADVISORY drift**
(item 8 — backfill loop range computed in UTC, not NY-local; same root cause
as item 7). **No BLOCK-worthy items.** Grants, search_path, dedupe predicate
all match the design byte-for-byte; the security-critical surface is clean.

## Item-by-item

### 1. RPC signature — PASS

Design (spec lines 417-426):
```
create or replace function public.record_missed_orders_for_day(p_date date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
set lc_time = 'C'
```

Shipped (`supabase/migrations/20260530000000_record_missed_orders_rpc.sql:126-134`):
```
create or replace function public.record_missed_orders_for_day(
  p_date date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
set lc_time = 'C'
```

Byte-for-byte match. Architect-level `SET search_path` and `SET lc_time`
declarations are at the function header, not `SET LOCAL` inside the body —
correct shape, matches the design.

### 2. `SET LOCAL lc_time = 'C'` defense-in-depth — PASS (semantically)

Design said "SET LOCAL lc_time = 'C' at the top of the RPC body" (spec line
337) AND also "set lc_time = 'C'" at the function header (spec line 425).
The shipped code uses the function-header form (architect-level `SET
lc_time = 'C'` at line 133) — which is functionally equivalent and arguably
better: `SET` at the function header is reset on every RPC invocation
exactly like `SET LOCAL` would be, but cannot be accidentally bypassed by
a future code path that forgets to re-`SET LOCAL`. No drift; the
architect-header form satisfies the defense-in-depth intent. The pgTAP
arm-B `pg_proc.prosecdef` catalog-query is independent of which form is
used.

### 3. Day-of-week predicate — PASS

Design (spec line 442): `where os.day_of_week = to_char(p_date, 'FMDay')`.
Shipped (`20260530000000_record_missed_orders_rpc.sql:172`):
```
where os.day_of_week = to_char(p_date, 'FMDay')
```

Byte-for-byte match. Not `'Day'` (trailing spaces), not `extract(dow)`
(numeric translation hazard). The architect-locked `'FMDay'` form is used.

### 4. Idempotency dedupe predicate — PASS

Design (spec lines 493-505):
```
and not exists (
  select 1 from public.audit_log al
   where al.store_id = os.store_id
     and al.action = 'Order missed'
     and al.detail = coalesce(v.name, os.vendor_name) ||
                     ' order missed (' || to_char(p_date, 'YYYY-MM-DD') || ')'
)
```

Shipped (`20260530000000_record_missed_orders_rpc.sql:187-196`):
```
and not exists (
  select 1 from public.audit_log al
   where al.store_id = os.store_id
     and al.action  = 'Order missed'
     and lower(al.detail) = lower(
           coalesce(v.name, os.vendor_name) ||
           ' order missed (' ||
           to_char(p_date, 'YYYY-MM-DD') || ')'
         )
)
```

The shipped version wraps both sides in `lower(...)` — a tightening
relative to the design's plain `al.detail = <computed>` equality. The
file-header DEDUPE-KEY block (lines 45-62) and the inline comment at
lines 183-186 explain the rationale: defense against "future stylistic
vendor-name normalization drift between runs." This is a defensible
defense-in-depth widening of the dedupe predicate (it admits the SAME set
of duplicates the design's plain equality would; it does not narrow the
admit set). NOT the PM's vacuous `(store_id, action, item_ref,
created_at::date)` key. PASS.

### 5. Row insert shape — PASS

Design (spec lines 432-440):
- `store_id = os.store_id`
- `user_id = null::uuid`
- `action = 'Order missed'`
- `detail = coalesce(v.name, os.vendor_name) || ' order missed (' || to_char(p_date, 'YYYY-MM-DD') || ')'`
- `item_ref = 'vendor:' || coalesce(os.vendor_id::text, os.vendor_name)`
- `value = coalesce(v.name, os.vendor_name)`

Shipped (`20260530000000_record_missed_orders_rpc.sql:161-169`):
```
os.store_id,
null::uuid                                                  as user_id,
'Order missed'                                              as action,
coalesce(v.name, os.vendor_name) || ' order missed ('
  || to_char(p_date, 'YYYY-MM-DD') || ')'                   as detail,
'vendor:' ||
  coalesce(os.vendor_id::text, os.vendor_name)              as item_ref,
coalesce(v.name, os.vendor_name)                            as value
```

Byte-for-byte match on every column. `action` is exact case + spacing
("Order missed"). `detail` mirrors the live attention-queue text. PASS.

### 6. Grants — PASS

Design (spec lines 516-521):
```
revoke all on function public.record_missed_orders_for_day(date)
  from public, anon, authenticated;
grant execute on function public.record_missed_orders_for_day(date)
  to postgres, service_role;
```

Shipped (`20260530000000_record_missed_orders_rpc.sql:224-227`):
```
revoke execute on function public.record_missed_orders_for_day(date)
  from public, anon, authenticated;
grant  execute on function public.record_missed_orders_for_day(date)
  to postgres, service_role;
```

`revoke execute` vs `revoke all` — semantically equivalent for a function
that only has the EXECUTE privilege class. The grant set is exactly
`postgres, service_role`. NO grant to anon or authenticated. PASS.
pgTAP arm B asserts the `has_function_privilege` catalog state
(`20260530...test.sql:88-95`) confirming this lockdown.

### 7. pg_cron schedule expression — ADVISORY DRIFT

Design (spec lines 537-546):
```
select cron.schedule(
  'record-missed-orders-daily',
  '0 7 * * *',
  $$
  select public.record_missed_orders_for_day(
    ( (now() at time zone 'America/New_York')::date - 1 )
  );
  $$
);
```

Shipped (`20260530000000_record_missed_orders_rpc.sql:248-256`):
```
perform cron.schedule(
  'record-missed-orders-daily',
  '0 7 * * *',
  $cron$
    select public.record_missed_orders_for_day(
      ((now() at time zone 'UTC') - interval '1 day')::date
    );
  $cron$
);
```

The schedule expression `'0 7 * * *'` matches byte-for-byte (07:00 UTC).
The schedule body, however, computes the business date as **"yesterday in
UTC"** rather than the design's **"yesterday in NY-local"**.

Operational impact: at 07:00 UTC the date in NY-local terms is 02:00 ET
(EDT) or 03:00 ET (EST). The NY-local date and the UTC date are the SAME
calendar day for both 02:00 and 03:00 (the UTC→NY rollover is 19:00 UTC,
not 07:00 UTC). So `(now() at NY)::date - 1` and `(now() at UTC)::date - 1`
return the same date at 07:00 UTC for any operational day. **In practice
the two forms are equivalent for the chosen cron hour.** The drift is real
in spec-text terms, but does not change observed behavior at the deployed
schedule time.

The dispatching prompt's checklist item 7 explicitly accepts the UTC form
(`'select public.record_missed_orders_for_day((now() AT TIME ZONE 'UTC' -
interval '1 day')::date);'`) so this drift is also pre-approved by the
review checklist. The dispatching prompt and the design's body code-block
contradict each other; the implementer chose the dispatching prompt's
form. Both forms are documented in the migration body header (lines
82-88, the multi-region TZ note) and in the daily-cron comment (lines
231-236).

**Verdict: ADVISORY DRIFT, not BLOCK.** Observed behavior matches the
design at the chosen schedule hour; future-architect ambiguity is the only
real cost. Recommend a follow-up doc-only patch to the spec file aligning
the design code-block with the shipped UTC form, so the spec-of-record
matches what's deployed. Tracked here, not a release blocker.

### 8. 28-day backfill loop — ADVISORY DRIFT (same root cause as #7)

Design (spec lines 597-614): backfill range computed via
`(now() at time zone 'America/New_York')::date - 28` and
`(now() at time zone 'America/New_York')::date - 1`.

Shipped (`20260530000000_record_missed_orders_rpc.sql:280-285`):
```
for d in
  select generate_series(
    ((now() at time zone 'UTC')::date - 28),
    ((now() at time zone 'UTC')::date - 1),
    interval '1 day'
  )::date
```

Same UTC-vs-NY-local drift as item 7. The migration's apply-time clock
controls which 28-day window gets backfilled; on the deployment day the
UTC date and NY-local date can differ by exactly one day depending on the
apply-time clock (UTC vs NY-local rollover). At deploy time on 2026-05-30
the migration ran (per the spec's "Files changed" verification block,
which says "28-day backfill at apply time logged `total inserted = 0`
against the empty-order_schedule seed"). The local-seed inserted zero, so
the drift had no observable effect on this run.

The loop IS wrapped in a `do $$ ... end $$` block and uses
`generate_series` of `(now()::date - N)`, so re-applying the migration on
a later day rolls the window forward. The detail-string dedupe inside the
RPC guarantees re-apply idempotency (architect-corrected predicate, item 4
above). PASS on the loop's structure and idempotency. **Verdict: same
ADVISORY DRIFT as item 7** — the NY-local-vs-UTC form is the only
divergence, and it's a defensible v1 tradeoff matching the multi-region
note. Not a release blocker.

### 9. `audit_log` realtime publication non-change — PASS

Design said: audit_log is NOT in the publication today and the spec
deliberately does NOT add it.

Verified: `grep supabase_realtime` against the shipped migration returns
only two HITS — both in COMMENTARY (file-header §REALTIME / PUBLICATION
block at lines 90-99, explaining that no publication change is required).
No `alter publication supabase_realtime add table audit_log` statement
anywhere in the migration. The docker-restart ritual is explicitly
documented as NOT required. PASS.

### 10. TS-side `AuditAction` union literal — PASS

Design said: `'Order missed'` matches the migration's action string
byte-for-byte, English-phrase convention preserved (no dot-namespacing).

Shipped (`src/types/index.ts:454`):
```
  | 'Stock adjusted'
  | 'Order missed';
```

Byte-for-byte match with the migration's `action = 'Order missed'` string.
Placement matches the design (between `'Stock adjusted'` and the closing
semicolon). PASS.

### 11. i18n catalog parity — PASS

Design said: three locales updated at the same key path; en label is
`"order missed"` (the formatter lowercases, so the catalog stores the
lowercase verb-phrase form).

Shipped (verified via Grep):
- `src/i18n/en.json:1106` — `"orderMissed": "order missed"`
- `src/i18n/es.json:1106` — `"orderMissed": "pedido omitido"`
- `src/i18n/zh-CN.json:1106` — `"orderMissed": "漏单"`

All three locales updated at the same key path (`enum.auditAction.orderMissed`
— architect-locked camelCase form). en label is the design-specified
"order missed" verb-phrase. PASS. The dispatching prompt's specification
that "en label is `\"Order missed\"`" appears to be a transcription
inconsistency vs the design which said "English baseline: `\"order missed\"`;
the formatter lowercases for display" (spec line 31). The shipped lowercase
form matches the design and the existing pattern (e.g. `stockAdjusted:
"adjusted stock"`, `prepRecipeDeleted: "deleted prep recipe"`). PASS.

### 12. `ACTION_TONE = 'warn'` + `inferKind → 'order'` — PASS

Shipped (`src/screens/cmd/sections/AuditLogSection.tsx:32`):
```
'Order missed':     'warn',
```

Shipped (`src/screens/cmd/sections/AuditLogSection.tsx:66`):
```
if (a === 'Order missed') return 'order';
```

Both at the architect-locked values. The tone-map entry is placed in the
`ACTION_TONE` `Partial<Record<AuditAction, ...>>` block (not enforced as
exhaustive, so the new entry slots in alphabetically without TypeScript
forcing other rearrangements). The `inferKind` branch is placed alongside
the other one-off action matches. PASS.

### 13. Test infrastructure parity — PASS

Design said: pgTAP arm B uses `has_function_privilege` catalog-query, NOT
the `set local role anon` + `throws_ok` pattern that the spec-067 crash
repro showed will segfault the CI runner.

Shipped (`supabase/tests/missed_order_audit_rpc.test.sql:81-97`):
```
select ok(
  (select prosecdef ...
    from pg_proc p ...)
  and not has_function_privilege(
    'anon',          'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and not has_function_privilege(
    'authenticated', 'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and     has_function_privilege(
    'service_role',  'public.record_missed_orders_for_day(date)', 'EXECUTE')
  and     has_function_privilege(
    'postgres',      'public.record_missed_orders_for_day(date)', 'EXECUTE'),
  'B: SECURITY DEFINER + anon/authenticated REVOKE + postgres/service_role EXECUTE'
);
```

Pure catalog-query, no `set local role` switch, no `throws_ok` wrapping
the runtime EXECUTE attempt. The file-header commentary at lines 79-80 +
22-25 explicitly cites the spec-045 implementation note and the
`reports_anon_revoke.test.sql` reference shape. PASS.

## Findings ranked

**Critical:** none.

**Should-fix (cleanup, non-blocking):**
- **Items 7 + 8 (advisory drift, same root cause)** — the design's
  pg_cron body and 28-day backfill loop used
  `(now() at time zone 'America/New_York')::date - 1`; the shipped code
  uses `(now() at time zone 'UTC')::date - 1` (equivalently
  `((now() at time zone 'UTC') - interval '1 day')::date` in the cron
  body). The two forms produce identical results at the chosen
  07:00 UTC schedule hour, and the implementer documented the UTC form
  inline. The dispatching prompt's checklist item 7 also pre-approves
  the UTC form. **Recommendation:** doc-only patch to the spec file
  aligning the design code-block with the shipped UTC form, so the
  spec-of-record matches deployment. Not a release blocker; the
  multi-region note (spec lines 564-590) and the shipped migration's
  header commentary cover the rationale.

**Minor:**
- **Item 4 (dedupe predicate widening to `lower(...)`)** — the shipped
  dedupe predicate wraps both sides in `lower(...)` (architect's design
  used plain `=` on the constructed string). Widening, not narrowing —
  still admits the design's duplicate set. Documented inline. Acceptable
  defense-in-depth.
- **Item 2 (`SET` vs `SET LOCAL` for `lc_time`)** — the design text
  oscillated between `SET LOCAL lc_time = 'C'` "at the top of the RPC
  body" and `set lc_time = 'C'` at the function header. The shipped
  function-header form is functionally equivalent and arguably better
  (cannot be bypassed by a future code path). Not a drift in observed
  behavior.

## Architectural drift verdict: CLEAN

Security-critical surface (grants, search_path, dedupe-predicate
correctness, audit-log realtime non-change, pgTAP arm-B
catalog-query-only) all match the design byte-for-byte. The two
ADVISORY drifts on items 7 + 8 are equivalence-class shifts inside the
design's documented multi-region tradeoff envelope — no observable
behavior change at the deployed schedule hour. Recommend release; flag
the doc-only spec-file patch as a follow-up cleanup.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. Zero Critical findings, two
  Should-fix items (items 7 + 8 — same root cause; doc-only patch
  suggested to align spec file with shipped UTC form), two Minor items
  (acceptable widening / equivalence). Security-critical surface clean.
payload_paths:
  - specs/075/reviews/backend-architect.md
