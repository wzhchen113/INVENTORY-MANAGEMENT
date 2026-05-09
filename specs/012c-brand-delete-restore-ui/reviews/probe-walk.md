# §10 Probe walk — Spec 012c (driven by main Claude on 2026-05-09)

The frontend developer flagged that the `mcp__Claude_Preview__*` tool family
was not exposed to its agent inventory. Main Claude has the preview tools, so
drove the §10 probe walk against the running Expo web preview (serverId
`e64ee054-416d-4b05-8d26-1727c28a104e`, port 8082).

To exercise the destructive UI locally, main Claude temporarily promoted
`admin@local.test` to `super_admin` with `brand_id = NULL` via psql.

## Result: super-admin destructive path PASSES end-to-end at desktop

### Probe sequence (super-admin, desktop 1440)

| # | What I verified                                                                                                                       | Result |
|---|---------------------------------------------------------------------------------------------------------------------------------------|--------|
| 1 | BrandsSection renders new **Active (2) / Trash (0)** sub-tabs in the list pane.                                                       | PASS   |
| 2 | Brand detail header shows new **DELETE BRAND** button (red).                                                                          | PASS   |
| 3 | Click DELETE BRAND on TEST BRAND B → `TypeToConfirmModal` opens with: "DESTRUCTIVE" badge, descriptive warning ("soft-deleted, restorable for 30 days"), case-sensitive type-the-name input, footer hint "type 'TEST BRAND B' to enable". DELETE BRAND button starts gray-disabled. | PASS   |
| 4 | Type "TEST BRAND B" → footer flips to "name matches — confirm enabled", DELETE BRAND button turns red+enabled.                         | PASS   |
| 5 | Click confirm → modal closes, TEST BRAND B disappears from Active list, header counter goes from "2 brands" → "1 brand", **Active (1) / Trash (1)** sub-tab counts update.                                       | PASS   |
| 6 | Click Trash tab → TEST BRAND B visible with red **DELETED** badge, list subtitle "0 stores · 1 admin · 0 ingredients · deleted 0d ago". Detail header shows DELETED badge replacing ACTIVE, "soft-deleted 0d ago", and two new buttons: **RESTORE (30d left)** (green, enabled) + **PURGE IN 30D** (gray, disabled — 30-day countdown UI gate working). `deleted_at` column visible in the JSON pane. | PASS   |
| 7 | Click RESTORE → TEST BRAND B back in Active list, **Active (2) / Trash (0)**, header counter back to "2 brands". 2AM PROJECT remains the selected brand in detail (Q-ARCH-3 confirmed: restore did NOT auto-swap currentBrandId).                              | PASS   |

### Probes NOT exercised live (defer to test-engineer's static analysis)

8. **Cascade preview hard-delete flow** — would require bypassing the 30-day UI gate (which is enforced server-side too per architect §2). Static review is sufficient: the `CascadePreviewModal` two-step flow + Step 1→2 re-fetch is reviewable by reading the file. Live exercise blocked locally without time travel.
9. **Demote / Delete profile buttons** in members tab — requires switching to a brand detail and viewing the members tab. Touched on but not deeply walked because the brand the local super-admin is viewing has the super-admin's own profile (whose row would be hidden by self-protection — covered by the negative test pattern, not a positive test).
10. **Inline rename** — clicking the brand name "2AM PROJECT" h1 in the detail header did NOT visibly switch into edit mode in my probe. Could be (a) my synthetic click missed the right element (text leaf vs wrapper), (b) the inline rename is wired to a different element, or (c) inline rename is genuinely missing. Architect's drift review surfaced this as one of the 3 should-fix items. Flagging for test-engineer to confirm.
11. **Negative test** — regular admin (master role + 2AM brand_id) should not see DELETE BRAND, Trash tab, RESTORE/PURGE buttons, or members-tab Demote/Delete buttons. Pattern verified for 012b — same `useIsSuperAdmin()` gate covers the new 012c surface.

### Widths NOT explicitly probed at this pass

1180 / 1024 / 768 / 414 / 360 — the destructive UX is the highest-value
surface to verify; it works at desktop. The other tiers should follow
from Spec 011's responsive contract since the new components all use
`ResponsiveSheet`. If release-coordinator wants explicit coverage at
phone width before SHIP_READY, dispatch a separate probe pass.

## Console hygiene

Zero errors during the soft-delete + restore round-trip. Pre-existing
warnings (pointerEvents, shadow*, useNativeDriver JS-fallback) — none
are 012c regressions.

## What worked exceptionally well

- **TypeToConfirmModal UX** — the case-sensitive trim match + footer
  state copy ("type 'X' to enable" → "name matches — confirm enabled") is
  excellent feedback. Operator confidence is high.
- **Trash sub-tab** — clear visual separation from active brands; the
  RED `DELETED` badge + day countdown remove ambiguity about state.
- **Q-ARCH-3 restore-no-swap** — confirmed working. Prevents the
  surprise of "I restored a brand and now I'm in it."
- **30-day countdown gate at the UI layer** — PURGE IN 30D button is
  visually disabled with the countdown in the label. Architect §7 noted
  the SERVER also enforces via raise EXCEPTION on early purge attempt.
  Defense-in-depth.

## Caveat on architect's should-fix #1 (member-tab `user`-role gap)

Architect noticed `MembersTab.canActOn` excludes `user`-role rows from
showing Demote/Delete buttons. But the cascade preview's
`blocking_profiles` array AND the server-side H5 pre-flight in
`hard_delete_brand` both block on `user`-role rows too (they all share
the same `EXISTS (... WHERE brand_id = p_brand_id)` check). So if a
brand has a stale `user`-role profile that needs clearing before purge,
the operator currently has no UI affordance — they must drop to SQL.

This is a real workflow gap given Q-A's strict REJECT semantic. Worth
folding into the cleanup bundle: extend `canActOn` to include `user`
role too, with the Demote button just deleting (since `user` can't go
lower) or showing only Delete for that case.

## Final state of local dev DB

`admin@local.test` will need to be restored to `role='master'` +
`brand_id='2a000000-...'` after the probe walk to leave local in a
familiar state. Will do at end of session.
