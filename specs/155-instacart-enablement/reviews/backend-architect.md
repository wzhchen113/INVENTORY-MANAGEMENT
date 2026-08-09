# Spec 155 — architectural drift review (backend-architect, post-impl)

Reviewer: backend-architect (design-mode author of the same spec's `# Backend design`).
Mode: post-implementation drift review. `Status:` NOT changed.
Scope read: `supabase/functions/instacart-cart-link/index.ts`,
`scripts/smoke-instacart-cart-link.sh`, `src/lib/db.ts` (§8 slice + `updateStore`),
`src/store/useStore.ts` (§6.1/§6.2), `src/components/cmd/StoreFormDrawer.tsx`,
`src/screens/cmd/sections/BrandsSection.tsx` (`StoresTab`), `src/utils/postalCode.ts`,
`src/screens/cmd/sections/phone/PhoneApproveOrder.tsx`, the three admin i18n catalogs,
`src/store/useStore.updateStore.test.ts`, `src/screens/cmd/sections/__tests__/StoresTab.edit.test.tsx`,
`src/components/cmd/StoreFormDrawer.test.tsx`, `supabase/config.toml`, `supabase/migrations/`.

**Verdict: no Critical drift. The contract landed.** 4 Should-fix, 6 Minor.

---

## 0. Explicit rulings the dispatch asked for

### R1 — the unparseable-probe-body judgment call: **CORRECT, and it was already the design**

`§3.2`'s status table row reads *"probe non-2xx / timeout / **unparseable** → 200
`advisory: 'retailers_probe_failed'`"*. The implementation matches it verbatim
([index.ts:483-511](../../../supabase/functions/instacart-cart-link/index.ts)): the body is read
without a swallowing `.catch(() => null)`, and a body whose `retailers` is not an array is thrown
into the local probe catch → `retailers_probe_failed`.

The developer's extension — treating `{ "retailers": <not-an-array> }` as a probe failure rather
than as an empty market — is the right call and I endorse it as design-consistent, not as drift.
`§4.3` made `retailers=<n>` load-bearing: `retailers=0` is the ONLY signal that Instacart does not
serve the market at all. Mapping a malformed body onto `retailer_not_in_zip` would inject a false
`retailers=0`-adjacent reading into that signal and would tell the operator the wrong next action
("check the retailer key") for what is actually an upstream/parse fault ("retry / check the
upstream"). Since OQ-6 shipped three distinct toasts precisely because the operator's next action
differs per token, conflating the two would have defeated the OQ-6 ruling.

Approved as implemented. No change requested. (See M2 for a small observability nit on the same arm.)

### R2 — the mid-run reassignment of §8 (`src/lib/db.ts`) to the frontend half: **acceptable**

`§12` assigned `db.ts` §8 to the backend-developer, but the backend dispatch scoped that agent to
`supabase/functions/` + `scripts/`. The frontend half picked it up and implemented it exactly to
contract ([db.ts:2555-2591, 2650-2657](../../../src/lib/db.ts)): the exported `InstacartAdvisory`
union, the module-scope `isInstacartAdvisory` guard sitting beside the existing `isOrderChannel`
precedent, `advisory?` added to the `ok:true` variant only, `ok:false` untouched (so
`reason: 'blank_retailer_key'` is correctly NOT surfaced), and the transport unchanged
(`supabase.functions.invoke` under `useInflight.track({kind:'write'})` — the documented CLAUDE.md
exception, never a bare `fetch`).

The design's actual constraint was *"Both must land in the same PR"* (§12, shared seam), not who
typed it. That constraint holds: producer and consumer are in one staged changeset, and the token
sets are byte-identical across the two bundles
([index.ts:139](../../../supabase/functions/instacart-cart-link/index.ts) vs.
[db.ts:2561-2570](../../../src/lib/db.ts)). No seam is open. The only residue is documentation (M4, M5).

### R3 — advisory transport vs. the OQ-3 / OQ-5 rulings: **landed exactly**

- **OQ-5** (optional `advisory` string on the existing 200 body; three stable tokens; omitted, never
  `null`/`""`): `...(advisory ? { advisory } : {})` at
  [index.ts:602](../../../supabase/functions/instacart-cart-link/index.ts). ✔
- **OQ-3** (empty market is advisory and shares `retailer_not_in_zip`; distinguishability lives in
  the log's retailer count): the empty list falls into the `!availableKeys.has()` arm and the log
  line carries `retailers=${retailers.length}`
  ([index.ts:499-509](../../../supabase/functions/instacart-cart-link/index.ts)). ✔ No fourth wire
  token, no fourth i18n string — as ruled.
- The full §3.2 status/token table is honoured, including the three arms that were **deliberately
  NOT changed**: `products_link` non-2xx → 502, `products_link` 2xx without `products_link_url` →
  502, `products_link` timeout → 504
  ([index.ts:546-567, 606-615](../../../supabase/functions/instacart-cart-link/index.ts)).
- §4.1's ordering invariant (blank-key 409 **before** the `INSTACART_IDP_API_KEY` gate, so the smoke
  stays exercisable without a live key) is preserved: [index.ts:414-437].
- §4.2's AC-16 shape (`retailer_unavailable` wire token kept + additive `reason`) is exact, and the
  client correctly ignores `reason`.

### R4 — deploy-step documentation (§4.6): **adequate at the artifact level, inadequate in the runbook**

The command is recorded verbatim in the spec's closing deploy note
([specs/155-instacart-enablement.md:1643-1648](../../155-instacart-enablement.md)) and the smoke
script's failure messages name the deployed-function skew explicitly ("is the DEPLOYED function
pre-spec-155?", [smoke:221](../../../scripts/smoke-instacart-cart-link.sh)), which is a real
detection path. That satisfies §4.6's "put the command in the PR description".

It does **not** satisfy AC-21's "ordered, executable runbook": the Go-live runbook's step 1 still
only mentions a redeploy *conditionally* ("Redeploy `instacart-cart-link` if the secret does not take
effect", [spec:378-379](../../155-instacart-enablement.md)) and no step says "deploy the spec-155
function build". See S1 — this is the one place where the deploy-skew window turns into a silent
operator-facing failure, because the old function's 409 is absorbed by the AC-18 fallback branch and
presents as "Instacart just isn't happening", with no error toast to trace.

No CLAUDE.md change is warranted: unlike the realtime-publication restart, this is a per-spec deploy
step, not a durable repo-wide gotcha.

### R5 — `onSaved`-vs-`onClose` refresh placement: **compliant, and better than my own pseudo-code**

`§5.3`'s block sketched patch-on-`onSaved` / refresh-after-`onClose`; the implementation puts BOTH in
`onSaved` ([BrandsSection.tsx:1146-1161](../../../src/screens/cmd/sections/BrandsSection.tsx)), which
is fired only after the drawer's `await updateStore(...)` resolved `true`
([StoreFormDrawer.tsx:104-117](../../../src/components/cmd/StoreFormDrawer.tsx)).

This meets §5.3's *normative* requirement — the re-read happens after the write settled, so it is
authoritative reconciliation (AC-7, incl. the RLS 0-row snap-back) rather than the spec-094 race —
and it is strictly better on two counts: cancelling an edit costs no round-trip, and there is no
window in which a close-keyed refetch could fire without a preceding write. The
`[refresh, drawerOpen]` effect keeps its dependency array verbatim
([BrandsSection.tsx:1121](../../../src/screens/cmd/sections/BrandsSection.tsx)), so AC-2's
"`StoresTab.toggle.test.tsx` unmodified" is structurally safe. Approved; see M3 for a narrow race nit.

### R6 — the second `onSaved` prop: **not drift**

`§5.2` said "props gain **one** optional field" while `§5.3` simultaneously specified an
`onSaved(patch)` callback — an internal inconsistency in my design text. The implementation resolved
it the correct way: two optional, edit-only props (`store`, `onSaved`) plus an exported
`StoreFormSavedPatch` ([StoreFormDrawer.tsx:15-33](../../../src/components/cmd/StoreFormDrawer.tsx)).
Create mode with neither prop is behaviourally unchanged (AC-REG-1), and the seven existing create
cases are additive-only in the test file. Ruling: the design text was wrong; the code is right.

### R7 — the `updateStore` test `beforeEach` hoist: **acceptable, semantics-preserving**

[useStore.updateStore.test.ts:75-87](../../../src/store/useStore.updateStore.test.ts) hoists the
spec-083 `beforeEach` from inside the describe to file scope, body unchanged. The file contains
exactly one `beforeEach`, and it was the outermost hook in the only describe, so Jest's execution
order for the spec-083 cases is identical (file-scope `beforeEach` runs before each test in every
describe of the file). This file is explicitly on the design's Track-1 change list — it is not a
frozen suite (only `StoresTab.toggle.test.tsx` and `orderChannel.test.ts` are, and both are
untouched). The ★ AC-4 pin (`postalCode` reaching `db.updateStore`) and the boolean-contract pins
are present and are the right pins.

---

## 1. Contract conformance (design section → code)

| design | landed | note |
|---|---|---|
| §1 no migration (OQ-4 default) | ✔ | `supabase/migrations/` has nothing newer than `20260803000000`; nothing in the diff |
| §2 no new RLS policy / no permissive-lint allowlist entry | ✔ | `stores` write still rides `privileged_update_stores` |
| §3.1 PostgREST via `db.updateStore`, no RPC | ✔ | `!== undefined` guards intact ([db.ts:124-138](../../../src/lib/db.ts)) |
| §3.2 status/token table | ✔ | all rows verified, incl. the three unchanged `products_link` arms |
| §4 `verify_jwt = true`, `ADMIN_ROLES`/`requireAdminCaller()`, caller-token-only reads, no `service_role` | ✔ | [config.toml:474-475](../../../supabase/config.toml) untouched; AC-20 holds |
| §4.1 post-validation ordering | ✔ | blank-key 409 precedes the secret gate |
| §4.2 AC-16 token kept + additive `reason` | ✔ | client ignores `reason`; `db.ts` does not surface it |
| §4.3 OQ-3 shared token + `retailers=<n>` log | ✔ | |
| §4.4 3 s probe budget + local try/catch so a probe timeout can never become 504 | ◑ | try/catch is correct and complete; the timeout budget has a hole — S4 |
| §4.5 header `DRIFT #3` rewrite (AC-19) | ✔ | all three required statements present ([index.ts:62-89](../../../supabase/functions/instacart-cart-link/index.ts)) |
| §5.1 `parsePostalCode` pure module + the authorized create-path delta | ✔ | no React/i18n/supabase imports; `null` never `''` |
| §5.2 drawer edit mode | ✔ | badge/title/primary/a11y label/prefill/reset-dep all per table |
| §5.3 row EDIT affordance, row not pressable, separate `editStore` state | ✔ | testID, a11y label, hitSlop `{11,11,8,8}` exact |
| §5.4 disclosure block maps keys, `gap: 6`, no per-line testIDs | ✔ | |
| §6.1 five-field literal (never a spread) + `Promise<boolean>` that never rejects | ✔ | [useStore.ts:3063-3076](../../../src/store/useStore.ts); `weeklyCountDueDow`/`brandId` still dropped and pinned |
| §6.2 info toast before `openExternalOrderUrl`; AC-18 branch frozen | ✔ | behaviour frozen; comments inside it are stale — S3 |
| §7.1 `disclosureKeysForChannel` replaces the singular helper, no sibling | ✔ | old symbol survives only in two comments |
| §7.2 i18n: 4 new keys + 2 revised copies, all three admin catalogs, staff untouched | ✔ | verified in `en`/`es`/`zh-CN` |
| §8 `db.ts` advisory seam | ✔ | see R2 |
| §9 no realtime change, **no** `docker restart supabase_realtime_imr-inventory` | ✔ | correctly absent from every checklist |
| §10 test tracks | ✔ | jest arms present per track table; no pgTAP arm added; smoke updated not replaced |
| AC-REG-3/5/6/7 (`extension/`, `src/screens/staff/**`, `app.json`, `config.toml`) | ✔ | none in the changed-file list |

Nothing bypassed `src/lib/db.ts`: `StoresTab` reads via `db.fetchStoresIncludingInactive` and writes
via `useStore.updateStore` → `db.updateStore`; no `supabase.from/rpc` appears in `BrandsSection.tsx`,
`StoreFormDrawer.tsx` or `postalCode.ts`. No `connect.instacart.com` fetch anywhere under `src/`
(the only textual hit is the AC-22 warning comment at [db.ts:2338](../../../src/lib/db.ts)).

---

## 2. Findings

### Critical
None.

### Should-fix

**S1 — the go-live runbook never tells the owner to deploy the function.**
`specs/155-instacart-enablement.md` step 1 (lines 366-379) mentions a redeploy only conditionally
("Redeploy `instacart-cart-link` if the secret does not take effect"), and §4.6's mandatory command
lives only in the closing deploy note (lines 1643-1648) aimed at the PR description. AC-21 asks for an
*ordered, executable* runbook. The failure mode is silent by construction: an un-redeployed function
keeps returning the pre-155 `409 retailer_unavailable` for a missing ZIP or an out-of-market key, the
preserved AC-18 client branch swallows it into an info toast plus a channel fallback, and the operator
sees "Instacart didn't happen" with no error to trace. Fix: insert an explicit ordered step —
`npx supabase functions deploy instacart-cart-link --project-ref ebwnovzzkwhsdxkpyjka` — between
runbook steps 1 and 2, and have step 5's verification note that a 409-shaped fallback means the
deploy did not land. Documentation-only.

**S2 — smoke arms 8-10 are single-shot, and arm 10's default fixture is guaranteed to be consumed
before it runs.** `assert_advisory`
([scripts/smoke-instacart-cart-link.sh:308-335](../../../scripts/smoke-instacart-cart-link.sh))
requires an `advisory` on the 200, but the function's idempotency path returns
`reused: true` with **no advisory** and no probe when the approval already carries a live
`external_ref` ([index.ts:346-364](../../../supabase/functions/instacart-cart-link/index.ts)) — which
is exactly the state each fixture is left in after one successful run. Two consequences:
(a) re-running the script against the same fixtures fails with a misleading
"expected advisory:X"; (b) `PROBE_FAIL_APPROVAL_ID` defaults to `APPROVAL_ID`
([smoke:97](../../../scripts/smoke-instacart-cart-link.sh)), which step 3 has already minted in the
same run, so step 10 lands on the reuse path, finds no advisory, and exits through the benign
"the retailers probe is HEALTHY" note at [smoke:420-421] — the AC-15 arm silently never runs. Fix:
state in the header that each of arms 7-10 needs a **fresh** approval (or `external_ref` cleared)
per run, and make arm 10 `skip` rather than `note` when the body carries `"reused":true`. (The same
reuse-shadowing already weakens step 6; that part is inherited from spec 149, not introduced here.)

**S3 — the frozen AC-18 branch now carries comments that assert the cause spec 155 deleted.**
[useStore.ts:3587-3591](../../../src/store/useStore.ts) still reads "Instacart does not cover this
vendor at the store's ZIP" and "We never open a link that lands on an empty retailer". After §4.2 the
only trigger for that branch is a blank `vendors.instacart_retailer_key`, and the i18n string beside
it was revised to say exactly that. AC-18 freezes the branch's *behaviour and pins* — a comment edit
touches neither test nor bytecode path. Leaving it is the seed of the next spec's wrong assumption
about R-3. Fix: two comment lines.

**S4 — the 3 s probe budget does not cover the response body read, so §4.4's ~13 s ceiling is not
actually guaranteed.** `idpFetch` clears the abort timer in its `finally` as soon as `fetch` resolves
(i.e. at headers) ([index.ts:203-213](../../../supabase/functions/instacart-cart-link/index.ts)); the
`await retailersRes.json()` at [index.ts:489] then runs with no deadline. An upstream that sends 200
headers and stalls the body hangs the *advisory* probe indefinitely and takes the mint with it — the
precise inversion §11 risk 2 was written to prevent, arriving through the body read instead of the
fetch. The local try/catch is correct and complete; the gap is the budget. This shape is inherited
from spec 149 and applies to the `products_link` read at [index.ts:555] too. Fix (small): keep the
abort signal alive across the body read — e.g. have the probe pass its own `AbortController` and clear
the timer only after `.json()` settles, or read the body inside the same guarded scope. Low
likelihood, but it is the only remaining path by which the demoted probe can still kill a mint.

### Minor

**M1 — the success log line omits the advisory.** The final
`status=200 reused=false …` line ([index.ts:590-592]) does not carry `advisory=`; correlating an
outcome with its advisory requires joining the two lines by `cid`. Adding `advisory=<token|none>` to
the terminal line would make outcome-grep single-line. `cid` is present on both, so this is
cosmetic-but-useful.

**M2 — the probe catch cannot distinguish "unparseable body" from "network error".** The catch logs
only `timeout=<bool>` ([index.ts:512-517]). Given R1 deliberately routes malformed bodies here, a
`cause=parse|network|timeout` token would make the field diagnosis in runbook step 5.9 a one-line read.

**M3 — `onEditSaved`'s `refresh()` has no stale/cancel guard.**
[BrandsSection.tsx:1146-1161](../../../src/screens/cmd/sections/BrandsSection.tsx) calls `setStores`
from a closure captured over the current `brandId`; a brand switch (or tab unmount) between save and
resolution can briefly write the previous brand's list. The mount effect self-heals it on the next
`refresh` identity change and React 18+ does not warn on the unmounted-setState, so this is narrow —
but the mount effect has a `cancelled` flag and this path does not.

**M4 — the two advisory unions are mirrors with only a one-way pointer.**
[index.ts:139](../../../supabase/functions/instacart-cart-link/index.ts) points at `src/lib/db.ts`;
[db.ts:2561-2570](../../../src/lib/db.ts) does not point back at the function. This is correctly
inline-not-shared per the CLAUDE.md spec-027 §4.2 rationale (separate bundles), but the drift
protection for those patterns is a reciprocal comment naming the file to update. One line in `db.ts`.

**M5 — spec-internal ownership drift, already annotated.** §12 still assigns `db.ts` §8 to the
backend-developer while the "★ Open seam — RESOLVED" note records the reassignment. Harmless; noted so
`release-coordinator` does not read it as an unimplemented item.

**M6 — two `StoreFormDrawer` instances are mounted simultaneously.** Both return `null` when hidden
and the keyboard effect is `visible`-guarded, so the cost is zero and AC-REG-6 holds. Nothing in the
component enforces mutual exclusion of `drawerOpen` and `editStore`; the UI makes the double-open
unreachable today (the create sheet covers the rows), but a future layout change could stack two
overlays. Worth one guard the day the layout moves, not today.

---

## 3. Things I checked that are clean (so they don't get re-litigated)

- No migration, no policy, no `permissive_policy_lint` allowlist row — §1/§2 hold; the
  `db-migrations-applied` gate has nothing to react to for this spec.
- `supabase/config.toml` untouched; `verify_jwt = true` for `instacart-cart-link` intact.
- No realtime publication change ⇒ **no** `docker restart supabase_realtime_imr-inventory`. Correctly
  absent from the runbook and the deploy note.
- Secret discipline: key read only via `Deno.env.get`, never logged, never echoed; no ZIP, no retailer
  key, no minted URL in any log line — including the four new advisory log lines.
- The `db.updateStore` `!== undefined` guards mean the widened five-field literal cannot clobber:
  `setStatus`'s `{ status }` call still PATCHes one column.
- `postalCode: null` (explicit clear) survives the whole chain: validator → drawer → store literal →
  `updates.postalCode || null` → `postal_code: null`.
- AC-REG-2 frozen surfaces (`src/utils/orderChannel.ts` + its test, the `vendor_order_channel` pgTAP
  arms) and AC-2's `StoresTab.toggle.test.tsx` are not in the changed-file list.
- Cross-spec: spec 156 has already amended its AC-REG-4 to freeze the channel→disclosure-key
  *behaviour* rather than the outgoing `disclosureKeyForChannel` symbol
  ([specs/156-export-order-recording.md:340-344, 1187-1191](../../156-export-order-recording.md)), so
  the §7.1 coordination item I flagged at design time is closed. No phantom regression there.

## 4. Gate posture

Per CLAUDE.md, the changeset is staged and uncommitted; both `test.yml` and
`db-migrations-applied.yml` must be confirmed green on `main` before ship. This spec ships no
migration, so a red migration gate would mean SQL escaped scope. The shell smoke is manual and did not
run in CI — a green CI is not evidence that arms 7-10 were exercised (S2 makes that doubly true).
