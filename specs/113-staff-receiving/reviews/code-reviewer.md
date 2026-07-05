## Code review for spec 113

Scope: staff-side receiving against open POs (backend price-path gate +
staff Receiving screen). Two slices reviewed: `supabase/migrations/20260707000000_staff_receiving_price_gate.sql`
+ `supabase/tests/staff_receiving_gate.test.sql` (backend), and
`src/screens/staff/lib/receiving.ts` (+.test.ts), `src/screens/staff/screens/Receiving.tsx`
(+.test.tsx), `src/screens/staff/navigation/StaffStack.tsx`, and the three staff
i18n catalogs (frontend). Architecture and security are out of scope for this
pass (backend-architect / security-auditor cover those); this review is
quality/craft/convention-adherence, with runtime already browser-verified by
main Claude.

### Critical

None.

The migration diff against its stated source
(`20260705000000_cost_on_receipt.sql:122-386`) was compared line-by-line and
the ONLY delta is the 15-line gate hunk (`supabase/migrations/20260707000000_staff_receiving_price_gate.sql:220-234`)
at the exact designed site — first statement inside `if v_item_id is not null
and v_line.new_case_price is not null then`, before the `< 0` check. The
pinned string `'forbidden: price change requires admin'` with errcode `42501`
is byte-exact in the migration, the `comment on function` block, and both
pgTAP `throws_ok` call sites (`staff_receiving_gate.test.sql:287`, `:646`,
`:671`). No grant/revoke re-emit. No admin file touched. No `db.ts` edit. No
`json-server`/`db.json` pattern reintroduced. No `app.json` change. `StaffTabs`
is the only nav edit, additive (3→4 tabs), matching the existing pattern. No
new realtime channel. `plan(45)` matches exactly 45 assertions in the file.

### Should-fix

- `src/screens/staff/i18n/en.json:287-294` (and the identical `es.json`/`zh-CN.json` blocks) — `receiving.col.item`, `receiving.col.ordered`, and `receiving.col.received` are defined in all three locale catalogs but are dead: grepping every `t('receiving.*')` call site in `Receiving.tsx` turns up no reference to `col.item`, `col.ordered`, or `col.received` (only `col.receiveNow` / `col.receiveNowAria` are used — the ordered/received/outstanding labels were folded into the combined `line.orderedReceived` / `line.outstanding` interpolated strings instead). These three keys exist only because the spec's "required keys (at minimum)" list (`specs/113-staff-receiving.md:1023`) named them before the final per-line layout consolidated them into sentences. The cross-locale parity test (`i18n.test.ts`) will pass regardless since all three locales define them identically, so this won't be caught by CI. Either wire them up (if a future column-header layout is intended) or delete the three unused keys from all three catalogs in the same PR so the `receiving.*` block reflects only what's rendered.

### Nits

- `src/screens/staff/lib/receiving.ts:117` (`fetchStaffOpenPos`) and `:161` (`fetchStaffPoLines`) — no `.limit()` on either read. Both admin-mirrored reads are unbounded (all open POs for a store; all lines for a PO). Given the seed scale and PO cardinality this is very unlikely to matter, but if it's ever worth capping, that's a backend-slice change, not something to add speculatively here.
- `src/screens/staff/screens/Receiving.tsx:475` / `:502` — the fallback date display `po.createdAt.slice(0, 10)` duplicates the same slice expression at both the list-row and detail-header call sites. Minor (out-of-scope): a tiny one-line `formatPoDate(po)` local helper would remove the duplication, but it's two call sites in one file and not worth a refactor pass on its own.
- `src/screens/staff/screens/Receiving.tsx:66-73` — `shortPoId` truncates a UUID to its last 6 hex chars for display; fine as a pure helper, but it isn't unit-tested independently (the jest plan tests it only indirectly through rendered list rows). Not required by the spec's jest plan, so this is a preference, not a gap.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

- **Should-fix (dead i18n keys) — FIXED.** Removed `receiving.col.item`,
  `receiving.col.ordered`, `receiving.col.received` — AND `receiving.col.outstanding`
  (a fourth dead key the review didn't list; verified unreferenced — the
  outstanding remainder renders via `receiving.line.outstanding`, a different
  path) — from all three staff catalogs. `col` now holds only the two live keys
  (`receiveNow`, `receiveNowAria`). jest 1031/1031, both typechecks exit 0.
- **Nits (unbounded carve-out reads, duplicated date-slice, untested shortPoId)
  — LEFT** per their own out-of-scope framing; the unbounded-read note is worth
  a follow-up if a store ever accumulates many open POs, but v1 open-PO counts
  are tiny.
