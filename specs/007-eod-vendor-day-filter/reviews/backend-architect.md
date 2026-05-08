# Spec 007 — backend-architect drift review

Mode: post-impl drift. Comparing committed implementation against the
`## Backend design` section I authored (§0–§12). Craftsmanship is
code-reviewer's lane; I'm only flagging architectural drift.

## Verdict at a glance

No Critical drift. Two Should-fix items (one is a contract divergence
already documented in build notes; one is a stale design claim that
deserves a written correction in the spec). Five nits — mostly small
deviations from §6 details that the developers made the right call on.

The §1 schema migration, §3 write contract semantics, §4 RLS posture,
§5 realtime decision, §6 file-level surfaces, §8 REST-day enforcement,
§9 `__all__` guard, and §11 architect-level recommendations all landed
as designed.

---

## Critical

None.

The design contract is intact: per-cell add/remove helpers + unique
constraint + per-store fallback semantics + REST-day input disable +
`__all__` empty state are all wired the way §1–§9 specified. RLS is
unchanged (§4 was "no work required"); realtime publication is
unchanged (§5 was "no migration"); no edge function touches; no legacy
file edits. The TZ fix-pass also didn't break the contract — it
hardened the input to the day-of-week derivation that §0 Probe 5 was
already pinning to TitleCase.

---

## Should-fix

### S1. §6 store-action naming: my proposed names were dropped, but the design was never updated to reflect that

**Location:** [src/store/useStore.ts:120-126](../../src/store/useStore.ts:120),
spec §6 row "`src/store/useStore.ts` — NEW actions
`addScheduledVendor`, `removeScheduledVendor`".

**Drift:** §6 still reads `addScheduledVendor` / `removeScheduledVendor`.
Implementation shipped `addOrderScheduleEntry` /
`removeOrderScheduleEntry` (mirroring the `db.ts` helper names). The
backend-dev's `### Backend pass` build note (lines 1180–1190) and the
frontend-dev's `### Frontend pass` note (lines 1217–1219) both surface
the rename intentionally — but §6 still claims the old names.

**Architect re-evaluation:** the dev's choice is **better than mine**.
The two-name pair (`db.addOrderScheduleEntry` ↔
`useStore.addOrderScheduleEntry`) is the dominant idiom in this
codebase. My split (`db.addOrderScheduleEntry` ↔
`useStore.addScheduledVendor`) made readers track two names for one
operation across two layers, with no payoff. **Endorsed in retrospect.**

**Action:** non-blocking. Either (a) leave §6 alone since the build
notes already capture the deviation, or (b) when the spec is closed
out, sync §6's table cell to match shipped code so future readers
aren't double-checking which names are real. Lean (b) but it's a
documentation polish, not a release blocker.

---

### S2. §3a contract divergence on `deliveryDay` — design said optional, table says NOT NULL

**Location:** [src/lib/db.ts:1554-1560](../../src/lib/db.ts:1554),
[src/store/useStore.ts:1066-1067](../../src/store/useStore.ts:1066),
spec §3a helper signature.

**Drift:** my §3a signature listed `deliveryDay?: string` (optional).
But `order_schedule.delivery_day` is `text NOT NULL` per
[20260502071736_remote_schema.sql:101](../../supabase/migrations/20260502071736_remote_schema.sql).
A caller that omits `deliveryDay` would have hit a NOT NULL constraint
violation at runtime. Backend-dev resolved this by defaulting to the
`day` argument when callers omit it (db.ts line 1560:
`delivery_day: vendor.deliveryDay ?? day`). Store action mirrors the
same fallback (useStore.ts line 1067).

**Architect re-evaluation:** I should have caught this in §0/§3 — it's
a probe I didn't run. My §0 Probe 4 covered `vendors.brand_id` and
Probe 5 covered `day_of_week` format, but no probe touched the
nullability of `delivery_day` even though I cited the column in §3.
The dev's resolution is reasonable (the `day === delivery_day` default
matches `saveOrderSchedule`'s practical pattern, where the day-of-week
and delivery-day are usually the same in this UX). **Endorsed.**

**Future-template improvement:** §0 probes should include a
`\d <table>` schema dump for every table the design writes to, not
just FK / brand-scope checks. NOT NULL columns are the cheap miss.

**Action:** non-blocking. Worth a sentence under §3a noting the
fallback behavior so the next caller of `addOrderScheduleEntry` knows
why omitting `deliveryDay` is safe.

---

## Nits

### N1. §1's pre-existing `(store_id, day_of_week, vendor_name)` constraint was not in my probe set

**Location:**
[20260507214842_spec007_order_schedule_unique.sql:7-12](../../supabase/migrations/20260507214842_spec007_order_schedule_unique.sql),
spec build notes lines 1108–1112.

The pre-existing constraint
`order_schedule_store_id_day_of_week_vendor_name_key` (added in
`20260502071736_remote_schema.sql`) coexists with the new
`order_schedule_store_day_vendor_unique`. Both backing indexes are
kept. Backend-dev surfaced this in build notes — correct call:

- The new constraint at the `vendor_id` grain is the one §3a's
  ON-CONFLICT-DO-NOTHING idempotent insert needs (vendor_id is the
  identity, vendor_name is the display label that can drift on
  vendor rename).
- The old constraint guards against a different anomaly (two rows
  with same vendor_name but different vendor_id, e.g. duplicate
  vendor records) and is harmless to keep.

My §1 design didn't mention the pre-existing constraint because §0
didn't probe `pg_constraint`. Build-note resolution is the correct
disposition (keep both). Future-template improvement: §0 probes
should `\d` every table the design writes to so pre-existing
constraints surface in the design phase, not the build phase.

Action: none required. The migration's strategy is sound either way.

---

### N2. §5 realtime claim — "membership unknown without a probe" — actually was already in the publication

**Location:** spec §0 Probe 3 (lines 349–376), §5 (lines 603–642),
build notes lines 1113–1115.

§0 Probe 3 said "Whether `order_schedule` is in the publication is
unknown without a probe" and §5 then ruled "do NOT add to the
publication in this spec". Backend-dev's probe at apply-time
revealed `order_schedule` **is already** in `supabase_realtime`. So
§5's decision (no realtime migration) was correct, but the rationale
shifted — "we deliberately chose not to add it" → "it was already
there, so no migration is needed AND we deliberately chose not to
subscribe in `useRealtimeSync.ts`".

Net architectural impact: zero. The `useRealtimeSync.ts` no-touch
decision still holds — just because the table is in the publication
doesn't force a subscription. Cross-tab live sync of schedule edits
remains a future spec.

Action: none required. The spec's §5 reasoning point #2 ("Adding the
table to the publication has the documented docker-restart gotcha")
is now stale — the table was always there, no docker-restart cost was
ever on the table. Worth a one-line correction in §5 if the spec
gets a polish pass at close-out.

---

### N3. TZ-crossing day-of-week bug — design did not flag the gap

**Location:** spec `### Fix-pass` lines 1313–1410,
[src/screens/cmd/sections/EODCountSection.tsx:38-43](../../src/screens/cmd/sections/EODCountSection.tsx:38)
(`localDayIso` helper) + 5 call-site replacements.

The bug: `selectedIso` and rail per-cell `iso` strings were built via
`new Date().toISOString().slice(0, 10)`, which returns the **UTC**
date. At 22:04 EDT on Thursday the value resolves to Friday's UTC
date. Downstream day-of-week derivation
(`new Date(selectedIso + 'T00:00:00').getDay()`) then picked the
wrong weekday by one. Fix-pass added `localDayIso(d)` and replaced 5
sites.

**Was this gap predictable from §6?** Partially. §6 wrote:

> `const selectedDay = DAY_NAMES[new Date(selectedIso + 'T00:00:00').getDay()]`
>
> // (use store-local construction; current code uses `new Date(d)` —
> // preserve the existing idiom from line 116)

The design correctly anchored the **derivation** to local midnight
(`'T00:00:00'`), but assumed `selectedIso` was already a local-day
ISO string. The actual code at line 71 (pre-fix) was
`new Date().toISOString().slice(0, 10)` — a UTC-day string. My
design didn't audit the **input** to the derivation, only the
derivation itself. So:

- **Predictable from §6 alone?** No. §6 had no language about how
  `selectedIso` is constructed at the call site.
- **Predictable with a §0 probe?** Yes if the probe matrix had
  included "every Date.toISOString in EODCountSection.tsx — does
  it round-trip a local day?" That probe was not in §0.
- **Should the design have flagged it?** Reasonable yes. The whole
  spec turns on day-of-week mapping; the input pipeline to that
  mapping deserved an explicit sanity check.

**Future-template improvement (architect notes):** when a spec's
correctness depends on a calendar-day computation, the design's
verification probes should explicitly include "audit every
`toISOString().slice(0, 10)` in the modified file — these return UTC
days and silently lie in non-UTC timezones near midnight". This is
the second time the codebase has hit this trap (the existing rail
display at the time of the bug was using `d.getDay()` directly,
which was correct — the gap was specifically in the iso-string path).

Action: file as a future-template improvement under "things the
architect should add to the §0 probe matrix template for future
specs". No retroactive change to Spec 007 needed — the fix-pass
already landed.

---

### N4. §10 verification probe #6 (optimistic + revert) — not exercised

**Location:** spec §10 step 6 (lines 1008–1012). The brief says
"force a revert by temporarily breaking the RLS policy or running as
a non-admin user. Click `+ vendor` inline, pick a vendor — the pill
should appear briefly, then disappear with a toast saying 'Add
scheduled vendor failed'".

The browser walkthrough verified the happy path. The revert path
(`notifyBackendError` toast on RLS denial) was not exercised. Code
inspection shows the revert is wired correctly in both store actions
([useStore.ts:1074-1077](../../src/store/useStore.ts:1074),
[useStore.ts:1093-1096](../../src/store/useStore.ts:1093)) — same
pattern as `setOrderSchedule` above. So the architectural shape is
right; just no live evidence.

Action: log as a verification gap for the post-prod-push smoke walk.
Architecturally fine.

---

### N5. §10 verification probe #4 (`__all__` empty state) — defensive branch shipped, not exercised

**Location:** spec lines 996–999, frontend code at
[EODCountSection.tsx:375-383](../../src/screens/cmd/sections/EODCountSection.tsx:375)
+ [OrderScheduleSection.tsx:55-63](../../src/screens/cmd/sections/OrderScheduleSection.tsx:55).

Per §0 Probe 6, `currentStore.id === '__all__'` should never occur in
normal navigation because `setCurrentStore` redirects. The defensive
branches in both EODCountSection and OrderScheduleSection landed and
are correct by inspection. Not browser-exercised. The spec already
calls this a "defensive guard, also covers the brief moment between
login and `loadFromSupabase` settling" so the lack of exercise is
expected.

Action: none. Architecturally correct + matches the §6/§9 design.

---

## Confirmation of items called out in the dispatcher's brief

| Brief item | Verdict |
|---|---|
| §1 schema — single unique-constraint migration shipped, no rogue additions | **Confirmed.** [20260507214842_spec007_order_schedule_unique.sql](../../supabase/migrations/20260507214842_spec007_order_schedule_unique.sql) — 85 lines, dedup pre-pass + ADD CONSTRAINT in DO blocks, idempotent. No other schema changes in this slice. |
| §2 read contract — frontend filters client-side against `useStore.orderSchedule` | **Confirmed.** [EODCountSection.tsx:179-201](../../src/screens/cmd/sections/EODCountSection.tsx:179) computes `dayScheduledVendorIds` directly off `orderSchedule[selectedDayName]`. No new `fetchScheduledVendorIdsForDay` helper landed (correctly — §2 final decision was "no new read helper"). The orderSchedule slice is populated by `fetchOrderSchedule` via `loadFromSupabase` (verified at [db.ts:1492](../../src/lib/db.ts:1492) — `orderSchedule: orderSched` in `fetchAllForStore`). Dev relied on the design's claim, which was true. |
| §3 write contracts — two helpers + two store actions | **Confirmed** semantically. Names diverge (S1) — endorsed. `deliveryDay` fallback diverges from §3a signature (S2) — endorsed. |
| §4 RLS impact — none expected | **Confirmed.** No policy edits in any of the modified files. Existing `Admins can write order_schedule` policy gates the new helpers via 23505 / 42501 codes — backend-dev's `db.ts` swallows 23505 (idempotent no-op) and `notifyBackendError` surfaces other failures. |
| §5 realtime impact — no publication migration | **Confirmed.** No migration touches `supabase_realtime`. `useRealtimeSync.ts` unchanged. (But see N2: the rationale "would require docker-restart gotcha" turns out to be moot because the table was already in the pub.) |
| §6 frontend boundaries — file set matches | **Confirmed.** EODCountSection, OrderScheduleSection (NEW), AddVendorScheduleModal (NEW), InventoryDesktopLayout — exactly the surfaces §6 specified. AddVendorScheduleModal is in `src/components/cmd/` not `src/screens/cmd/sections/` — correct (it's a modal, not a section). |
| §7 apply-path — local applied, prod pending | **Confirmed.** Migration recorded in `schema_migrations` via direct `psql` insert because `npx supabase migration up --include-all` was blocked by Spec 006's pre-existing idempotency assertion. **This is a flag for the next migration's apply path, not a Spec 007 concern** — the manual insert path is a workaround, but it leaves the local `schema_migrations` table in a state that mirrors what `migration up` would have produced. Prod push remains user-authorized. |
| §8 REST day enforcement — inline pill, four input categories disabled | **Confirmed.** Pill at [EODCountSection.tsx:482-491](../../src/screens/cmd/sections/EODCountSection.tsx:482) (in TabStrip rightSlot, not top banner — matches §8). `+ COUNT` disabled at line 494, `SAVE DRAFT` at line 506, `SUBMIT COUNT` at line 518, `box/case` input at line 773, `count` input at line 804, `note` input at line 830. Vendor pills + category chips + the `+ vendor` button intentionally remain enabled (matches §8's table). |
| §9 `__all__` mode — defensive branch shipped | **Confirmed.** In both EODCountSection and OrderScheduleSection. Hooks ordered correctly (early return AFTER all `useState`/`useMemo` calls). |
| §10 verification probes — gaps | Two gaps documented above (N4 + N5). Browser-verified probes 1, 2, 3, 5 all passed per dispatcher's "Live state" summary. |
| §11 architect-level open flags — all three landed | **Confirmed.** (1) Unique constraint shipped. (2) OrderScheduleSection placed in Planning group between Categories and Recipes — see [InventoryDesktopLayout.tsx:147-157](../../src/screens/cmd/InventoryDesktopLayout.tsx:147). (3) AddVendorScheduleModal modeled on AddCountModal — confirmed at [AddVendorScheduleModal.tsx:25-73](../../src/components/cmd/AddVendorScheduleModal.tsx:25), same modal shell, same ↑↓⏎ keyboard wiring. |

---

## Summary

- **Critical drift:** none.
- **Should-fix:** 2 — both already documented in build notes (S1 name
  pair, S2 `deliveryDay` fallback). Architect endorses both
  resolutions; this review just confirms the spec text and the code
  haven't fully reconciled.
- **Nits:** 5. N1, N2, N3 are future-template improvements for
  architect §0 probes (always `\d` each touched table; always check
  `pg_publication_tables`; always audit `toISOString().slice(0, 10)`
  call sites when day-of-week math is in scope). N4 and N5 are
  expected verification gaps.

The implementation matches the design's intent. The two
"developer-known-better" deviations (S1, S2) make the code stronger,
not weaker. No re-architect pass needed; release-coordinator can
treat the design contract as honored.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. Zero Critical, two
  Should-fix (both already documented in build notes — name pair
  rename and `deliveryDay` NOT-NULL fallback, both endorsed by
  architect in retrospect), five Nits (three template-level probe
  improvements, two expected verification gaps).
payload_paths:
  - specs/007-eod-vendor-day-filter/reviews/backend-architect.md
