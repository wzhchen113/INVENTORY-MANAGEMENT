## Security audit for spec 180 (EOD submit/update pop-up for admins)

Scope: only the spec 180 hunks. Other sessions' uncommitted hunks in `src/store/useStore.ts`, `src/types/index.ts`, `src/lib/db.ts` and `src/i18n/*.json` were not reviewed.

Files audited:
- `supabase/migrations/20261027000000_eod_update_notifications.sql` (untracked, new)
- `supabase/functions/submission-push-fanout/index.ts` (diff vs HEAD)
- `src/lib/db.ts` (`mapNotificationRow`, `markNotificationsRead`)
- `src/hooks/useEodSubmitPopup.ts`, `src/hooks/useSubmissionNotifications.ts` (diff)
- `src/lib/eodPopup.ts`
- `src/store/useStore.ts` (`markSubmissionNotificationsRead` hunk only)
- `src/components/cmd/NotificationBell.tsx`, `src/screens/cmd/sections/phone/PhoneNotifications.tsx` (diff)
- `src/utils/pushNotificationCopy.ts`
- `supabase/tests/eod_update_notifications.test.sql` (arms only, as context)

I also checked these in the local DB (`supabase_db_imr-inventory`, migration `20261027000000` applied): function ACLs, owners and `proconfig`; the `eod_submissions` trigger set; the FKs on `eod_submissions`, `notification_reads` and `profiles`; the policies on `eod_submissions`, `notifications` and `notification_reads`; and the definition of `auth_can_see_store`.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **`supabase/migrations/20261027000000_eod_update_notifications.sql:320-351` (flagged by the backend developer): an FK cascade under a user JWT fans out `eod_update` rows.**
  - **Mechanism.** `eod_submissions_submitted_by_fkey` is `ON DELETE SET NULL`, so deleting a `profiles` row runs an UPDATE on every `eod_submissions` row that user submitted. That UPDATE fires the BEFORE trigger `eod_submissions_set_submitted_by_trg`, then the new AFTER trigger `notify_eod_resubmission` (WHEN `new.status = 'submitted'`).
  - **App path is safe.** Guard (G) (`auth.uid() is null`) suppresses this on the app's real deletion path. `supabase/functions/delete-user/index.ts:193,267` uses the service-role client, whose JWT has no `sub`. `auth.admin.deleteUser` runs through GoTrue with no claims, and the `auth.users → profiles` cascade carries none either.
  - **Where it fires.** The `"Admins can delete profiles"` DELETE policy (`supabase/migrations/20260517060000_profiles_rls_sweep.sql:127-131`) still lets a privileged caller run `DELETE /profiles?id=eq.X` directly through PostgREST with their own JWT. The cascade then runs with `auth.uid()` set to the deleter. The result is one `eod_update` row per submitted submission the deleted user ever made, each attributed to the deleter, plus pushes (throttled to about 1 per store per 60 s).
  - **Impact.** Noise only, with misleading attribution ("EOD count updated by <admin>").
    - Brand scope holds: `brand_id` is derived from each submission's store, so no row crosses brands.
    - It is not a privilege escalation, because the caller already passed a privileged DELETE policy.
  - **Pre-existing companion issue (not introduced by spec 180, for the record).** On the same path the BEFORE trigger rewrites `submitted_by := auth.uid()`. That defeats the SET NULL: the deleted user's submissions get re-attributed to the deleter.
  - **Fix (optional).** In `tg_notify_eod_resubmission`, also return early when the row's notifiable content did not change. For example, return when `old.status = new.status and old.submitted_at is not distinct from new.submitted_at and old.client_uuid is not distinct from new.client_uuid`, or more narrowly when only `submitted_by` changed. Note the design's caveat (§1.5) that `now()` is constant inside a pgTAP transaction. A "only `submitted_by` changed" predicate avoids that test hostility, because both real edit paths rewrite `submitted_at`, while the cascade touches only `submitted_by`.

- **`supabase/migrations/20261024000000_eod_entries_no_need.sql:169-197` combined with `20261027000000_eod_update_notifications.sql:335-336` (flagged by the backend developer): an offline-queue replay of an EDIT re-applies and re-notifies.**
  - **Mechanism.** On the conflict branch `staff_submit_eod` keeps the original `client_uuid` (`coalesce(public.eod_submissions.client_uuid, excluded.client_uuid)`). The edit's own `client_uuid` is never stored, so the step (4) idempotency probe cannot match it.
  - **Effect.** Suppose a queued edit is delivered, its response is lost, and `useEodSubmit` (`src/screens/staff/hooks/useEodSubmit.ts:157`) retries the same uuid. The edit then re-runs in full and emits another `eod_update` row and, outside the 60 s throttle, another push.
  - **Spec text is wrong.** §1.5's "Idempotent replays do not notify" holds only for the first submit's uuid. That is the only case pgTAP S3 covers (`supabase/tests/eod_update_notifications.test.sql:286-296` replays `...cc001`, not the edit's `...cc002`).
  - **Impact.** A duplicate bell row and push. The data idempotency gap for edits is pre-existing: the entries are re-replaced with the same values. No confidentiality or authorization impact.
  - **Fix (optional, follow-up).** Record per-attempt uuids (e.g. a small `eod_submission_attempts(client_uuid pk, submission_id)` table probed at step 4), or document the limitation in §1.5 so the record is accurate.

- **`supabase/migrations/20261027000000_eod_update_notifications.sql:260-261`: `emit_eod_update` resolves the vendor name as definer with no brand check.**
  - **Mechanism.** Neither write path checks that `eod_submissions.vendor_id` belongs to the store's brand:
    - `staff_submit_eod` only null-checks `p_vendor_id`;
    - the `eod_submissions` INSERT/UPDATE policies only check `auth_can_see_store(store_id)`;
    - `eod_submissions_vendor_id_fkey` is a plain FK.
  - **Effect.** A caller with store access in brand A who knows a brand-B vendor UUID can submit or edit a count against it. `emit_eod_update` then copies the brand-B vendor **name** (read as `postgres`, bypassing `brand_member_read_vendors`) into a brand-A `eod_update.body`, where brand-A admins can read it.
  - **Why the impact is small.**
    - The attacker must already hold an unguessable brand-B vendor UUID, which `vendors` RLS does not hand out.
    - A `user`-role staff attacker cannot read `notifications` at all.
    - Only a vendor name is disclosed.
  - **New path.** The fresh `order_ready` path only resolves the name behind the below-par gate. `eod_update` is the first path that writes it unconditionally.
  - **Fix (one line, defense in depth).** `select v.name into v_vendor_name from public.vendors v where v.id = p_vendor_id and v.brand_id = v_brand;`
  - The missing vendor/store brand-consistency constraint on `eod_submissions` is pre-existing and out of scope. It is worth a follow-up ticket.

- **`supabase/migrations/20261027000000_eod_update_notifications.sql:365-368` combined with `staff_submit_eod`: new write amplification from the lowest-privilege role.**
  - **Mechanism.** Any staff `user` with a `user_stores` row for a store can call `staff_submit_eod` repeatedly with fresh `client_uuid`s for the same (store, date, vendor). Before spec 180 that produced zero notifications after the first. It now produces one `eod_update` row per call: unbounded rows in every brand admin's bell and unread badge, plus pop-ups. Pushes are bounded by the 60 s per-store throttle.
  - **Impact.**
    - Insider-only. Customer-PWA users have no `user_stores` rows, so `auth_can_see_store` refuses them.
    - The owner explicitly accepted "N rapid re-saves give N rows" (AC-8).
    - Worst case, a burst crowds urgent `order_failed` / `missed_eod` rows out of the 50-row feed head. The uncapped badge RPC still counts them.
  - **Fix (optional).** A per-(submission, actor) coalesce window in `emit_eod_update`, e.g. skip the insert when the same actor wrote an `eod_update` for the same `submission_id` in the last N seconds. Otherwise accept as designed.

- **`supabase/functions/submission-push-fanout/index.ts:191-192` (pre-existing, unchanged by this spec): the shared-bearer check uses `token !== want`, not a constant-time comparison.**
  - Spec 180 does not touch this line. I confirmed that `verify_jwt = false` (`supabase/config.toml:484-485`), the bearer gate and the recipient logic (`:230-245`: all super_admins plus same-brand admin/master, minus `actor_user_id`) are byte-for-byte unchanged. The diff is copy-only (`TYPE_LABEL.eod_update` and the `eod_update` branch in `derivePushCopy`).
  - Listed only so the release coordinator knows it was looked at. Not a spec 180 finding.

### Verified clean (focus areas from the dispatch)

- **SECURITY DEFINER posture.** All four definer functions (`emit_eod_submit_notification`, `tg_notify_eod_submission`, `emit_eod_update`, `tg_notify_eod_resubmission`) are owned by `postgres` and pin `search_path=public`.
  - `auth.uid()` is schema-qualified.
  - `gen_random_uuid()` and `now()` resolve from `pg_catalog`.
  - `eod_update_push_suppressed` is SECURITY INVOKER with a pinned `search_path`, and it is reached only from the definer context.
  - No dynamic SQL and no `EXECUTE`, so there is no SQL-injection surface.
- **REVOKE/GRANT (spec 097).** The live `proacl` for all five functions is `{postgres=X, service_role=X}`, so `anon` and `authenticated` lack EXECUTE. That matches the existing internal emitters (`emit_order_ready`, `emit_submission_notification`, `enqueue_submission_push`), and pgTAP A1 pins it.
  - The new `notifications.submission_id` column rides the table grants.
  - `notifications` has no client INSERT/UPDATE/DELETE policy, so clients cannot forge `submission_id` or `eod_update` rows.
- **auth.uid() guard (G).** Every real write path carries a user JWT. The `staff_submit_eod` ACL is `{postgres, authenticated}` (service_role is revoked), and the db.ts path uses the admin JWT. Service-role and claims-less writes, including the GoTrue/`delete-user` cascade, return early. The actor is the caller's own `auth.uid()` and cannot be spoofed through any client-supplied parameter: `p_submitted_by` is not used for the notification.
- **Trigger shape.** `AFTER UPDATE ... FOR EACH ROW WHEN (new.status = 'submitted')`, confirmed by `pg_get_triggerdef`. The whole body sits in an exception envelope, so a notification failure cannot roll back a submit. Warnings carry only the submission id.
- **Notifications RLS and realtime.** There is no policy change. `eod_update` rows are read only through `privileged_brand_read_notifications` (`auth_is_privileged() AND auth_can_see_brand(brand_id)`). `brand_id` is derived server-side from `stores.brand_id`, never from client input.
  - Realtime `postgres_changes` evaluates that policy per subscriber, so the extra payload fields (`submission_id`, vendor-name `body`, `actor_name`) reach only privileged same-brand viewers and super_admins.
  - pgTAP R1 pins foreign-brand admin = 0 and same-brand `user` = 0.
  - No cross-brand leak through the payload or the pop-up, apart from the vendor-name edge case in Low above.
- **Client-side `user_stores` filter.** `decideEodPopup` (`src/lib/eodPopup.ts:137-142`) and `useEodSubmitPopup` (`src/hooks/useEodSubmitPopup.ts:139-144`) only decide whether to *display* a toast for a row the viewer already received under RLS. The same rows are visible in the bell (brand-wide, by owner decision). Nothing uses `currentUser.stores` or `currentUser.role` to gate data access, and it is not a confidentiality boundary. Not a finding.
- **Mark-read.** `markNotificationsRead` (`src/lib/db.ts:2524-2539`) sends only `notification_id`. `user_id` defaults to `auth.uid()`, and the `own_reads_insert` WITH CHECK (`user_id = auth.uid()`) blocks writing reads for another user.
- **Rendering and XSS.** Every new string (bell secondary line, toast `text1`/`text2`, push title/body) renders through RN `<Text>`, `react-native-toast-message` or `showNotification` plain text (`public/sw.js:34-48`). There is no HTML sink and no `dangerouslySetInnerHTML`, so no `escapeHtml` requirement applies (not a Resend HTML body).
- **Secrets and logging.** No new secrets or env vars. `console.warn` in `markNotificationsRead` logs only `error.message`. No tokens or PII are logged.
- **Destructive-op rules (last-of-role / self-guard).** Not applicable: no deletion or role-change path was added.
- **Migration destructiveness.** Additive only. The CHECK drop/re-add keeps all 9 prior values. Prod apply is not done and requires owner approval (§9). Per CLAUDE.md, CI's `db-migrations-applied` gate will go red until it is pushed.

### Dependencies

No `package.json` change in spec 180's file set. The `package.json` / `package-lock.json` modifications in the working tree belong to another session (spec 181), so `npm audit` was skipped for this spec.
