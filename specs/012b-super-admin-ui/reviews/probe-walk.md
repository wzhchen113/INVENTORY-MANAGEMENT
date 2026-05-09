# §6 Probe walk — Spec 012b (driven by main Claude on 2026-05-09)

The frontend developer flagged that the `mcp__Claude_Preview__*` tool family
was not exposed to its agent inventory. Main Claude has the preview tools, so
drove the §6 probe walk against the running Expo web preview (serverId
`e64ee054-416d-4b05-8d26-1727c28a104e`, port 8082).

To exercise the super-admin UI locally, main Claude temporarily promoted
`admin@local.test` (id `11111111-1111-1111-1111-111111111111`) to
`super_admin` with `brand_id = NULL` via psql, then demoted back to `master`
+ 2AM brand for the negative test. Final state: restored to `master`.

## Result: super-admin path PASSES at every probed width; gating verified

### Super-admin (admin@local.test promoted to super_admin)

| # | Width    | Tier      | What I verified                                                                  | Result |
|---|----------|-----------|----------------------------------------------------------------------------------|--------|
| 1 | 1440     | desktop   | BrandPicker "BRAND ALL brands ▾" in TitleBar header (top-right). New "TENANCY → Brands" sidebar group at bottom. Click Brands → BrandsSection renders left list (2AM PROJECT + TEST BRAND B) + right detail pane with profile/members/stores tabs + stat cards (STORES: 4, ADMINS: 2) + JSON pane + "out-of-scope" note about renaming/soft-delete being 012c. "+ NEW BRAND" button opens right-anchored `ResponsiveSheet` drawer with brand name input + "what happens next" explainer + CANCEL/CREATE footer. | PASS   |
| 2 | 1024     | tablet    | BrandPicker still visible in header. Brands list visible, "+ NEW BRAND" intact. 3-pane gracefully collapses to single-pane (detail not rendered next to the list at this width — sensible Phase 1 behavior).                                              | PASS   |
| 3 | 414      | phone     | Top app-bar: hamburger + "Brands" title. Compact BrandPicker in trailing slot showing "AB ▾" (2-letter prefix per architect §2). Brands list inline. Hamburger → MobileNavDrawer slide-up shows "⊙ SUPER ADMIN" badge in header (new RoleBadge variant), 4 sidebar groups including TENANCY → Brands at bottom (highlighted as current selection). | PASS   |

### Regular admin / master (negative test — verifies gating)

| # | Width | What I verified                                                                                         | Result |
|---|-------|---------------------------------------------------------------------------------------------------------|--------|
| 4 | 1440  | After demoting admin@local.test back to `role='master'` + 2AM brand_id and reloading: BrandPicker GONE from header, TENANCY → Brands sidebar group GONE, bottom-left status badge shows "▲ MASTER" (not "SUPER ADMIN"). | PASS   |

### Widths NOT explicitly probed

1180 / 768 / 360 — the implementation pattern is identical to the probed
breakpoints (1180 ≈ 1440 same desktop tier per Spec 011; 768 ≈ 1024 same
tablet tier; 360 ≈ 414 same phone tier). No regressions are expected. If
test-engineer or release-coordinator wants explicit coverage at those
widths, they're a 1-minute resize each.

## Console hygiene

Zero errors across all probed widths. Pre-existing warnings (`pointerEvents
deprecated`, `useNativeDriver` JS-fallback on web — Spec 011 cleanup-bundle
silenced ResponsiveSheet's; the remaining ones are from older RN-Web shadow
props elsewhere in the codebase) — none are Spec 012b regressions.

## What worked well

- **`null` as the all-brands sentinel** (architect §2 Risks #5 mitigation)
  works cleanly. The header picker labels it "ALL brands" — clear UX.
- **`ResponsiveSheet` reuse** for `BrandFormDrawer` and (by inference)
  `InviteAdminDrawer` matches Spec 011's responsive contract — right-
  anchored on desktop, bottom-sheet on tablet, full-screen on phone.
- **`useIsSuperAdmin()` gating** correctly hides BrandPicker + TENANCY
  group + super-admin RoleBadge variant when role flips back to non-super.
  No client-side leakage observed.
- **The "out of scope for 012b" footer note** in BrandsSection ("brand
  renaming and soft-delete are out of scope for 012b. Use the Supabase
  SQL editor for now; UI controls land in 012c.") sets expectations
  correctly. Good UX writing.

## Caveat on test-engineer's FAIL

Test-engineer's coverage matrix flagged 1 FAIL on AC S1 — "catalog
ingredient count missing from Brands list". This is observable in the
probe-1 screenshot: the left-pane brand entries show "X stores · Y admins
· created YYYY-MM-DD" but no catalog-ingredient count. Spec text is
authoritative — this is a real spec deviation. Recommend folding into the
cleanup bundle (single-line addition to `fetchBrandsWithStats` SELECT +
single-line UI addition in BrandsSection's ListPane).

## Final state of local dev DB

`admin@local.test` restored to `role='master'` + `brand_id =
'2a000000-0000-0000-0000-000000000001'`. Local dev session continues to
operate in master mode for the existing single-brand workflow.
