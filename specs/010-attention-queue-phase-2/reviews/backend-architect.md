# Spec 010 — Backend-architect post-impl drift review

Reviewer: backend-architect (post-impl mode)
Spec: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/010-attention-queue-phase-2.md
Mode: drift review (READY_FOR_BUILD on entry; Status NOT mutated per
post-impl rules)
Scope: backend slice + thin frontend touch-points the design dictated
(modal contract, click-scope, auto-stamp gating). Aesthetics + UX
chrome are not architect-owned; left for the test-engineer / code-
reviewer fan-out.

## Decisions checklist

| Decision | Architect spec | Implementation | Verdict |
|---|---|---|---|
| A1 — row-level on `inventory_items.expiry_date` | §0/§1 | Schema delta = `int default_shelf_life_days` on `catalog_ingredients` only; `inventory_items.expiry_date` reused as designed | RESOLVED |
| A2 — narrowed (c): default + IngredientForm override; receiving = display + auto-stamp only | §0/§5/§6 | Auto-stamp branch lives in `commitReceive` (ReceivingSection.tsx:129-139); display column added; per-line override deliberately absent | RESOLVED |
| A3 — system-wide constants exported from `cmdSelectors.ts` | §0/§3 | `EXPIRY_HIGH_HOURS=24`, `EXPIRY_MED_HOURS=72`, `EXPIRY_LOW_HOURS=168` exported alongside `TARGET_FOOD_COST_PCT_DEFAULT` (cmdSelectors.ts:684-686) | RESOLVED |
| A4 — modal drill-down hosted on DashboardSection; click-scope = expiry rows only | §0/§4 | Modal hosted in `DashboardSection` (DashboardSection.tsx:430-435); click gate in `StoreCol` (DashboardSection.tsx:869-878) wraps only `rule === 'expiry' && !!expiryDetail`; other 4 rules stay non-interactive | RESOLVED |
| Per-store RLS via `auth_can_see_store()` | §7 | Migration adds an additive column on `catalog_ingredients`; brand-scoped policy from spec 005 P5 still gates writes; no new RLS work needed | RESOLVED |
| `db.ts` is the only DB surface | §2 | `fetchCatalogIngredients` mapper extended; new `updateCatalogIngredient`; new pure `computeExpiryFromShelfLife`; `useStore.updateCatalogIngredient` is the only write path the form/drawer use | RESOLVED |
| `expiryDetail` snapshot is JSON-serializable | §3 | Type matches design (sev/items/totalDollarAtRisk); items have all five required fields; values are primitives (numbers + strings) | RESOLVED |
| Realtime publication membership | §1/§7 | Unchanged. `catalog_ingredients` already on the publication; no `docker restart supabase_realtime_imr-inventory` needed | RESOLVED |
| `verify_jwt` / edge function changes | §7 | None. No edge function touched | RESOLVED |
| `app.json` slug, legacy stores, `AdminScreens.tsx` | spec preamble | Untouched. `useStore.ts` got the new action; legacy stores intact | RESOLVED |
| Date-parsing for severity bucket | §3 | DEVIATED. See §3 finding below — architect-acknowledged correctness fix | DEVIATED (acknowledged) |
| Migration filename | §1 | DEVIATED. `20260508130000_spec010_catalog_default_shelf_life.sql` instead of `20260506120000_expiry_tracking.sql` — bumped past spec 008's `20260508120000` per dev rationale; sort order intact | DEVIATED (benign) |

Overall: 0 Critical, 1 Should-fix, 3 Nits.

## Critical (none)

No contract drift, no security gap, no broken acceptance criteria.

## Should-fix

### S1 — `computeExpiryFromShelfLife` reads "today" via `toISOString().slice(0,10)` (UTC), but the auto-stamp caller intends "store-local today"

File: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReceivingSection.tsx:132-135
File: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts:1622-1634

`commitReceive` calls
`computeExpiryFromShelfLife(new Date().toISOString().slice(0, 10), shelfLife)`.
`toISOString()` always returns UTC. On a UTC-4 manager who receives a
delivery at 9pm local on 2026-05-09, `new Date().toISOString().slice(0,10)`
returns `'2026-05-10'` — auto-stamp lands one day late. Symmetric bug
on UTC+ timezones receiving early in the morning.

This is the same TZ-class bug the dev correctly flagged in the §3
selector deviation, and the dev's fix there is the correct shape: read
local-clock date components, not UTC. The fix here is a one-liner at
the call site (use a local-time `YYYY-MM-DD` builder) or inside
`computeExpiryFromShelfLife` itself (accept a `Date`, do local
arithmetic, return a local `YYYY-MM-DD`).

Why not Critical: receiving is a Tier-1 mock today (no `po_items`
table). The auto-stamp is a real DB write to `inventory_items.expiry_date`,
but the operator can override via the IngredientFormDrawer if the
auto-stamped date is off by one. The bug exists; the blast radius is
small while receiving is mock. Worth fixing before receiving promotes
to a real surface — flag it now so it's in the queue.

Suggested fix shape (architect-equivalent — dev picks one):
- caller: build the local date string (`String(now.getFullYear()) + '-' + ...`)
  or use `Date(year, month, day).toLocaleDateString('en-CA')`
- helper: accept `Date | string`, branch on input type, do
  `setUTCDate(getUTCDate() + days)` after constructing from local components

The selector's existing pattern at cmdSelectors.ts:886-888 is the
canonical shape — mirror it.

## Nits

### N1 — `updateCatalogIngredient` writes a synthetic `updated_at` not gated by triggers

File: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts:1606

The helper sets `row.updated_at = new Date().toISOString()`. That
matches the pattern in `updateInventoryItem` (db.ts:136), so
consistent — but if `catalog_ingredients` already has a Postgres
`updated_at` trigger from the brand-catalog refactor, this is a
redundant client-side write that gets overwritten anyway. Cheap
either way; flagging only because the other catalog write paths
(e.g. updateRecipe) do it the same way and it'd be cleaner to drop
this everywhere if a trigger exists. Out of scope for this spec —
log it for a follow-up cleanup.

### N2 — `formatHours` rounding produces a "0h" → coerced to `<1h` on the boundary, but never shows a minute-resolution label

File: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/ExpiringItemsModal.tsx:313-327

Hours below 1 collapse to `<1h`. Hours between 1 and 23 round to
nearest hour. That's fine for the alert horizon, but a 30-min-out
item shows the same label as a 59-min-out item. Architect §4 said
"days/hours to expiry as a human label", which this satisfies.
Surface only because it's an obvious thing for a minute-resolution
follow-up; not a defect.

### N3 — `shortExpiry` uses `getUTCMonth()` / `getUTCDate()` while the bucket math uses local-time

File: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReceivingSection.tsx:18-24

`new Date('2026-05-09').getUTCDate()` returns 9 (parsed as UTC); on
UTC-7, `getDate()` would return 8. Since `inventory_items.expiry_date`
is a date column (no TZ), reading via UTC accessors is the conservative
choice — they match the literal stored date — but the rest of this
file's date logic uses local components (the auto-stamp helper, by
extension). Inconsistent shape. Pick one and flag a comment.

Architect-leaning: `getUTC*` is correct for date-typed columns and
this is fine as-is; it's the auto-stamp call site (S1) that drifts
from this file's own convention, not vice versa.

## Architect §3 deviation acknowledgement (date parsing)

The dev's deviation notice in spec build notes is correct:

> Architect's §3 pseudocode had `new Date(item.expiryDate)` then
> `.setHours(23,59,59,999)`. That treats the date string as UTC midnight
> and then end-of-day in local time — which double-shifts and breaks
> the "expires today" = "you have until close" semantic on machines
> outside UTC.

Verified: `new Date('2026-05-08')` parses as `2026-05-08T00:00:00Z`.
On a UTC-4 box at 10am local (`14:00 UTC`), calling `.setHours(23,59,59,999)`
mutates to `2026-05-08T23:59:59` *in local time* = `2026-05-09T03:59:59Z`
— which is positive relative to now (good), but the semantic is "until
3:59am local tomorrow", not "until close tonight". The shift is one
calendar day in either direction depending on local offset.

The dev's replacement (cmdSelectors.ts:886-888):
```
const m = String(item.expiryDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
if (!m) continue;
const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
```
constructs a `Date` whose underlying ms = "local end-of-day of the
stored calendar date". That matches the operator's mental model
("expires today = until close tonight") regardless of TZ. Same shape
as `isPastDeadline` at cmdSelectors.ts:696-703.

Verdict: architect-acknowledged correctness fix. Original §3
pseudocode was the bug; dev's implementation is the right shape.
Promoting this to spec history so any future selector pattern uses
the local-time literal-component construction.

## Snapshot shape adequacy (spec ask #6)

Modal consumes (ExpiringItemsModal.tsx):
- `detail.sev` — used for pill mapping (line 52-55)
- `detail.items.length` — count (line 132)
- `detail.totalDollarAtRisk` — header sum (line 143)
- `it.itemId` — React key (line 225)
- `it.itemName` — name column (line 241)
- `it.hoursToExpiry` — sort + color + label (lines 247, 253)
- `it.unit` — unit column (line 265)
- `it.dollarAtRisk` — $ column (line 277)

Snapshot type provides exactly those fields (cmdSelectors.ts:658-668).
Zero re-derivation; no missing data; the modal renders without
calling back into the store. This is the cleanest snapshot pattern
in the codebase — consider promoting it as the template for any
future drill-down rule (e.g. food-cost streak detail, low-stock
list).

## Receiving auto-stamp gating (spec ask #7)

ReceivingSection.tsx:129-139:
```
if (!item.expiryDate) {
  const catalog = catalogIngredients.find((c) => c.id === item.catalogId);
  const shelfLife = catalog?.defaultShelfLifeDays ?? null;
  const computed = computeExpiryFromShelfLife(...);
  if (computed) updateItem(item.id, { expiryDate: computed });
}
```

Gating matches architect §5: only fires when (a) row has no current
expiry AND (b) catalog has a non-null shelf life. The `computed`
truthiness gate also short-circuits when `computeExpiryFromShelfLife`
returns null (negative / NaN / missing), so a malformed catalog row
can't write garbage. Good.

Receiving being mock (Tier-1) does not invalidate this — the auto-stamp
writes through to the real `inventory_items.expiry_date` on the same
row that `adjustStock` bumps. When receiving promotes to a real
`po_items`-backed surface, this branch carries over verbatim; the
only thing that changes is which line drives the loop. The §9 flag
about per-line override (which would need `po_items`) is unchanged.

## Architect-level open flags revisit (§9)

| Flag | Status post-impl |
|---|---|
| #1 — A2 narrowed (no per-line override on receiving) | Held. No `po_items` work attempted. Surface for user decision. |
| #2 — Click-to-drill scoped to expiry only | Held. StoreCol wraps only `rule === 'expiry'`. |
| #3 — `expiry_date` stays `date` | Held. No type change. |
| #4 — Already-expired rolls into HIGH | Held. Modal renders "expired N days ago" distinctly. |
| #5 — No notification push | Held. In-app only. |

No new architect-level flags raised by the implementation. S1 is a
correctness fix, not a design change.

## Files reviewed

- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/types/index.ts (lines 35-54)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts (lines 1563-1634)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/cmdSelectors.ts (lines 644-928)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/store/useStore.ts (lines 64-75, 475-492)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/IngredientForm.tsx
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/IngredientFormDrawer.tsx
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/ExpiringItemsModal.tsx
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/DashboardSection.tsx (lines 1-435, 670-940)
- /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/screens/cmd/sections/ReceivingSection.tsx

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix
  (TZ bug in `commitReceive` auto-stamp call site — same class as the
  selector bug the dev correctly fixed in §3), 3 Nits. Architect's §3
  pseudocode was buggy; dev's local-time replacement is acknowledged as
  the correct shape. All A1-A4 decisions resolved as designed.
payload_paths:
  - specs/010-attention-queue-phase-2/reviews/backend-architect.md
