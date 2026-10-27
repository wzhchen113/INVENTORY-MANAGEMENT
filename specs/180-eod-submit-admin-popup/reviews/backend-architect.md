# Spec 180: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Date: 2026-10-26
Scope: drift against "## Backend design" §0–§10, the four flagged deviations (a)–(d), and a re-check of the §9 prod-apply runbook.
Status: unchanged (READY_FOR_REVIEW).

## Verdict

There is **no contract drift**. The migration, the edge function and its mirror, the db.ts surface, the RLS posture and the frontend wiring all match the design.

| Severity | Count | Findings |
|---|---|---|
| Critical | 0 | |
| Should-fix | 2 | S-1 grouped-title truncation hides the AC-4 update marker; S-2 runbook amendments |
| Minor | 5 | M-1 to M-5 |

On the developers' four flagged items:
- **(a)** is approved. It fixes a gap in my design.
- **(b)** is a real AC-4 defect in `es`. I approve the App.tsx custom toast type as a scoped design amendment (S-1).
- **(c)** is a real inaccuracy in my §1.5 claim. Impact is low; correct the text and file a follow-up (M-1).
- **(d)** is latent, with no live path today. A cheap hardening is worth folding in before the prod apply (M-2).

---

## Drift checks that pass

### Migration `supabase/migrations/20261027000000_eod_update_notifications.sql`

- **§1.2 DDL (L82-100):**
  - `submission_id uuid null` has no FK, no index and no default.
  - The CHECK has exactly the 9 values from `20260829000000` plus `eod_update`.
  - The file has `begin/commit` and `lock_timeout = '5s'`.
- **§1.4 `emit_eod_submit_notification` (L112-143): verbatim check passes.** I diffed it against `20260801000200_order_ready_notification_type.sql` L238-258. The predicate chain is identical: `vendor_order_channel` → `eod_vendor_has_below_par` → `emit_order_ready(store, vendor, (select v.name …), actor, id)` / `emit_submission_notification('eod', store, actor, id)`. The argument order, the exclusive `if/else` and the inner `begin … exception when others` envelope are all the same. There are only two differences:
  1. The `new.*` references are bound to parameters (`new.id` → `p_submission_id`, and so on), which is expected.
  2. The `raise warning` label changed from `'tg_notify_eod_submission failed (%)'` to `'emit_eod_submit_notification failed (%)'`. This is log text only, with no behavioural effect, and I approve it (see M-4).
- **§1.4 wrapper `tg_notify_eod_submission` (L163-172):**
  - The actor is still `new.submitted_by`.
  - The `notify_eod_submission` trigger is not redefined.
  - The wrapper has no envelope of its own. That is acceptable: the only statement is a `perform` into a definer function owned by the same role, and that function carries the envelope.
- **§1.4 `eod_update_push_suppressed` (L193-211):** `sql stable`, SECURITY INVOKER, predicate exactly as designed, EXECUTE revoked.
- **§1.4 `emit_eod_update` (L235-280):**
  - It inserts `(…, 'eod_update', gen_random_uuid(), p_submission_id, …, vendor name)`.
  - The push is gated on `v_new_id is not null and not eod_update_push_suppressed(...)`.
  - The envelope matches `emit_order_ready`.
- **§1.5 `tg_notify_eod_resubmission` and the trigger (L320-368):** the (G)/(E)/(R)/(P) branches match the pseudocode.
  - The trigger is `after update … for each row when (new.status = 'submitted')`.
  - Moving (G) inside the envelope is fine.
  - The (R) probe `source_id = new.id and type in ('eod','order_ready')` rides `notifications_type_source_uidx`.
- **ACL:** all five functions revoke EXECUTE from `public, anon, authenticated`. Trigger EXECUTE is checked at `CREATE TRIGGER`, not at fire time, so the revoke on the trigger functions is safe (pre-existing pattern).
- **No policy change and no publication change.** No `docker restart supabase_realtime_imr-inventory` step is needed, as in §6. The developer's realtime e2e confirms `submission_id` arrives in `payload.new` without a restart.

### pgTAP `supabase/tests/eod_update_notifications.test.sql`

- All §8.1 arms are present: C1, F1, S1-S3, P1, D1-D3, G1, R1, T1, A1, A2. It is hermetic.
- D3 goes beyond the design usefully. It forces the vendor below par before the re-promotion, which proves the (R) branch is the only thing preventing a cross-type `eod`+`order_ready` duplicate.
- The developer reports that the protected files listed in §8.1 are green and unchanged. I did not re-run them.

### Edge function `supabase/functions/submission-push-fanout/index.ts` and mirror `src/utils/pushNotificationCopy.ts`

- `TYPE_LABEL.eod_update` and the dedicated branch before the default (index.ts L127-136, mirror L88-97) match §4.
- `derivePushCopy` is byte-identical between the two copies (re-read side by side).
- The branch-contract comment is updated.
- The `.select(...)` column list (L223) is unchanged and already includes `body`.
- The recipient logic and the `expectedBearer` gate are untouched.
- `config.toml` L484-485 still has `verify_jwt = false`.

### db.ts §5 (`src/lib/db.ts`)

- `mapNotificationRow` (L2430) is exported, adds `submissionId: row.submission_id ?? null`, and has `read: false` without the embed. `fetchAdminNotifications` uses it (L2477).
- `markNotificationsRead(ids: string[]): Promise<void>` (L2524):
  - an empty list returns with no call;
  - the bulk `upsert` uses `onConflict: 'notification_id,user_id', ignoreDuplicates: true`;
  - it is wrapped in `track(..., { kind: 'write', label: 'markNotificationsRead' })`;
  - on error it calls `console.warn` and rethrows.
- `submitEODCount` is unchanged, as designed.

### Frontend contract (§7)

- **`src/lib/eodPopup.ts`:**
  - The exports and signatures match §7.2 exactly.
  - The rule order is duplicate → type → self → role → grouping.
  - The window slides on the client receipt time.
  - The copy keys match §7.6.
  - `eodPopupTarget` picks the latest `order_ready`.
- **`src/hooks/useEodSubmitPopup.ts`:**
  - State lives in refs.
  - `onInsert` is stable (`useCallback([])`, and reads `brandKeyRef`).
  - The viewer is built at event time from `useStore.getState()`.
  - The hook uses `t(locale, …)`, not `useT`.
  - Groups and queue reset on a `brandKey` change.
  - On phone, `onPress` marks read and then calls palette `request`.
- **`src/hooks/useSubmissionNotifications.ts`:** still one set of channels. The INSERT handler adds `onPopupInsert(payload.new)`. AC-6 is structural: only the realtime handler reaches the pop-up.
- **Store (`src/store/useStore.ts` L4619-4656):** optimistic flip of present unread rows, a reload only when an id is absent, and an exact revert plus `notifyBackendError` on failure. The two-argument `then` stops a failed reload from triggering a revert, which is a good refinement. The type is declared at L1123.
- **Bells:**
  - `updateSecondaryLine` (NotificationBell.tsx L78) is shared by both bells.
  - The phone `sectionForNotification` has `case 'eod_update'` → `'EODCount'` (PhoneNotifications.tsx L51) and no `orderApproval`.
  - `URGENT_TYPES` is untouched.
- **No bypass of db.ts.** No new `supabase.from/rpc` outside db.ts. The hook's only Supabase use is the existing channel code in `useSubmissionNotifications`.

---

## Should-fix

### S-1: The grouped toast title truncates and hides the AC-4 update marker, fully so in `es` (flagged item b)

- **Files:** `src/hooks/useEodSubmitPopup.ts` L113-122 (`type: 'info'`) and `src/i18n/es.json` L148.
- **Cause:** the library's default `BaseToast` is a fixed `HEIGHT` with one line, and the title is ellipsised at the tail. The developer saw "Towson: 3 vendor counts submitted (1 updat…" in `en`.
- **Impact in other locales:**
  - `es` `title.group.mixed` renders as "Towson: 3 conteos por proveedor enviados (1 actualizados)", about 57 characters. On the default 340 px toast the `(… actualizados)` marker is cut off completely.
  - Store names longer than "Towson" make it worse in every locale.
- **Why it matters:** AC-4 requires that a mixed group's copy "still says it contains updates". On the default toast that does not hold in `es`.
- **Decision (design amendment to §7.3, frontend-only, no contract impact):**
  - Register a custom toast type `eodPopup` through `<Toast config={...} />` in `App.tsx` (L467). It should wrap the library's `BaseToast` / `InfoToast` with:
    - `text1NumberOfLines={2}`;
    - `text2NumberOfLines={2}`;
    - a style override that removes the fixed height (for example `height: undefined, minHeight: 60`).
  - `BaseToast` already accepts `text1NumberOfLines` / `text2NumberOfLines` in the installed version (`node_modules/react-native-toast-message/lib/src/types/index.d.ts:101`).
  - Spread the library's default config so the existing `success` / `error` / `info` toasts render exactly as today.
  - Change the hook's `type: 'info'` to `type: 'eodPopup'`.
  - Update `src/hooks/useEodSubmitPopup.test.ts` L155, which pins `type: 'info'`.
- **Constraint:** `App.tsx` has staged hunks from other sessions (`M App.tsx` in the working tree). This must be an additive hunk only.
- **Rejected alternative:** shortening or reordering the copy alone. It fixes `en` but not every locale or store-name length, and it is fragile under translator edits.

### S-2: Runbook amendments needed before the prod apply (§9)

See the "Prod-apply runbook re-confirmation" section below. The two items that can break things:
1. **Migration ordering against spec 179.** `20261026100000_inventory_items_identity_lock.sql` (spec 179) is on disk and, per spec 179's release proposal, not yet applied to prod. If spec 180's push includes it, or lands after it is committed, without that version in prod `schema_migrations`, `db-migrations-applied.yml` hard-fails. §9 must make this a stop condition.
2. **Owner of the new SECURITY DEFINER functions.** §9 step 4 must check that the owner of the five functions equals the owner of the pre-existing `tg_notify_eod_submission`. A different owner silently changes the privilege context of the definer chain, for example the `vendor_order_channel` SECURITY-CONTEXT note in `20260801000200`.

---

## Minor

### M-1: Edit replays re-notify; §1.5's "replays never notify" is only true for the original submit (flagged item c)

- **What happens.** `staff_submit_eod` (`20261024000000_eod_entries_no_need.sql` L197) sets `client_uuid = coalesce(eod_submissions.client_uuid, excluded.client_uuid)`, so the row keeps the **first** submit's uuid forever. The idempotency probe at step (4) (L169-180) therefore only matches a replay of that first uuid.
- **When it bites.** The staff offline queue (`src/screens/staff/hooks/useEodSubmit.ts` L157) retries with the **edit's** uuid. If the server committed but the response was lost, the retry finds no match, runs the upsert again, and fires `notify_eod_resubmission` (E). The result is one extra `eod_update` row, one extra pop-up event (usually merged by the 60 s grouping), and possibly one push if more than 60 s has passed.
- **My error.** My §1.5 bullet "Idempotent replays do not notify… a replay with an already-used `client_uuid` returns at RPC step (4)" was wrong for edits. The pgTAP S3 arm correctly tests only the original-uuid replay, and its comment (L286-288) documents why.
- **Pre-existing, not introduced here.** The same edit replay already re-runs the entry delete/insert, re-bumps `submitted_at`, and writes a **duplicate set of `audit_log` rows** (RPC step 7). The notification is the visible tip of an existing RPC-level idempotency gap.
- **Do not fix it in this spec.**
  - Changing the coalesce to store the latest uuid would make a late replay of the *original* uuid overwrite a later edit with stale data, which is worse.
  - The correct fix is a per-attempt `client_uuid` ledger consulted at step (4). That changes `staff_submit_eod`, which this spec deliberately leaves alone.
- **Actions:**
  1. Correct the §1.5 bullet to: "A replay of the first submit's `client_uuid` does not notify. A replay of an *edit's* `client_uuid` (lost-response retry) re-runs the edit and emits one extra `eod_update`. This is a pre-existing RPC idempotency gap (it also duplicates audit rows); see follow-up."
  2. File a follow-up spec: "staff_submit_eod edit-path idempotency (client_uuid ledger)".
  3. Optional: add pgTAP arm S4, a replay of the `cc002` edit uuid giving +1 `eod_update`, so the known behaviour is pinned and the follow-up has a red→green target.

### M-2: A future JWT-bearing profile delete would fan out `eod_update` rows through FK SET NULL (flagged item d)

- **How it would happen.** `eod_submissions.submitted_by` is `on delete set null` (`20260527000000`). Postgres runs that referential action as an `UPDATE … SET submitted_by = NULL` that fires user row triggers on `eod_submissions`.
  - If a JWT-bearing session deletes a profile (a SECURITY DEFINER RPC called by an admin, for example), then for every `submitted` row of that user `notify_eod_resubmission` fires.
  - (G) passes because `auth.uid()` is the deleter, and branch (E) emits one `eod_update` per row: a bell flood attributed to the deleter, plus one push per store.
  - Pre-existing quirk on the same path: `eod_submissions_set_submitted_by_trg` (BEFORE UPDATE) would also rewrite the SET NULL to the deleter's uid.
- **Live path today: none.** Both deleters run with no user claims, so `auth.uid()` is NULL and (G) returns:
  - `delete-user` uses a service-role client (`supabase/functions/delete-user/index.ts` L193, L267);
  - `manage-store-user` compensation uses a service client (L199-207);
  - GoTrue's `auth.admin.deleteUser` cascade runs as `supabase_auth_admin` with no claims.
  - No migration or db.ts path deletes `profiles` under a user JWT.
- **Recommendation (cheap; fold in before the prod apply, because afterwards it costs a second migration):**
  - Make the trigger column-scoped: `after update of status, submitted_at on public.eod_submissions for each row when (new.status = 'submitted')`.
  - A column-list UPDATE trigger fires only when a listed column is a SET target of the statement. Both real write paths name both columns: the RPC's `do update set status, submitted_at, client_uuid`, and the db.ts merge-duplicates upsert, which sets every supplied column. The FK action sets only `submitted_by`, so it no longer fires the trigger.
  - G1 still exercises (G), because it sets `submitted_at`.
  - D3's `set status = …` still fires.
  - Update pgTAP A2's LIKE (L640) to match `AFTER UPDATE OF status, submitted_at ON public.eod_submissions`.
  - Re-run S1, P1, D2 and D3. They prove the column list behaves the same on the `ON CONFLICT DO UPDATE` branch.
  - If the owner prefers not to touch the migration now, record the risk in §10 next to the existing (G) caveat instead.

### M-3: The reverse toast contention (pop-up clobbers foreign toasts) is not in the design's risk list

- **What the design missed.** §10 accepted only "an error toast can pre-empt a pop-up". The reverse also happens:
  - When `visibleKeyRef` is null and a foreign toast is on screen (a `notifyBackendError`, or a Reorder/Users success toast; there are about 30 `Toast.show` call sites in `src/`), a new EOD event calls `Toast.show` and replaces it.
  - The fallback timer can do the same when it surfaces the next queued group (see (a) below).
- **Impact.** During the evening EOD burst, an admin editing elsewhere can lose an error toast. The optimistic revert still shows in the UI, and the error is still `console.warn`'d, so this is Minor.
- **Action.** Add it to §10 as accepted. A follow-up could add an app-wide toast-slot coordinator (one wrapper around `Toast.show`); it is out of scope here.

### M-4: The extracted function's warning label differs from the spec 149 original

- **Location:** `emit_eod_submit_notification` L141.
- **Assessment:** this is log text only and the new name is more accurate. I approve it, and it does not count against "verbatim".
- **Runbook note:** the §9 step 1 md5 pre-flight compares prod's **current** `tg_notify_eod_submission` against the `20260801000200` body, not against this file, so the change does not affect the pre-flight.

### M-5: Spanish mixed-group copy has a plural mismatch at u = 1

- **Location:** `src/i18n/es.json` L148.
- **Problem:** "(1 actualizados)" is grammatically wrong when u = 1. The catalog has no plural support.
- **Fix:** a neutral form such as "(actualizados: {u})" avoids it. Translator's call.

---

## Assessment of the flagged deviations

### (a) Fallback timer for a toast slot pre-empted by another toast: APPROVED, and it closes a gap in my design

- **The library behaviour.** I confirmed against the installed library (`node_modules/react-native-toast-message/lib/src/useToast.js` L51-79): `show()` replaces the current toast's options **without** calling the previous `onHide`. Only auto-hide (L34-43) and `hide()` (L45-50) call `options.onHide`.
- **The gap.** As I wrote §7.3, a foreign toast replacing a pop-up would leave `visibleKeyRef` set forever. Every later pop-up for **another** store would then queue indefinitely; only same-store events would keep showing. That would silently break AC-4's separate per-store pop-ups for the rest of the session.
- **The fix.** The developer's timer (L109-112) is `visibilityTime + 1 s`. It only acts when `visibleKeyRef` still names the same group, and it is cleared by every re-present, by `onHide → showNext` and by unmount.
- **Edge cases I checked:**
  - in-place re-show re-arms both timers;
  - `onPress → Toast.hide()` fires `onHide`, then `showNext`, then clears the timer;
  - a swipe dismiss calls `hide()`, which behaves the same way;
  - a toast held mid-pan past 9 s can be replaced. This is cosmetic.
- **Coverage.** Jest covers it at `useEodSubmitPopup.test.ts` L199.
- **Design amendment.** §7.3 should read: "`onHide` shifts the queue; a fallback timer (visibility + 1 s) releases the slot when a foreign toast replaced ours." Its one side effect is M-3.

### (b) Default toast truncation: see S-1

This is a defect against AC-4, not just cosmetics. A custom toast type in `App.tsx` is outside the letter of §7.3, but it is the correct fix. I am amending the design to allow it (frontend-only, additive `App.tsx` hunk, no backend or contract impact).

### (c) Edit replays re-notify: see M-1

The developer is right and my §1.5 claim was wrong. The cause is a pre-existing RPC idempotency gap, and this spec should not fix it.

### (d) FK SET NULL firing the update trigger: see M-2

The developer is right that it is reachable in principle. There is no live path today. The `UPDATE OF status, submitted_at` column list closes it cheaply and is test-compatible.

---

## Prod-apply runbook re-confirmation (§9)

The §9 order is still correct: deploy the function, then apply the SQL, then record the version, then verify, then push and check both gates, then smoke test. Amend it as follows (S-2 covers the two that can break things).

**Step 0 (new): ordering and drift guard.**
- On prod, run `select version from supabase_migrations.schema_migrations where version in ('20261025000000','20261026100000','20261027000000') order by 1`.
- Expect `20261025000000` (spec 177, recorded applied in `specs/177-cross-store-item-rejection/reviews/prod-apply.md`).
- If `20261026100000` (spec 179) is absent, **either** apply spec 179 first (under its own owner go-ahead and runbook) **or** make sure spec 180's push does not include the spec 179 migration file. Otherwise `db-migrations-applied.yml` goes red on the push.
- `20261027000000` must be absent.

**Step 1: pre-flight (as written), plus:**
- `select count(*) from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='submission_id'` must return 0.
- `select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('emit_eod_submit_notification','emit_eod_update','eod_update_push_suppressed','tg_notify_eod_resubmission')` must return no rows. If either check finds something, that is dashboard drift: stop.
- Confirm `notifications_type_source_uidx` exists. Every emitter's `ON CONFLICT (type, source_id)` depends on it.
- Record `select proowner::regrole from pg_proc where proname='tg_notify_eod_submission'` for the step 4 owner comparison.
- Record the `eod_submissions` trigger list in `prod-apply.md` (the §0 `submitted_by` trigger question).

**Step 2: deploy `submission-push-fanout`.**
- Deploy with `--no-verify-jwt` explicitly as a belt over `config.toml`, then confirm `verify_jwt = false` on the deployed function.
- Before deploying, compare the currently deployed version with the last committed `index.ts` (MCP `get_edge_function`). The deploy ships the whole working-tree file, so it must not carry unrelated undeployed edits.

**Step 3: apply.**
- Run `execute_sql` with the file body exactly as committed, including `begin; … commit;` and `set local lock_timeout`. If M-2 is accepted, run the amended body.
- Then `insert into supabase_migrations.schema_migrations (version, name) values ('20261027000000','eod_update_notifications')`.
- Apply off-peak, not 21:00-23:00 local.

**Step 4: verify (as written), plus:**
- Owner check: `proowner::regrole` of all five functions equals the step 1 owner.
- ACL check: `has_function_privilege('authenticated', <fn>, 'EXECUTE')` is false for the four new functions.
- The `tg_notify_eod_submission` normalized-md5 must now match **this** file's wrapper body, not the spec 149 body.
- If M-2 is adopted, `pg_get_triggerdef` must show `AFTER UPDATE OF status, submitted_at`.

**Step 5: push and gates (as written).**
- Both `test.yml` **and** `db-migrations-applied.yml` must be green on `main`.
- Also check `e2e.yml` manually, per the pending gate-promotion note.

**Step 6: smoke test (as written), plus:**
- One promotion check: save a count as draft, then submit it. Expect one fresh `eod` / `order_ready` row and no `eod_update`.
- Confirm one edit push arrives for a recipient with a push subscription, and that a second edit within 60 s does **not** push.

Record everything in `specs/180-eod-submit-admin-popup/reviews/prod-apply.md`. Nothing may be applied or deployed without the owner's explicit go-ahead.

---

## Spec text corrections the architect owns (for main Claude or the user to apply; Status unchanged)

1. §1.5, the "Idempotent replays do not notify" bullet: replace it with the M-1 wording.
2. §7.3: add the fallback-timer sentence from (a). Change the toast type to the custom `eodPopup` type (S-1).
3. §9: fold in Step 0 and the step 1, 2, 4 and 6 additions above.
4. §10: add M-3 (pop-up can clobber foreign toasts). Add M-2, either as the trigger column-list hardening or as an accepted latent risk.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 7 findings by severity: 0 Critical, 2 Should-fix (S-1 grouped-title truncation breaks the AC-4 update marker in es, so approve a custom eodPopup toast type in App.tsx; S-2 prod-apply runbook amendments: spec 179 migration ordering vs the db-migrations gate, SECURITY DEFINER owner check), 5 Minor (M-1 edit replays re-notify, pre-existing RPC idempotency gap, follow-up spec; M-2 FK SET NULL latent fan-out, recommend AFTER UPDATE OF status, submitted_at before prod apply; M-3 pop-up can clobber foreign toasts; M-4 warning-label change approved; M-5 es plural). The fallback timer (a) is approved as a fix to a design gap.
payload_paths:
  - specs/180-eod-submit-admin-popup/reviews/backend-architect.md
