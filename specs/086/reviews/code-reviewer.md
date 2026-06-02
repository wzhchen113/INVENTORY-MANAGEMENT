# Code review for spec 086

## Critical

None.

---

## Should-fix

### S1 — `eodQueue.ts:165` — Idempotency guard lets `'[]'` through, inconsistent with its own comment

The guard reads:

```ts
if (existingV2 != null && existingV2 !== '' && existingV2 !== '[]') {
  return;
}
```

The comment above it says "if v2 already holds anything, the migrate has run…do not touch v1's bytes here." But `'[]'` (a valid, non-null, non-empty string) falls through the guard and triggers a re-migration attempt. `persistQueue([])` — which fires when every v1 entry fails `migrateV1Entry` — writes `'[]'` under the v2 key and then calls `removeItem(V1_QUEUE_KEY)` with `.catch(() => {})` silently swallowing any failure.

If `removeItem` fails on the first mount, v1 survives and v2 = `'[]'`. On the next mount, `'[]'` passes the guard, v1 is re-read, and the result is written over v2. In normal operation this is idem potent (all-malformed entries → empty again → same result). But the guard's intent was to protect v2 from being overwritten after it has been populated by a successful enqueue, and the comment's claim ("if v2 already holds anything") is false for `'[]'`. The code is safe only because the re-migration of a still-malformed v1 produces the same empty output; a maintainer who sees `'[]'` as the trigger for "needs migration" and writes entries directly to v2 before the migrate runs (impossible today, but a future path) would be surprised.

**Suggested fix:** Add `'[]'` to the "already migrated" branch, not the "needs migration" branch. The simplest change is:

```ts
const existingV2 = await safeRead(QUEUE_KEY);
let v2IsPopulated = false;
if (existingV2 != null && existingV2 !== '') {
  try {
    const parsed = JSON.parse(existingV2);
    if (Array.isArray(parsed) && parsed.length > 0) v2IsPopulated = true;
  } catch {
    // corrupt v2 — treat as empty, allow migrate to proceed
  }
}
if (v2IsPopulated) return;
```

Alternatively, document explicitly that `'[]'` is intentionally treated as "migration not yet run" and add a code comment to `migrateQueueIfNeeded` clarifying that re-migration of an all-malformed v1 is idempotent. The current comment says the opposite of the code's actual behavior, which is the core problem.

---

### S2 — `EODCount.tsx:608-612` — Live-total render variables `cp`/`up` are more cryptic than the submit-path names

The `renderItem` callback uses `cp`/`up` for the parsed case/unit values:

```ts
const cp = parseFloat(caseRaw);
const up = parseFloat(unitRaw);
const total =
  (Number.isNaN(cp) ? 0 : cp) * (item.caseQty || 1) +
  (Number.isNaN(up) ? 0 : up);
```

The `onSubmit` handler for the same logic (lines 354-358) uses `casesParsed`/`unitsParsed`, which is clear. The render path is read in the same file by anyone debugging the live total, and `cp`/`up` require a mental lookup to connect to "cases parsed" and "units parsed." The formula is otherwise byte-identical to the admin worksheet, so keeping the names consistent with the submit path would make it easier to confirm the two are equivalent.

**Suggested fix:** Rename `cp`/`up` to `casesParsed`/`unitsParsed` (or `casesP`/`unitsP` if the shorter form is preferred) in the `renderItem` local scope.

---

## Nits

### N1 — `eodQueue.ts:162-163` — Stale v1 key never cleaned up in the idempotent early-return path

When `migrateQueueIfNeeded` returns early (v2 is non-empty), any surviving v1 key is left in place indefinitely. The comment acknowledges this ("We still leave a stale v1 key in place in that case; it is inert — nothing reads it once v2 exists, and clearing it is not worth a second write on every mount"). The reasoning is sound. Consider adding a one-time cleanup in a future spec if v1 accumulation in storage shows up in support reports, but it's not a bug today.

### N2 — `supabase/tests/staff_submit_eod_cases_each.test.sql:67-68` — Fixture silently no-ops when seed is missing the store

The fixture resolves `v_frederick` and `v_charles` by `stores.name`. If either `name` is absent from the seed, `SELECT INTO` leaves the variable NULL and subsequent RPC calls silently use `NULL::uuid`. The `set_config('test.client_a', ...)` line would still succeed. Consider adding `if v_frederick is null then raise exception '...' end if;` guards (same defensive pattern some other pgTAP files in the suite use). Not a correctness bug on the current seed; a safety net for future seed refreshes.

### N3 — `eodQueue.ts:121-140` — `V1EodEntry` type defined but `migrateV1Entry` casts to `Partial<V1EodEntry>` unnecessarily

`V1EodEntry` is typed `{ item_id: string; count: number }` and immediately cast to `Partial<V1EodEntry>`. Since `migrateV1Entry` checks `typeof e.item_id !== 'string' || typeof e.count !== 'number'` anyway, the `Partial` wrapper adds nothing and slightly misleads — if both fields are present, the guard is the real validator. Could be typed as `Partial<V1EodEntry>` from the start by casting `x as Partial<V1EodEntry>` and dropping the intermediate named type, or just keep `as Record<string, unknown>` which is what `hydrateQueue` and the migrate loop above use for consistency. Minor inconsistency.

### N4 — `EODCount.tsx:604` — `hasPack` computed as `(item.caseQty ?? 0) > 1`; note that `caseQty = 1` suppresses the label even though the Cases box still works

When `caseQty` is explicitly `1` from the catalog (not null), `hasPack = false` and the `· case of {qty}` sub-label is hidden and the live-total line is suppressed. The Cases box is still rendered and functional (it multiplies by `1`). This matches the spec's intent ("surface the multiplier label only when it changes the math"), but a `caseQty = 1` item gives no visual feedback that Cases is doing anything — a staff member might wonder why there are two boxes for an item labeled only by its unit. This is a product-level call, not a bug, but worth surfacing to the PM if user confusion is observed.

### N5 — `supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql:254-261` — GRANT non-emission comment block is thorough but longer than the actual code it explains

The three-line GRANT comment block is more words than the combined Hunk A + Hunk B diffs. This is not wrong — the explanation is correct and the rationale is sound — but future readers searching for the actual GRANT statement will find only the comment. The comment correctly states the GRANTs survive via `create or replace`. Fine as-is; flagging only because the asymmetry between comment length and code length is noticeable.

---

## Summary

The implementation is well-crafted. All three acceptance-criteria pillars (RPC migration, staff queue key-version bump + read-once migrate, and the dual-input screen) are correctly implemented and tested across all four tracks. The SQL migration is a faithful two-hunk additive change with excellent documentation. The `migrateQueueIfNeeded` logic is crash-safe (write-v2-then-remove-v1 ordering at lines 225-226) and handles malformed bytes without throwing. The `migrateV1Entry` mapping (`count → { actual_remaining: count, _cases: null, _each: count }`) is correct and clearly commented. The only craftsmanship concern worth addressing before merge is the idempotency guard (S1), whose comment contradicts the code's behavior for the `'[]'` case — harmless in practice today but a trap for the next person who touches this file.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in; the 5 Nits + the architect's 2 Minors deferred (cosmetic).

- **S1 (`eodQueue.ts` idempotency-guard comment ↔ code contradiction)** — **fixed (comment-only).** The guard's behavior is intentional and correct (an absent/empty `'[]'` v2 is treated as not-yet-populated so a v1 with real entries can still migrate; re-running into an empty v2 is idempotent). Reworded the comment to state exactly that, removing the "if v2 holds anything" wording that contradicted the `'[]'` fall-through. No code/behavior change.
- **S2 (`EODCount.tsx:608-612` `cp`/`up` naming)** — **fixed (rename).** `cp`/`up` → `casesParsed`/`unitsParsed`, matching the clearer names used for the identical formula in `onSubmit`. No behavior change.
- **Deferred (cosmetic, no correctness impact):** the 5 code-reviewer Nits, plus the architect's 2 Minors (the stale `EODCountSection.tsx:60` admin comment; `Number.isNaN` vs the admin's `isNaN` — the former is actually the stricter/correct choice).

Re-verified post-fix-pass: `npx jest src/screens/staff/screens/EODCount src/screens/staff/lib/eodQueue` → 36/36 green; `npx tsc --noEmit` (base) exit 0. Both edits are inert (a comment + a local rename).
