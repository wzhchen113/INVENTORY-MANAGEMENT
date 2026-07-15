# Backend-architect drift review — spec 120 (submission notification bell)

Reviewed against `specs/120-admin-submission-notification-bell.md` "## Backend design" (§0–§10).
Verdict: **implementation matches the contract. No Critical, no Should-fix. Three Minor / latent notes.**

Files inspected:
- `supabase/migrations/20260715000000_submission_notifications.sql`
- `supabase/functions/submission-push-fanout/index.ts` (+ `eod-reminder-cron/index.ts` for verbatim diff)
- `supabase/config.toml` (fanout stanza)
- `src/lib/db.ts` (helpers 1971–2066)
- `src/store/useStore.ts` (slice 561–563, 703–704, 2850–2895)
- `src/hooks/useSubmissionNotifications.ts`
- Source-table columns: `20260630000200_staff_submit_eod_multi_vendor.sql`, `20260528000000_actor_fk_cascade_audit.sql`, `20260704000000_po_loop.sql`, `submitEODCount` in `db.ts`

## Contract conformance (confirmed)

**1. Data model + RLS — matches §1/§2.**
- `notifications` + `notification_reads` schema exact to design: `(type, source_id)` unique dedup index (`notifications_type_source_uidx`), `(brand_id, created_at desc)` feed index, `notification_reads` PK `(notification_id, user_id)` with `user_id default auth.uid()`. FK `notification_reads.notification_id → notifications(id)` exists, which is what lets the PostgREST embed `reads:notification_reads(read_at)` resolve.
- notifications SELECT policy is `auth_is_privileged() AND auth_can_see_brand(brand_id)` — the privileged conjunct is load-bearing and present (a same-brand staff `user` is denied at the DB, not just by the shell). notification_reads has own-row SELECT/INSERT/DELETE, no UPDATE (idempotent re-read). Not trivially-wide → no permissive-lint trip, no allowlist entry needed. Grants left to spec-097 inheritance (no `revoke from anon`). All correct.
- Realtime publication adds **only** `public.notifications` (guarded by a `pg_publication_tables` existence check for idempotency); `notification_reads` correctly NOT published, per §7 rationale. Matches design.

**2. Generation — matches §0/§3.**
- §0 corrections honored: no phantom receiving table; `po`+`receiving` both come off `purchase_orders` INSERT-or-UPDATE status transitions; `weekly` = `inventory_counts` filtered `kind='weekly'`; 5 types from 4 source tables.
- Actor/store columns verified against schema: `eod_submissions.submitted_by`, `inventory_counts.submitted_by`, `waste_log.logged_by`, `purchase_orders.created_by` (po) / `received_by` (receiving) — all confirmed against `20260528000000` FK audit and the PO-loop RPC that stamps `received_by = auth.uid()`.
- Trigger WHEN clauses correct: eod `when (new.status='submitted')`, weekly `when (new.kind='weekly')`, waste unconditional, PO one function handling both transitions with `tg_op='INSERT' or old.status is distinct from ...` guards.
- Emitter is exception-safe (inner BEGIN/EXCEPTION → WARNING), SECURITY DEFINER, `search_path=public`, `on conflict (type, source_id) do nothing`, only enqueues push when a new row was actually inserted. All internal functions have EXECUTE revoked from `public, anon, authenticated`. Matches §3/§4.
- Dedup verified against the real submit paths: both admin `submitEODCount` (upsert `onConflict: store_id,date,vendor_id`) and the staff RPC upsert INSERT with final status directly on first write; re-submit is the upsert's UPDATE branch, which an AFTER INSERT trigger does not re-fire — plus the `(type, source_id)` index is the belt. Receiving partial→received yields one `receiving` row (second transition hits the conflict). Confirmed.

**3. Push fan-out — matches §4.**
- `sendPushAll` is byte-identical to `eod-reminder-cron/index.ts:57` (diffed) including the 404/410 `push_subscriptions.delete().eq('endpoint', …)` cleanup.
- Shared-bearer gate identical posture (reads `_edge_auth.cron_bearer` via service_role, compares, 403 on mismatch). config.toml `[functions.submission-push-fanout] verify_jwt = false` present with the correct rationale comment.
- Recipients = super_admin (all brands) + admin/master of `notif.brand_id`, minus `actor_user_id`, deduped via a Set. Payload shape (`<Type> submitted` / `<Actor> · <store>` / `tag: notif-<id>` / `url:'/'`) matches §4. Email fallback correctly omitted with the flagged seam comment.
- Enqueue helper reads `_edge_auth.submission_push_url`, skips with NOTICE when unseeded (local-safe), fires `net.http_post` with the bearer. Matches §4.

**4. db.ts + store + realtime — matches §5/§6/§7.**
- db.ts names match the migration exactly: table `notifications`/`notification_reads`, RPCs `unread_notification_count`/`mark_all_notifications_read`, embed `reads:notification_reads(read_at)`. No table/RPC name drift. `mapNotification` derives `read` from the RLS-clipped embed (`row.reads.length > 0`) — correct per-viewer semantics. `markNotificationRead` upserts `{notification_id}` only (user_id fills from default), `ignoreDuplicates` — idempotent, satisfies the INSERT WITH CHECK.
- Store slice renamed `submissionNotifications`/`submissionUnreadCount` to avoid clobbering the pre-existing reminder-inbox `notifications` slice — benign mechanical rename, behavior unchanged. Optimistic-then-revert with `notifyBackendError` present on both `markSubmissionNotificationRead` and `markAllSubmissionNotificationsRead`.
- Realtime hook uses a dedicated `notifications-${brandId}` channel filtered `brand_id=eq.${brandId}`, INSERT → lightweight `loadSubmissionNotifications()` refetch — NOT routed through `onSync`/`loadFromSupabase`. Matches §7.

**5. Migration/prod.**
- Version `20260715000000` is the next non-colliding slot (latest on disk was `20260714000000`). No collision. Submission flows otherwise untouched (no edits to eod/weekly/waste/PO write paths — only additive AFTER triggers).

## Minor / latent notes (non-blocking)

**M1 — EOD & weekly triggers are AFTER INSERT only; robust for today's paths, latent for a future draft→submit flow.**
The PO trigger is `AFTER INSERT OR UPDATE` so it catches a draft→sent in-place UPDATE. The eod (`when status='submitted'`) and weekly (`when kind='weekly'`) triggers are AFTER INSERT only. Verified both current submit paths INSERT with the final status directly, so this is correct now. But if a future spec adds a "save draft, then submit in place" EOD/weekly flow (row inserted as draft, later UPDATEd to `submitted`), the notification would silently never fire. The design chose AFTER INSERT deliberately (§3); flagging only so a future draft-flow spec revisits these two triggers.

**M2 — push recipient set uses `profiles.role`; bell RLS uses `auth_is_admin()` (JWT role) for the admin/master arm.**
`emit`/RLS admit via `auth_is_privileged()` = `auth_is_admin()` (JWT `app_metadata.role`) OR super_admin (profiles.role). The edge function resolves recipients from `profiles.role`. This is exactly what §4 specified, and relies on JWT role and `profiles.role` staying in sync (the project's standing invariant). A user whose `profiles.role='admin'` but whose JWT role is unset would get pushed yet see an empty bell (RLS denies). Consistent with design; noted for completeness.

**M3 — badge count is uncapped over the 30-day window while the feed caps at 50.**
`unread_notification_count()` counts every RLS-visible unread row in 30d; `fetchAdminNotifications` caps the feed at 50. Intended (badge reflects true unread; `9+` display cap absorbs the difference), so the badge can legitimately exceed the number of rows rendered in the panel. Not a bug — recording so a future reviewer doesn't read it as drift.

## Pending prod/deploy steps (correctly deferred to main Claude, per §8)
- Apply `20260715000000` to prod via MCP `execute_sql` + insert the exact version into `supabase_migrations.schema_migrations` (db push lacks the prod password) so the `db-migrations-applied` gate stays green.
- `supabase functions deploy submission-push-fanout`.
- Seed `_edge_auth.submission_push_url` on prod to the deployed function URL (local intentionally unseeded → push skipped with NOTICE).
- Local only: `docker restart supabase_realtime_imr-inventory` after applying the migration to re-snapshot the slot (prod re-snapshots automatically). Realtime publication gotcha, build/deploy step not runtime.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 3 Minor/latent notes. Implementation is faithful to the spec-120 backend design (data model, RLS, trigger generation with §0 corrections, verbatim push fan-out, db.ts/store/realtime shapes). Pending prod-apply + edge-deploy + submission_push_url seed remain for main Claude.
payload_paths:
  - specs/120-admin-submission-notification-bell/reviews/backend-architect.md
