# Code review for spec 131

Scope: `supabase/migrations/20260723000000_extension_ordering.sql`,
`src/lib/db.ts`, `src/types/index.ts`, `src/utils/poQuickOrderText.ts`,
`src/store/useStore.ts`, `src/components/cmd/VendorFormDrawer.tsx`,
`src/components/cmd/IngredientForm.tsx`, `src/components/cmd/IngredientFormDrawer.tsx`,
i18n ×3, `supabase/tests/vendors_role_access.test.sql`,
`supabase/tests/extension_ordering.test.sql`,
`src/utils/poQuickOrderText.test.ts`, `src/lib/db.updateVendor.test.ts`,
and the type-forced test-fixture updates.

## Critical

None.

## Should-fix

- **`src/components/cmd/IngredientForm.tsx` (+ `IngredientFormDrawer.tsx`,
  `src/i18n/*.json` `section.inventory.productPageUrl*`) — the
  `product_page_url` editor field ships despite the architect design
  twice-explicitly deferring it.** Design D-2 ("Wiring an editor field for it
  … is a spec-132/follow-up FRONTEND task — flagged, not built in 131") and
  D-13 ("The `product_page_url` editor field is a spec-132/follow-up — NOT
  built here") are unambiguous. The build notes say a conflicting external
  "task item 4" directed building it and the developer resolved the conflict
  toward the task instruction rather than the design — but the design is the
  contract for this pipeline (CLAUDE.md: architect designs, developers
  implement to the design), and the spec file itself (the source of truth) is
  what says "NOT built here," twice. **Recommend REVERT** the editor-field
  hunks — `IngredientForm.tsx` (`handleVendorProductPageUrlChange`, the
  `productPageUrl` InputLine, `VendorLinkRow`/`updateVendorLinkField`/
  `vendorRowsToLinkPayload` threading), `IngredientFormDrawer.tsx` (`fromItem`
  hydration, `ItemUpdatesWithVendors` widening), and the
  `section.inventory.productPageUrl*` i18n keys — and keep only the column +
  `db.ts` mapper/upsert threading (D-7, unambiguously in scope), landing the
  editor field together with spec 132 as originally planned. If the owner
  wants it in 131 anyway, that's a legitimate call, but it should be an
  explicit re-approval (architect or user), not a developer-side scope
  resolution against an explicit "NOT built here." This is flagged for
  backend-architect's post-impl drift review too; noting it here because it's
  also a craftsmanship concern (see next finding).

- **Same field — shipping the editor control without wiring
  `apply_item_vendors_to_brand` propagation creates a silent, sibling-field
  inconsistency for admins.** `supabase/migrations/20260714000000_apply_item_vendors_to_brand.sql:136,143,146`
  propagates `order_code` on both the INSERT and `ON CONFLICT DO UPDATE`
  branches of the brand fan-out; `product_page_url` is not in that column
  list at all. In `IngredientForm.tsx` the two fields are literally sibling
  `InputLine`s in the same per-vendor card (`src/components/cmd/IngredientForm.tsx:1308-1327`),
  same layout, same help-text idiom. An admin who fills in a product page URL
  and then taps "Apply vendors to all stores" (whose help text at
  `src/i18n/en.json:346` correctly says it propagates "vendors, primary, and
  order codes" — that copy wasn't touched, so it isn't lying) will see the
  order code propagate and the product page URL silently NOT propagate, with
  no UI signal that the two adjacent fields behave differently. This is a
  direct consequence of shipping the editor field ahead of the design's plan
  (which intentionally sequenced the RPC/propagation work as a follow-up
  alongside spec 132). If the field ships in 131 (see above), add
  `product_page_url` to `apply_item_vendors_to_brand` in the same PR for
  parity; if reverted per the finding above, this resolves itself.

- **`supabase/tests/extension_ordering.test.sql:25` — the header comment
  documents an (M3) assertion ("a non-member cannot flip another store's PO")
  that does not exist in the file.** The file's `plan(18)` and the 18 actual
  `select is/ok/throws_ok(...)` calls only cover (P1–P5, P4b), (Q1a–Q1d, Q2,
  Q3), (M1, M1b, M2) — no M3. This is a misleading comment (claims coverage
  that isn't there) and, per D-12's own test plan ("a non-member cannot flip
  it"), a real coverage gap on the mark-ordered write's store-scoping — the
  one property that most directly backs AC-6's "the write respects
  `auth_can_see_store`." Either add the M3 assertion (attempt the guarded
  `UPDATE … status='sent'` as the Frederick manager against the Charles PO
  created at line ~213–220, assert 0 rows affected / status unchanged,
  mirroring vendors_role_access.test.sql's pattern (8)) or strike the M3 line
  from the header comment so the doc matches the file. Coordinate with
  test-engineer on which.

## Nits

- `supabase/migrations/20260723000000_extension_ordering.sql:10-18` —
  verified: the migration-timestamp bump from the design's
  `20260720000000` to the actual `20260723000000` is correct and necessary
  (`20260720000000` is taken by `20260720000000_staff_reports_issue_notifications.sql`,
  and `20260722000000_ingredient_changed_badge.sql` is now the latest on
  disk). Column/RPC contents are unchanged from the design as claimed, and
  the deviation is documented in-migration and in the spec's "Files changed"
  notes. No action needed — flagging only to confirm this specific ask was
  checked and is not an issue.
- `src/utils/poQuickOrderText.ts:160-170` — `computePoQuickOrderLines` now
  calls `resolveName` for every line (not just the unmapped path), a
  deliberate and documented change from the pre-extraction implementation so
  the structured payload always carries `itemName` (comment at line 163-165
  explains this). Text-output byte-identity is preserved and pinned by jest,
  so this is correct, just worth a mental note for a future reader who
  assumes `resolveName` is only invoked lazily on the unmapped path — the
  in-line comment already covers this, no change requested.
- `src/components/cmd/VendorFormDrawer.tsx:333,363` — the `'#000'` inline
  color literal on the header/footer pills is pre-existing (untouched by this
  diff) and already tracked in the project's deferred cleanup backlog
  ("`'#000'`-on-accent sweep (~35 left)"). Not a new instance from this spec;
  noted only so it isn't mistaken for a new violation.
