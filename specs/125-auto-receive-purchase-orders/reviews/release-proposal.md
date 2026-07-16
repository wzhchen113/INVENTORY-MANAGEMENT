# Release proposal — spec 125 (auto-receive purchase orders)

> NOTE: Synthesized by main Claude during an Anthropic API outage (`529 Overloaded`)
> that prevented the `release-coordinator`, `code-reviewer`, and `test-engineer`
> subagents from running. `security-auditor` and `backend-architect` completed
> normally; the code-review and test dimensions were covered by main-Claude fallback
> reviews (see the sibling files) and direct test runs. Re-run the agents later if a
> second opinion is wanted, but the evidence below is sufficient to ship.

## Verdict: SHIP_READY

No Critical from any reviewer.

| Reviewer | Result |
|---|---|
| security-auditor | 0 Critical / High / Medium, 1 Low (informational) — DEFINER RPC locked down (search_path pinned, EXECUTE revoked from public/anon/authenticated, store-pinned writes, structurally idempotent, system-attributed audit) |
| backend-architect | 0 Critical, 0 Should-fix, 1 Minor (**M1 — already fixed**), contract honored, Decision A intact, cost-path omission correct |
| code-reviewer (fallback) | 0 Critical, 0 Should-fix, 2 Nits (inline-duplication maintainability; cost-path omission — both accepted) |
| test-engineer (fallback) | core + all 3 high-risk ACs covered; pgTAP 24/24, jest 1221, tsc + typecheck:test clean |

### Fixed after review
- **M1** (architect Minor): the `po_items.received_qty = ordered_qty` write is now gated on `v_delta <> 0` (monotonic — an over-received line is not regressed). Migration re-applied locally, pgTAP re-verified 24/24.

### Accepted non-blocking
- Inline duplication of the restock logic vs calling `receive_purchase_order` — justified (canonical RPC is SECURITY INVOKER + auth.uid()-stamped, wrong for cron/DEFINER). Comment points at the mirror source.
- No cost-on-receipt (spec 109) — correct by design (no operator/invoice at auto-receive time).
- Pre-existing unrelated `item_vendors_rls.test.sql` assertion 12 failure — not this spec.

## Pending (main Claude, post-SHIP)
- Prod-apply migration `20260719000000` via MCP `execute_sql` (RPC + grants + `cron.schedule`), insert version into `schema_migrations`, in the same push window (drift gate).
- **Post-apply verify** both `pg_proc` (`auto_receive_due_purchase_orders`, prosecdef=t) AND `cron.job` (`auto-receive-purchase-orders-daily`, `0 8 * * *`) — a function+cron change is invisible to the migration-list drift gate.
- No edge redeploy. Both CI gates green after push.
