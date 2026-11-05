# Spec 177: prod apply record (AC-24)

- **Date:** 2026-10-26
- **Applied by:** main Claude, after the owner's explicit go-ahead: "Go ahead: apply spec 177's migration to prod using the corrected runbook (S-1/S-2), and stop on any unexpected result."
- **Project:** `ebwnovzzkwhsdxkpyjka`, via Supabase MCP `execute_sql`. `apply_migration` was not used.
- **Runbook:** §10 of the spec, with the backend-architect's S-1, S-2, M-1 and M-2 corrections (`reviews/backend-architect.md`).

## M-1: local md5s recomputed before applying

- The staged migration file is identical to the working tree.
- I re-applied the file to the local stack (it can safely be re-run) and recomputed the normalized md5s. They match the recorded values:
  - `po_items_check_store`: `ec2c92efed047dcf53d10e5ac1017b24`
  - `order_approvals_lines_check_store`: `71491c6fa58d6174bd4a633dd115bc03`
  - `purchase_orders_lock_store_id`: `d357ad345b4b38f2ea34bfd25eef06d2`

## Step 1: read-only pre-check

Every value was as expected:
- **Postgres version:** 17.6.
- **`schema_migrations` at or after `20261024000000`:** `20261024000000` only.
- **The three new functions:** none existed yet (3 × NULL).
- **`po_items`:** 40 rows in total. Null items, orphan items, orphan POs and cross-store lines were all 0.
- **`order_approvals`:** 0 rows, and 0 non-array `lines`. `purchase_orders` had 0 rows with a NULL `store_id`.
- **Foreign keys:**
  - `po_items.item_id`: NO ACTION (`a`/`a`).
  - `po_items.po_id`: ON DELETE CASCADE.
  - `purchase_orders.store_id`: ON DELETE CASCADE, update NO ACTION.
- **Existing triggers:** `order_approvals_guard`, `notify_purchase_order` and `set_po_number`, all enabled (`O`).

## Step 2 (S-1): apply

- I sent the full text of `supabase/migrations/20261025000000_cross_store_item_rejection.sql` verbatim in a single `execute_sql` call. This included the header and the `begin; set local lock_timeout = '5s'; … commit;` wrapper.
- It completed with no error.

## Step 3: record the migration

- I inserted `('20261025000000', 'cross_store_item_rejection')` into `supabase_migrations.schema_migrations` with `on conflict do nothing`.
- **M-2 confirm:** exactly one row exists, `20261025000000` / `cross_store_item_rejection`.

## Step 4: verify

- **md5s:** on prod they match local exactly: `ec2c92ef…`, `71491c6f…` and `d357ad34…`.
- **Privileges, for all three functions:**
  - `prosecdef = false`;
  - `proacl = {postgres=X/postgres,service_role=X/postgres}`, with no PUBLIC entry;
  - `anon` and `authenticated` cannot EXECUTE.
- **Triggers, all three present and enabled (`O`):**
  - `po_items_check_store_trg`: BEFORE INSERT OR UPDATE OF item_id, po_id.
  - `order_approvals_lines_check_store_trg`: BEFORE INSERT OR UPDATE OF lines.
  - `purchase_orders_lock_store_id_trg`: BEFORE UPDATE OF store_id.

## Step 5 (S-2): negative probe

- **Method:** the always-raising DO block. Whatever happens, it ends in an exception, so no write can persist.
- **Result:** `ERROR P0001: PROBE OK: po_items: item store mismatch with parent purchase order`.
- **Afterwards:** `po_items` still has 0 cross-store lines out of 40, so nothing persisted.

## Step 6: still to do (owner)

1. Commit, then push.
2. Confirm that the latest `test.yml` and `db-migrations-applied.yml` runs on `main` are green.
3. Check `e2e.yml` by hand.

Before the apply, all three were green on `main` at `8872de2`.

## Rollback (if ever needed)

This is pure DDL and no data was written. Drop the three triggers and then the three functions, and delete the `schema_migrations` row for `20261025000000`.
