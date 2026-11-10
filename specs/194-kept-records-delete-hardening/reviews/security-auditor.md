## Security audit for spec 194

Auditor: security-auditor, 2026-11-09. Scope: `supabase/migrations/20261109170000_kept_records_delete_hardening.sql`, `supabase/tests/kept_records_delete_hardening.test.sql`, and the `deletePoItem` / `upsertVendorDraftOrder` hunks in `src/lib/db.ts` (L1889-1909, L1991-2016). Other `db.ts` hunks belong to other sessions and are not reviewed here.

Method: read the spec, migration, test file and client hunks. Checked the live local catalog (migration `20261109170000` is applied). Ran two rolled-back probe transactions against the local stack (`begin; ... rollback;`, nothing reset or restarted). Probe scripts:
`/private/tmp/claude-501/-Users-will-Documents-GitHub-INVENTORY-MANAGEMENT/f54e7482-2a5d-4487-8b1f-fd2a8ce67204/scratchpad/probe194.sql` and `.../probe194b.sql`. No prod access.

### Verdict on the focus areas

**D-2 server-context exemption (migration L83-90).** No client path reaches it as staff. Evidence:

- **PostgREST role switching.** `authenticator` is a member of only `anon`, `authenticated` and `service_role`. A JWT with `role: service_role` needs the JWT secret. No `custom_access_token` hook is configured (`supabase/config.toml:303-306` is commented out). So a non-service caller always runs as `anon` or `authenticated` with claims role `anon` or `authenticated`. Both fail the exemption.
- **SECURITY DEFINER RPCs.** Inside an SD body, `current_user` becomes the owner, but the claims GUC keeps the caller's `authenticated`. So the second condition fails and the code falls through to `auth_is_privileged()`. Probe: a `postgres`-owned SD wrapper that re-dates a received PO, called as staff, raised `42501 purchase_orders: created_at is immutable`. The pgTAP AC-8(d) arm pins the same thing. The exemption can be reached only by a function that clears or rewrites `request.jwt.claims` / `request.jwt.claim.role`. Across every non-system schema, the only function that calls `set_config('request.jwt…')` is `realtime.apply_rls`. It is SECURITY INVOKER and not in an exposed schema (`config.toml:13` exposes `public` and `graphql_public` only). No `public` function has `proconfig` that sets a role or claim GUC.
- **Edge functions with service-role clients.** Only three functions write these tables. `send-po-email` sets `status: "sent"` with a constant and `eq('status','draft')` (`index.ts:204-208`, behind the admin gate). `breadbot-nightly-sync` only inserts (`index.ts:340, 365`). `eod-reminder-cron` only reads. None forwards a caller-supplied column map, so none can re-date a row for a user.
- **Server-side writers.** The `public` functions that update these tables are `auto_receive_due_purchase_orders`, `record_vendor_order_attempt`, `admin_dedupe_recipes`, and the receive, cancel and close-short RPCs. None of them assigns `created_at`, `logged_at`, `imported_at`, `po_id` or `import_id`. No other BEFORE UPDATE trigger on these tables rewrites a date column, so the column-scoped triggers cannot be dodged through a later trigger. `set_po_number` is BEFORE INSERT only, and the `notify_*` triggers are AFTER triggers.
- **Legacy GUC precedence.** Setting `request.jwt.claim.role = 'service_role'` while `current_user = authenticated` is still refused. The probe showed `42501`, because the `current_user` half fails. Clients cannot set that GUC through PostgREST anyway.
- **Upsert path.** PostgREST `Prefer: resolution=merge-duplicates` becomes `INSERT … ON CONFLICT DO UPDATE SET <col> = excluded.<col>`. Column-scoped BEFORE UPDATE triggers fire on that path. The probe, as staff, raised `42501` on all four: `purchase_orders.created_at`, `waste_log.logged_at`, `po_items.po_id` and `pos_import_items.import_id`. The test file has no upsert arm (see Low-3).
- **Trigger functions.** `has_function_privilege('authenticated', …)` is false for all four. The ACL is `{postgres, service_role}`. Every function is SECURITY INVOKER with `search_path=public`.

**Restrictive delete policies (migration L236-254).**

- There are no views over the five tables, so no owner-run view can bypass RLS.
- `relforcerowsecurity` is false, but the owner is `postgres`, which already bypasses RLS. That is not a client path.
- Staff deletes of a line under a 200-day received PO and of an aged import returned `ok:0` in the probe.
- The FKs from `po_items.item_id`, `waste_log.item_id`, `purchase_orders.vendor_id` and `pos_import_items.recipe_id` are all `NO ACTION`. Deleting a catalog item, vendor or recipe therefore cannot cascade-delete kept rows. It is refused while they are referenced.
- `created_by`, `received_by`, `logged_by` and `imported_by` are `SET NULL`, so deleting a user keeps the records.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **Low-1: `purchase_orders.status` can be set to NULL by any store member.** The CHECK is `status = ANY(...)` (`supabase/migrations/20260704000000_po_loop.sql` ~L109), and `status` is nullable. Probe: staff ran `update purchase_orders set status = null` on a 200-day `received` PO and got `ok:1`. This does **not** reopen M2:
  - The next move, NULL → draft, is refused (`42501 purchase_orders: status cannot return to draft`, migration L144). The guard's `is distinct from` handles NULL correctly.
  - `po_items_restrict_delete_non_draft` treats a NULL parent as not a draft, so its lines stay undeletable.

  It is still a way to make a kept PO drop out of every status-filtered list and report without deleting it. That is an edit, which the owner placed out of scope ("This spec stops deletion, not edits"). Recommend adding it to the "freeze non-draft POs" follow-up as a `status NOT NULL` constraint, after a prod NULL check. AC-34 already counts POs by status, so the pre-check will show any existing NULLs.
- **Low-2: these remaining routes to remove or hollow a kept record are outside this spec, and each matches an owner decision.** Listed so the release-coordinator can see the residuals in one place:
  - Privileged two-step (re-date, then delete inside the 1-day window). Accepted, and pinned by AC-5.
  - Store delete (`privileged_delete_stores`) and brand delete (`super_admin_manage_brands`) cascade every kept row. Privileged only, and unchanged since spec 186.
  - Fresh-parent delete inside 1 day cascades its lines. This is by design (R5).
  - Line edits such as `ordered_qty`, `received_qty`, `qty_sold` and `item_id`, and `po_items` INSERT onto non-draft POs. These are out of scope ("Editing kept rows").
  - `waste_log.store_id` and `pos_imports.store_id` are not locked. A member granted on two stores can move a kept row between them (probe: `ok:1`). Same edit class. `purchase_orders.store_id` is already locked by spec 177.
  - Future-dated inserts. These are now weaker than the spec's "Not in this spec" text suggests. Lines cannot be moved into a future-dated parent, and kept rows cannot be re-dated forward, so this only lets a member delete rows they invented themselves. It is no longer a route to a real kept record.
  - `TRUNCATE` is granted to `authenticated` on all five tables (spec 186 audit L4). PostgREST and pg_graphql cannot issue TRUNCATE, so it is not API-reachable. It is still worth revoking in the L4 follow-up.
- **Low-3: there is no pgTAP arm for the upsert shape (`INSERT … ON CONFLICT DO UPDATE`).** `supabase/tests/kept_records_delete_hardening.test.sql` tests only plain `UPDATE`. The rolled-back probe shows the triggers fire on the upsert path. A future switch to statement-level or `WHEN`-qualified triggers could silently drop that coverage. Optional: add one staff `throws_ok` arm per guard using `on conflict (id) do update set <col> = excluded.<col>`. Test-engineer's call. Noted here because it is a bypass surface.
- **Low-4: the privileged branch trusts JWT `app_metadata.role`** (migration L92 → `auth_is_admin()`). A just-demoted admin or master keeps date-change rights until the access token expires. This is the same posture as every admin-gated policy in the project, not new to this spec. Mentioned only because the owner's accepted residual (privileged two-step) briefly extends to a demoted account.

### Client code (`src/lib/db.ts`)

- `deletePoItem` (L2002-2016) and `upsertVendorDraftOrder` (L1898-1909) log only fixed strings and row counts, with no ids, tokens or PII.
- The thrown message `PO line was not removed. The order may no longer be a draft.` leaks nothing.
- Treating a `null` count as success only keeps the old behaviour, and the server-side policy remains the boundary.
- Neither function uses `useRole()` or any other client-side value as a security gate.

### Dependencies

`package.json` is not part of this spec's change set. The working-tree diff to `package.json` belongs to other sessions, so the dependency audit was skipped for spec 194.
