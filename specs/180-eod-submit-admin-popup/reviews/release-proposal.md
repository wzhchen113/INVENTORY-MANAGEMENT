# Release proposal: spec 180 (EOD submit/update pop-up for admins)

Date: 2026-10-26
Inputs read: the spec (full, including Backend design and both Files changed sections), plus `reviews/code-reviewer.md`, `reviews/security-auditor.md`, `reviews/test-engineer.md` and `reviews/backend-architect.md`. I spot-checked three claims against the working tree:
- `src/i18n/es.json:148` mixed title is `"{store}: {n} conteos por proveedor enviados ({u} actualizados)"`.
- The migration's vendor-name lookup is at `20261027000000_eod_update_notifications.sql:260`.
- The trigger at `:366` is a plain `after update`, with no column list.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer found a Critical, but there is still work before this can ship. Three things block it:
1. One Should-fix, flagged by two reviewers: the grouped toast cuts off the AC-4 "contains updates" marker, and in `es` it is lost entirely.
2. The migration should get its cheap hardening while it is still unapplied.
3. Nothing is committed and nothing is on prod. Pushing in the current state would turn `db-migrations-applied.yml` red, so the CLAUDE.md gate condition for SHIP_READY cannot be met yet.

## Findings summary

- **code-reviewer:** 0 Critical, 1 Should-fix, 7 Nits.
  - Should-fix: toast truncation clips `(1 updated)` in the mixed-group title and clips `readySuffix` in text2. The reviewer says AC-4 is "only partly met in the shipped state" and wants it fixed before merge. Preferred fix: a custom `eodPopup` toast type in `App.tsx` with 2-line text1/text2 and auto height.
  - Nits:
    - `es` "1 actualizados" plural.
    - `sectionForNotification` is imported from a screen module.
    - The brandKey reset leaves `visibleKeyRef` and the fallback timer, so a leftover toast does nothing when tapped.
    - The `!n` guard should be on `raw`.
    - A rare race where the refetch lands after the optimistic mark-read.
    - The resolver code is duplicated in `emit_eod_update`.
    - `tg_notify_eod_submission` needs a comment saying its exception envelope lives in the callee.
  - Everything else was verified correct: decision purity and rule order, the sliding window, the revert on failure, replace-in-place behaviour, the migration's (R)/(G) branches, the ACLs, and identical i18n key parity.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 5 Low.
  1. A JWT-bearing direct `DELETE /profiles` (allowed by the "Admins can delete profiles" policy) triggers an FK SET NULL cascade that writes one `eod_update` per submitted row, attributed to the deleter. This is noise only and the app's real delete path is safe.
  2. An offline-queue replay of an EDIT's `client_uuid` re-notifies. The cause is a pre-existing RPC idempotency gap, and the §1.5 text claiming otherwise is wrong.
  3. `emit_eod_update` resolves the vendor name as definer without checking the vendor's brand. This could leak a brand-B vendor name into a brand-A row. The fix is one line.
  4. A `user`-role caller can spam edits and amplify writes. AC-8 accepts this; pushes are throttled.
  5. A pre-existing non-constant-time bearer compare in `submission-push-fanout`. Not a spec 180 finding.
  - Verified clean: definer posture and search_path, revoked EXECUTE (`{postgres, service_role}` only), guard (G), no RLS or publication change, realtime scoping, mark-read `user_id`, no HTML sinks, no secrets.
- **test-engineer:** 15/15 ACs PASS (AC-1 to AC-14, including 6b and 6c), 0 FAIL, 0 NOT TESTED.
  - Full `npx jest`: 280 suites / 3470 tests green.
  - `typecheck` and `typecheck:test`: clean.
  - pgTAP: 93/94 files pass. The new file passes 30/30, and the protected notification suites are unchanged and green. The one failure is the untracked `supabase/tests/order_approvals_fk_set_null.test.sql` from another session, which is not counted against spec 180.
  - Gaps that don't block: realtime latency, push fan-out recipients, and es/zh-CN rendering have no automated test; the `notAssigned` and super_admin paths were checked only in jest. The truncation was noted as a UI follow-up.
  - **I disagree with the PASS on AC-4 as rendered.** The architect and code-reviewer show that the `es` marker is lost completely, so AC-4 passes in the unit tests but not on screen.
- **backend-architect (post-impl):** no contract drift. 0 Critical, 2 Should-fix, 5 Minor.
  - Should-fix S-1: the same truncation defect. The architect calls it "a real AC-4 defect in `es`" and approves the custom `eodPopup` toast type as a frontend-only design amendment to §7.3.
  - Should-fix S-2: §9 runbook amendments.
    - A Step 0 ordering guard against spec 179's `20261026100000`.
    - A check that the SECURITY DEFINER owner matches.
    - Pre-flight checks for column and function drift, an explicit `--no-verify-jwt`, and a check of the deployed function against the committed version.
    - Post-apply md5 of the new wrapper, ACL check, and a promotion plus throttle smoke test.
  - Minor:
    - M-1: edit replays re-notify (see security Low 2). Correct the text in §1.5 and file a follow-up.
    - M-2: make the trigger column-scoped (`AFTER UPDATE OF status, submitted_at`) before the prod apply. This closes security Low 1.
    - M-3: the pop-up can replace other toasts. Add it to §10 as an accepted risk.
    - M-4: the warning label change is approved.
    - M-5: the `es` plural.
  - Approved deviation (a): the fallback slot-release timer, which closes a gap in the design.

## Recommended next steps (ordered)

### A. Fix now, in this spec, before commit and before any prod apply

1. **S-1 / AC-4 marker truncation (Should-fix, flagged by architect and code-reviewer). Do this first because it is the only finding that touches an acceptance criterion.**
   - Register a custom `eodPopup` toast type in `App.tsx`'s `<Toast config={...}>`. Spread the library's default config so `success`, `error` and `info` render unchanged. Wrap `BaseToast` with `text1NumberOfLines={2}`, `text2NumberOfLines={2}` and a style with no fixed height (`height: undefined, minHeight: 60`).
   - In `src/hooks/useEodSubmitPopup.ts`, change `type: 'info'` to `type: 'eodPopup'`.
   - Update the pin at `src/hooks/useEodSubmitPopup.test.ts:155`.
   - Add one jest assertion so this cannot regress silently: either on the custom config's NumberOfLines/height, or on the longest `en`/`es` mixed title.
   - Constraint: `App.tsx` already has another session's staged hunks (spec 181 shows `M App.tsx`). Add an additive hunk only, and stage it on its own.

2. **M-5 / es plural (Nit). Do it together with step 1, since it is the same i18n line.**
   - Reword `src/i18n/es.json:148` to a form that works for any number, e.g. `"({u} con actualizaciones)"` or `"(actualizados: {u})"`.
   - Check that `zh-CN` already reads correctly ("其中 {u} 个为更新" is fine).
   - Re-run `src/i18n/i18n.test.ts`.

3. **Amend the migration while it is unapplied on prod (security Lows 1 and 3, architect M-2, code-reviewer wrapper nit).** Each item is Low on its own. Do them now because once prod has the migration, every one of them needs a second migration. All edits go in `supabase/migrations/20261027000000_eod_update_notifications.sql`:
   - (a) **Trigger column list:** `after update of status, submitted_at on public.eod_submissions for each row when (new.status = 'submitted')`. This stops a JWT-bearing `profiles` delete from fanning out through FK SET NULL. Update the pgTAP A2 `LIKE` to `AFTER UPDATE OF status, submitted_at ON public.eod_submissions`.
   - (b) **Vendor-name brand check** in `emit_eod_update` (L260): `select v.name into v_vendor_name from public.vendors v where v.id = p_vendor_id and v.brand_id = v_brand;`. Optionally add a pgTAP arm in which a foreign-brand vendor gives `body` NULL.
   - (c) **A one-line comment** in the `tg_notify_eod_submission` wrapper: "envelope lives in the callee; keep this body argument-passing only".
   - (d) Optional: pgTAP arm S4, an edit-uuid replay (`cc002`) that gives +1 `eod_update`. It pins the known M-1 behaviour so the follow-up spec has a red-to-green target.
   - Re-apply locally. The version is already in local `schema_migrations`, so either `npx supabase db reset` or re-run the changed DDL by hand. Then re-run `bash scripts/test-db.sh` and confirm that S1, P1, D2, D3, G1 and A2 are green and the protected suites are unchanged.
   - Per project memory, re-run the full `npx jest` plus `typecheck` and `typecheck:test` after steps 1 and 2.

4. **Spec text corrections (S-2 is Should-fix; the rest are documentation).** Main Claude or the developer applies these; the release-coordinator does not edit the spec.
   - §1.5: replace the "Idempotent replays do not notify" bullet with the architect's M-1 wording.
   - §7.3: add the fallback-timer sentence and the `eodPopup` custom type.
   - §9: fold in architect Step 0 and the additions to steps 1, 2, 4 and 6. If step 3(a) lands, step 4 must check that `pg_get_triggerdef` shows `AFTER UPDATE OF status, submitted_at`.
   - §10: add M-3 (the pop-up can replace other toasts) as accepted. Record M-2 as fixed if step 3(a) lands.
   - Optional small code nits while these files are open: reset `visibleKeyRef` and the fallback timer on a brandKey change (or add a comment saying the leftover toast is intentionally inert), and move the `!n` guard to `if (!raw) return;`.

5. **Owner decisions needed before the prod apply.**
   - **Edit pushes on or off.** The PM recommendation, now implemented, is on, with a 60 s per-store throttle. The spec flags this for the owner at review. Turning it off is a one-line removal in `emit_eod_update` and is cheapest before the prod apply.
   - **Explicit go-ahead** for the prod migration apply and the `submission-push-fanout` redeploy.

6. **Release sequencing. Run this last; it decides whether the CI gates stay green.**
   1. **Check the gates on `main` now.** Run `gh run list --branch main --workflow test.yml --limit 1` and the same for `db-migrations-applied.yml`, and also check `e2e.yml` by hand (it is still pending promotion to the gate list). If either required gate is red or still running, surface the run URL and stop.
   2. **Spec 179 ordering (S-2 Step 0).** `20261026100000_inventory_items_identity_lock.sql` is on disk and apparently not on prod.
      - Run architect Step 0 on prod: `select version from supabase_migrations.schema_migrations where version in ('20261025000000','20261026100000','20261027000000')`.
      - If `20261026100000` is absent, there are two options. Either apply spec 179 first, under its own owner go-ahead and runbook. Or keep spec 179's migration file out of every push until it is applied.
      - Pushing it while it is missing from prod hard-fails `db-migrations-applied.yml` no matter what spec 180 does.
   3. **Spec 180 prod apply BEFORE the push.** Get owner approval first, then follow the amended §9:
      - Deploy `submission-push-fanout`. The `eod_update` copy branch is backward-compatible. Use `--no-verify-jwt` and confirm `verify_jwt = false` afterwards.
      - Apply the final (step 3) migration body via MCP `execute_sql`, off-peak (not 21:00-23:00).
      - Insert `('20261027000000','eod_update_notifications')` into `schema_migrations`.
      - Verify owner, ACL, CHECK, column, triggerdef and normalized-md5.
      - Record everything in `reviews/prod-apply.md`.
      - Pushing the migration before it is on prod turns `db-migrations-applied.yml` red.
   4. **Commit only spec 180's files.** The working tree mixes several sessions: specs 176, 177, 179 and 181, plus `App.tsx`, `package.json` and `app.json` hunks from spec 181. Stage spec 180's hunks deliberately.
      - **Do not** commit the untracked `supabase/tests/order_approvals_fk_set_null.test.sql`. It fails pgTAP locally, its migration is not on disk, and it would turn `test.yml` red.
      - The user confirms the commit; nothing is auto-committed.
   5. **Push, then confirm** that `test.yml` and `db-migrations-applied.yml` are both green on `main` (and check `e2e.yml` by hand). Then run the §9 step 6 smoke test, including the draft-to-submitted promotion check and the edit-push throttle check.

   SHIP_READY can only be re-evaluated after steps 1 to 4 are done and both gates are green after the push.

### B. Defer to follow-up specs (not blocking this spec)

- **`staff_submit_eod` edit-path idempotency** (architect M-1, security Low 2). Add a per-attempt `client_uuid` ledger checked at RPC step (4). This is pre-existing: a lost-response retry of an edit also duplicates `audit_log` rows. Changing the coalesce instead would be worse, because a late replay of the original uuid could overwrite a newer edit with stale data.
- **`eod_submissions` vendor/store brand-consistency constraint** (security Low 3, pre-existing). Neither write path checks that `vendor_id` belongs to the store's brand.
- **`eod_update` write amplification** (security Low 4). An optional per-(submission, actor) coalesce window in `emit_eod_update`. The owner accepted N edits giving N rows in AC-8, so this is only worth doing if the bell gets noisy in practice.
- **Feed crowding** (design §10). Collapse `eod_update` rows in the bell feed if edit volume pushes urgent rows out of the 50-row head.
- **App-wide toast-slot coordinator** (architect M-3). One wrapper around `Toast.show` so pop-ups and error toasts stop replacing each other.

## Out of scope for this review

- The **BEFORE trigger `eod_submissions_set_submitted_by_trg` rewrites the FK SET NULL** to the deleter's uid when a profile delete carries a user JWT (security Low 1, companion issue). It is pre-existing and belongs with the profiles security follow-ups (H1/H2/M1-M3 backlog), together with whether the `"Admins can delete profiles"` PostgREST DELETE policy should exist at all.
- **Non-constant-time bearer compare** in `supabase/functions/submission-push-fanout/index.ts:191-192`. Pre-existing and not touched by spec 180; it should be a small hardening spec of its own.
- **Moving `sectionForNotification` out of `PhoneNotifications.tsx` into `src/lib/`**, and a shared store/actor resolver for the notification emitters. These are refactors to do only if a second consumer or a third emitter appears.
- **The refetch-versus-optimistic-mark-read race** in `useSubmissionNotifications` (code-reviewer nit). It is very rare and only cosmetic.
- **The failing untracked `order_approvals_fk_set_null.test.sql`** and its missing migration belong to another in-flight session. They are noted here only because they must not be swept into the spec 180 commit.
- **The §0 plumbing correction** (on prod, the BEFORE trigger means `submitted_by` already names the editor). It is recorded at prod pre-flight under §9 and changes no spec 180 behaviour.
