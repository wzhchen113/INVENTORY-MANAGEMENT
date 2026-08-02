# Spec 149 — architectural drift review (backend-architect, post-implementation)

Reviewer: `backend-architect` (post-impl mode)
Date: 2026-08-02
Scope reviewed: the three `20260801*` migrations, `supabase/functions/instacart-cart-link/`,
the `submission-push-fanout` `order_ready` branch, `supabase/config.toml`, the three new
pgTAP suites + the modified `submission_notifications.test.sql`,
`scripts/smoke-instacart-cart-link.sh`, and the `src/lib/db.ts` / `src/store/useStore.ts`
surface where it touches the backend contract.

**Verdict: 0 Critical, 4 Should-fix, 7 Minor.**

The backend half is unusually faithful to the `## Backend design` section. Every ruling
R-1 … R-6 landed as written; the two deliberate deviations (trigger-body envelope, IDP
field drift) are contract-neutral and correctly flagged; the one STOP condition the design
armed (§5.4 retailer pinning) fired and was escalated instead of worked around, which is
exactly the behavior the design asked for.

---

## 0. What matched the design exactly (no action)

Recording these so the release-coordinator does not have to re-derive them.

| Design item | Landed |
|---|---|
| R-1 exclusive emit branch (`order_ready` **replaces** `eod`) | `20260801000200` Part 4 — trigger unchanged, function body branches. ✓ |
| R-3 channel precedence, all eight rows | `public.vendor_order_channel` + `vendor_order_channel.test.sql` (11 arms) + the TS mirror. `order_channel='extension'` with `extension_ordering=false` ⇒ `manual`. BJ's/Sam's cannot be rerouted off the tuned cart-filler by a column edit alone. ✓ |
| R-5 no publication change | No `alter publication` in any of the three migrations; `src/hooks/useRealtimeSync.ts` has zero references to `order_approvals` / `order_ready`. **No `docker restart supabase_realtime_imr-inventory` step. Do not pad the deploy checklist with one.** ✓ |
| R-6 re-approval refused, not overwritten | `create_order_approval` falls through with no write for `status in ('approved','ordered')`; pinned by arm (C4). ✓ |
| §2 RLS, verbatim | Three `privileged_store_*_order_approvals` policies, each a conjunction of `auth_is_privileged()` + `auth_can_see_store()`, INSERT additionally pinning `approved_by = auth.uid()`; **no DELETE policy**. `permissive_policy_lint.test.sql` allowlist is untouched (still the two seed `*_categories` rows). ✓ |
| AC-20 guard | `tg_order_approvals_guard()` implements all five clauses (identity immutability, transition legality incl. the no-op self-transition the edge function's write-back depends on, snapshot freeze past `pending`, `external_ref` freeze at `ordered`, `updated_at`/`ordered_at` auto-set). Six arms G1–G6. ✓ |
| AC-22/23/24 edge posture | `verify_jwt = true` pinned in `config.toml` with the send-po-email rationale; inline `ADMIN_ROLES` + `requireAdminCaller()`, **not** `_shared/`; **every** read *and* the write-back go through the caller-token anon client — there is no `service_role` client anywhere in the request path. This is design-guidance 3 realized correctly and it is the strongest part of the implementation. ✓ |
| AC-27 double validation | Server-side line bounds in **both** `create_order_approval` (22023) and `buildLineItems` (400, before any upstream call). ✓ |
| §1.2 ★ spec-104 bridge | `buildOrderApprovalLines` (`useStore.ts:83`) computes `costPerCountedUnit = it.costPerUnit * subUnitSize`. The single easiest thing to get wrong in this spec — it is right. ✓ |
| AC-25 client path | `db.mintInstacartCartLink` uses `supabase.functions.invoke` (the documented exception), not a bare `fetch`. No `connect.instacart.com` reference exists anywhere under `src/`. ✓ |
| `db.ts` centralization | `order_approvals` / `create_order_approval` appear only in `db.ts`, `useStore.ts`, and `PhoneApproveOrder.tsx`; the latter two go through `db.*` helpers. No new carve-out. ✓ |

---

## Should-fix

### S-1 — The no-retailer-pinning escalation: design intent partially survives; the §10.2 dark launch contains it, but two second-order consequences are unrecorded

`supabase/functions/instacart-cart-link/index.ts:62-79` (DRIFT #3),
spec §"IDP contract reconciliation".

**Procedurally correct.** §5.4 armed an explicit STOP condition and the developer hit it,
stopped, and surfaced it. That is the right call and I endorse it without reservation.

**Does the design intent survive?** Partially, and the split matters:

- **Survives:** the *items* are pre-filled. The edge function is the only holder of the
  key; the audit trail, idempotency spine, RLS, role gate and store-scope gate are all
  intact and are independent of retailer pinning.
- **Does not survive:** "one-tap to a **vendor-pinned** cart." The minted `products_link`
  lands on a shopping-list page where the admin selects the store. The extra tap is the
  small half of the problem. The larger half is that the admin can select a **different
  retailer than `instacart_retailer_key`** — at which point the on-screen estimate,
  already only a catalog-cost estimate, is anchored to a vendor the order will not be
  placed with.

**Against AC-8/AC-11: not broken.** Both are properties of the review screen, not the
destination. AC-8 (server lines + totals), AC-11 (exactly one 48px primary) hold
regardless. AC-15's literal text — "opens the returned `products_link_url`" — also holds.
The thing that degrades is **US-4** and the PM summary's "the phone opens an Instacart cart
that is already filled with your items," where "cart" implied a store.

**Against AC-10: arguably not met, conditionally.** AC-10 makes the honesty bar
first-class: the admin must never be surprised. If the PM accepts the picker, the
`section.approveOrder.disclosureInstacart` copy should also say the store is chosen on
Instacart. That is a one-key i18n change in three catalogs, not a redesign — but it should
land *with* the acceptance, not after.

**Is the §10.2 dark launch adequate containment? Yes — it is over-adequate.** Four
independent gates stand between the current state and a minted link, each verified in the
staged code:

1. `vendors.order_channel` must be explicitly set to `'instacart'` (default NULL ⇒ R-3
   resolves `extension`/`manual`; pinned by `vendor_order_channel.test.sql` T2/T7).
2. `vendors.instacart_retailer_key` must be non-blank (T2/T2b).
3. `stores.postal_code` must be non-null (edge fn `index.ts:374`) — and per the frontend's
   own deviation 2 there is **no edit surface for existing stores today** (see S-4), so
   this gate is currently unopenable through the UI.
4. The vendor's key must be returned by the live retailers probe for that ZIP
   (`index.ts:416`).

Nothing reaches the IDP until an operator deliberately opens gates 1–3. Behavior on ship is
byte-identical to today. I am comfortable recommending the code ships dark.

**Two consequences that must be written into the spec before the PM rules**, because they
change what "accept" costs:

- **The §5.5 probe is now an over-refusal.** It hard-409s when the vendor's key is not
  served at the ZIP — enforcing a retailer constraint that the minted link cannot honor
  anyway. If the PM accepts the picker, the architecturally consistent follow-up is to
  demote the probe from a blocking 409 to an advisory "is Instacart in this market at all"
  check (e.g. 409 only when the retailers list is *empty*), which also saves one upstream
  round-trip per mint (~cold-start-relevant, §10.7). Do **not** silently keep both a
  retailer-key gate and an unpinned link — that combination is incoherent and a future
  reader will mis-trust `retailer_unavailable` as meaning "the user can't reach this store."
- **`instacart_retailer_key`'s role narrows.** The header comment claims it "still does
  real work." True today only because the probe uses it. If the probe is demoted, the
  column becomes advisory metadata. Say so in the spec so it is not later read as a
  pinning mechanism.

**Classification, stated explicitly so the hard rule does not mis-fire:** this is **not a
code Critical** and must not block SHIP_READY of the dark-launched code. It **is** a hard
blocker on setting any vendor's `order_channel = 'instacart'` in prod. Record the PM's
ruling in the spec body (not only in a function header comment) before any operator opens
gate 1.

### S-2 — The inert `eod_entries` LEFT JOIN breaks §3.3's "never a false positive"; the async job is NOT needed sooner, but the spec wording is now wrong

`supabase/migrations/20260801000200_order_ready_notification_type.sql:80-91`; backend
deviation note 5.

The developer's observation is correct and well-made: `notify_eod_submission` is
`AFTER INSERT` on `eod_submissions`, `submit_staff_eod_*` writes `eod_entries` and bumps
`current_stock` only after the parent row lands, so at trigger time the LEFT JOIN matches
nothing and the predicate reads `inventory_items.current_stock` — the **pre-count** on-hand.

**Ruling on the design side (this is my R-2 to correct, not the developer's error).** The
implementation matches the design's SQL byte-for-byte, so this is not implementation drift
— it is a defect in R-2/§3.3. But the developer's conclusion ("still directionally safe
per §3.3 — never over-fires") does not hold once the join is inert:

- Pre-count stock **higher** than counted remaining (the normal case — stock depleted
  through the day): `par − current_stock` < `par − actual_remaining` ⇒ **under**-fires.
  Degrades to the spec-120 `eod` notification. Safe, as designed.
- Pre-count stock **lower** than counted remaining (an unrecorded receipt, or a prior
  under-count corrected by tonight's count): `par − current_stock` > `par − actual_remaining`
  ⇒ the predicate can be TRUE while `report_reorder_list`'s `par_replacement` is ≤ 0. That
  is a **false positive**, which §3.3 asserts cannot happen.

Blast radius of a false positive: R-1's branch is exclusive, so the admin gets an
`order_ready` deep link *instead of* the routine `eod` FYI, and lands on an Approve Order
screen whose vendor is absent from `reorderPayload.vendors`. AC-13's empty-order state
catches exactly this and disables the primary. So the failure is **contained by an AC that
already exists** — it is a wrong-notification-copy bug, not a data or ordering bug.

**Does it need the async job (pg_net → engine → emit) sooner? No.** The failure is rare
(requires an unrecorded receipt), contained by AC-13, and the async job is the strictly
bigger build §3.3 already scoped out. Bringing it forward would be an overreaction.

**What to do instead, cheapest first:**

1. **Correct §3.3 and the migration comment.** Replace "sufficient, not necessary … never
   over-fires" with the honest statement: the predicate compares `par_level` against the
   **pre-count** `current_stock` (the trigger fires before entries land), so it approximates
   in both directions, and AC-13's empty state is the backstop. A future reader relying on
   "never a false positive" would make a wrong call.
2. **Drop the inert LEFT JOIN** (or keep it with a comment that says it is inert on the
   real path and why it is retained). As written it actively misleads — three reviewers now
   have had to re-derive that entries do not participate. Zero behavior change either way.
3. Leave `report_reorder_list`-exactness to a follow-up spec, as §3.3 already says.

### S-3 — `create_order_approval` has a select-then-insert race; a concurrent second approver gets a raw 23505 instead of the idempotent verbatim return

`supabase/migrations/20260801000100_order_approvals.sql:334-358`.

Step (4) does `select … into v_row` then, on `not found`, a plain `INSERT` with no
`ON CONFLICT`. Two approvals for the same `(store_id, vendor_id, business_date)` arriving
concurrently (two admin devices, or a retry that races its own in-flight predecessor) both
see `not found`; one wins, the other raises `23505` on
`order_approvals_store_vendor_date_uidx` ⇒ PostgREST 409 ⇒ `approveAndOrder` toasts a raw
backend error.

Data integrity is fine — the unique index does its job, and design guidance 6's "must not
create two approval rows" is satisfied. What is not satisfied is guidance 6's second half,
"make the call safe to repeat": the contract in §3.2 has no 23505 row, and the client has
no branch for it. `approvalBusy` (`useStore.ts:3111`) only guards a single device.

Fix is small and local: wrap the INSERT in
`exception when unique_violation then select … into v_row; …` and fall through to the
existing R-6 / retry logic. Add one pgTAP arm asserting that inserting the same key twice
inside one transaction returns the existing row rather than raising.

### S-4 — `stores.postal_code` has no edit surface; make it a named prerequisite, not a discovery

Frontend deviation 2. `StoreFormDrawer` is create-only, so existing stores cannot get a ZIP
through the UI, and the edge function short-circuits `409 retailer_unavailable` on a null
ZIP (`index.ts:374`).

For the dark launch this is *helpful* — it is gate 3 in S-1 and it means the channel is
literally unreachable in prod today. But it means the Instacart-enablement checklist has a
step nobody has scheduled: either a store EDIT drawer (follow-up spec) or a one-off
`postal_code` write. R-8 was written specifically to avoid the hand-SQL situation, and this
column landed back in it.

Action: add `stores.postal_code` has an edit surface to the enablement prerequisites in the
spec, alongside the OQ-2 operator probe. `db.updateStore` already accepts `postalCode`, so
the write path is ready.

---

## Minor

### M-1 — §5.3's error table is now incomplete

The function ships three codes the design table does not list: `not_configured` (500,
`index.ts:388`), `writeback_failed` (500, `:495`), `unexpected_error` (500, `:512`). All
three are server-fault classes, all carry `correlationId`, and `db.mintInstacartCartLink`
handles any string token, so nothing breaks. But §5.3 is the published contract a future
consumer will switch on. Add the three rows.

### M-2 — Stale-JWT asymmetry between `requireAdminCaller()` and `auth_is_privileged()`

`requireAdminCaller` falls back to `profiles.role` when `app_metadata.role` is absent or
non-privileged (`index.ts:162-168`), inherited from the `delete-user` reference shape.
`public.auth_is_privileged()` → `auth_is_admin()` reads **only** `auth.jwt() -> app_metadata
->> 'role'` (`20260504073942_brand_catalog_p5_rls.sql:23`). A caller freshly promoted to
admin whose JWT has not refreshed therefore passes the edge gate and is then denied by RLS
on the caller-token read — surfacing as `404 approval not found`, i.e. the AC-24 cross-store
message.

Fails closed, so not a security issue. It is a misleading diagnostic. In `delete-user` the
divergence is invisible because the actual op runs as `service_role`; here the whole request
path is caller-token, so it bites. Either drop the profiles fallback in this function (the
DB will not honor it anyway) or comment the asymmetry at the fallback. Note that
`create_order_approval` handles the same case better — a clean `42501 not authorized to
approve orders`.

### M-3 — The predicate's `eod_entries` fallback branch has zero pgTAP coverage

Neither `order_ready_notifications.test.sql` nor `submission_notifications.test.sql` creates
an `eod_entries` row; both fixtures set `inventory_items.current_stock` directly. That is
correct — it reproduces the real path (and the file says so at :29-34). The consequence is
that `coalesce(e.actual_remaining, ii.current_stock, 0)`'s first arm is untested. If S-2's
option 2 is taken (drop the join) this evaporates. If the join is kept, one arm that inserts
an entry and asserts the entry value wins would stop a future "make it live" change from
regressing silently. Test-engineer's call on priority.

### M-4 — `vendor_order_channel.test.sql` arm (T9) does not actually exercise the RLS-invisible half

T9 runs as the default superuser role, so it pins "unknown vendor id ⇒ NULL" but not
"vendor clipped by `brand_member_read_vendors` ⇒ NULL ⇒ `create_order_approval` P0002" —
which is the half the SECURITY INVOKER choice exists for. `order_approvals.test.sql` (R3)
does not cover it either: the store gate raises `42501` before the vendor lookup is reached.
One arm under an impersonated foreign-brand admin against a visible store would close it.
The arm description currently overstates its coverage ("unknown / RLS-invisible").

### M-5 — Trigger-body exception envelope: correct, endorsed, with one observability note

Backend deviation 1, `20260801000200:209-229`.

**Accept as designed-intent, not drift.** §1.3.3's invariant ("a notify failure can never
roll back a staff submit") was written when the only trigger-body statement was a `perform`
on a self-enveloped emitter. Spec 149 adds two predicate calls and a vendor-name subselect
that execute *outside* those envelopes; without the wrapper, a failure in
`vendor_order_channel` or `eod_vendor_has_below_par` would propagate out of an AFTER INSERT
trigger and abort the staff submit — a regression on the surface AC-REG-5 freezes. The
wrapper restores the stated invariant rather than extending it. Contract-neutral: no
client-visible behavior changes on the success path.

Two notes, neither requiring a change:

- The new swallow surface is narrow (two predicates + one subselect). `emit_order_ready` and
  `emit_submission_notification` each still carry their own envelope, so the outer one never
  fires for them.
- New failure mode: a predicate error now yields **zero** notifications for that submission,
  observable only as `raise warning 'tg_notify_eod_submission failed (%)…'` in the pg log.
  Greppable and correctly worded. Worth knowing exists.

The `exception when others` subtransaction cost is one per EOD submission — irrelevant at
this volume, and identical to what spec 120's emitters already pay.

### M-6 — `emit_order_ready`'s unused `p_vendor_id`

Backend deviation 4. Accepted: it preserves the design's published signature and the
call-site symmetry with `emit_missed_count`, and it is commented as such. No action.

### M-7 — `markOrderApprovalOrdered` relies on UI state for transition legality

`useStore.ts:3297`. It guards only `status === 'ordered'`. On a `pending` row it would
attempt `pending → ordered`, which the trigger correctly rejects (P0001 → 400), the
optimistic flip reverts, and `notifyBackendError('Mark ordered', …)` toasts. Correct by
construction, but the belt is server-side only. A one-line client guard
(`if (prev.status !== 'approved') return;`) makes the affordance's precondition explicit and
matches the AC-20 lifecycle. Cosmetic.

---

## Arm-(5a/5b) pgTAP split — assessment: correct, endorsed, coverage complete

`supabase/tests/submission_notifications.test.sql:154-222`, `plan(11)` → `plan(12)`.

The diagnosis in "Blocker RESOLVED" is right and the fix is the right fix. Specifics I
verified:

- The pre-149 arm used `(select id from public.vendors limit 1)` against the seeded Towson
  store. That vendor has below-par Towson inventory, so spec 149's branch correctly emits
  `order_ready` — the arm was pinning behavior this spec deliberately changes, not detecting
  a bug. Splitting it is the correct resolution; suppressing or loosening it would not have
  been.
- Both new arms use **dedicated fixture vendors** (`…5a0` with no `item_vendors` links,
  `…5b0` with one below-par linked item) created inside the hermetic transaction, so neither
  branch can drift with the seed again. This is a genuine improvement over the design's
  implicit expectation, which never specified how arm (5) should survive the branch.
- Arm (5b) asserts the full triple `1|1|0` (one notification total, one `order_ready`, zero
  `eod`), which is the strongest available form of AC-3. Good.
- The developer's side note about arm (10) is correct: the dedupe arm re-emits `eod` against
  arm (5a)'s source, which now genuinely exists to conflict against. With the old arm red,
  arm (10) was inserting into an empty slot and asserting nothing. Restoring its meaning is
  a real, unrequested improvement.
- `plan(12)` matches: arms 1, 2, 3, 4, 5a, 5b, 6, 7, 8, 9, 10, 11.

**Coverage gap check — none.** Arm (5a) pins only "vendor with *no links at all* ⇒ `eod`".
The more interesting negative — a vendor **with** links whose items are all at/above par —
is covered by `order_ready_notifications.test.sql` arms (E4)/(E5) via the `__or_vendor_atpar__`
fixture (par 0, on hand 5). Across the two files both sides of the branch are pinned for
both reasons a vendor can fail the predicate. `order_ready_notifications.test.sql`'s
`plan(10)` also matches its ten assertions (N1–N3, E1–E3, E6a, E4, E5, D1).

One stylistic note, not a finding: the two files hard-code different stores (`Frederick` via
`where name = …` vs. Towson via literal uuid). Both idioms are established across 46
existing suites, so this is consistent with the repo, not drift.

---

## Deploy / gate notes (carry into the release proposal)

- **Prod migrations are NOT applied.** The three `20260801*` versions must go through the
  Supabase MCP `execute_sql` path with the exact versions inserted into
  `supabase_migrations.schema_migrations` (`db push` lacks the prod password). The hard
  dependency chain is `…000000` → `…000100` → `…000200`; out-of-order application fails
  loudly ("function does not exist"), so there is no silent half-state.
- **`db-migrations-applied.yml` will be red between commit and prod-apply.** Expected per
  §10.5 — flag it, do not "fix" it. Per the CLAUDE.md CI rule, SHIP_READY cannot be
  recommended while either gate is red, so the prod-apply must complete and the gate must
  re-green before the release call.
- **No realtime restart.** R-5 verified against the actual migration bodies: zero
  `alter publication` statements. Do not add a `docker restart supabase_realtime_imr-inventory`
  step to the deploy checklist.
- **AC-30 is manual.** `scripts/smoke-instacart-cart-link.sh` is not wired into either gate
  (§10.11). Its steps 1/3/6 additionally require a live IDP key + the store's real ZIP, so
  they cannot run before S-4 is resolved. A green CI is not evidence AC-30 ran.

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 11 findings by severity — 0 Critical,
  4 Should-fix (S-1 retailer-pin PM decision + two unrecorded second-order consequences,
  S-2 §3.3's "never a false positive" is wrong now that the eod_entries join is inert,
  S-3 create_order_approval select-then-insert race, S-4 stores.postal_code has no edit
  surface), 7 Minor. The trigger-body exception envelope and the arm-(5a/5b) split are
  both endorsed as correct. The dark-launch posture adequately contains the retailer-pin
  gap; the PM ruling blocks channel enablement, not merge.
payload_paths:
  - specs/149-eod-approve-order-pipeline/reviews/backend-architect.md
