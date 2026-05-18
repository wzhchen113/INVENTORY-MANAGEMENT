# Code review for spec 038 — Round 2 (body-extraction sweep)

## Critical

_None._

---

## Should-fix

### SF-1 — `RecipesSection.tsx` borrows from a foreign catalog namespace
`src/screens/cmd/sections/RecipesSection.tsx:181` — The recipe-list header count uses `T('section.purchaseOrders.totalCount', { count: storeRecipes.length })`. This is the POs namespace key (`"{count} total"`), not a recipes-specific key. The reuse happens to render correctly in isolation but tightly couples the recipes list rendering to the POs key's translation (if `purchaseOrders.totalCount` is ever retranslated to say "órdenes total" in es, recipes will inherit the wrong text). The catalog already has `section.recipes.totalCount` missing — add it, or reuse `common`-namespace if appropriate. This pattern also appears in `OrderScheduleSection.tsx:154-155` borrowing `section.vendors.leadCutoff*` keys for vendor cells.

### SF-2 — Visible English literals left in `RecipesSection.tsx` sales sub-tab
`src/screens/cmd/sections/RecipesSection.tsx:569` — `import {r.importId.slice(-6)}` renders a visible string that begins with the English word "import". This is not a filename or code-like literal — it displays in a row-level text column alongside translated UI.
`src/screens/cmd/sections/RecipesSection.tsx:570` — `{r.qty} units` renders the English word "units" directly in the row.
`src/screens/cmd/sections/RecipesSection.tsx:546` — `sub={\`vs sell $${sellPrice.toFixed(2)}\`}` and line 547 `sub={\`cost $${recipeCost.toFixed(2)}\`}` are English template fragments passed into `StatCard.sub`. These are in the body of the section, which the spec marks as "deferred" for the sales sub-tab body. If the intent is truly to defer these, they need a catalog placeholder comment explaining the deferral (the way `// spec 040 body deferred` comments appear elsewhere); as-is they look like misses.

### SF-3 — Visible English literal in `PrepRecipesSection.tsx` usage sub-tab
`src/screens/cmd/sections/PrepRecipesSection.tsx:606` — `{qtyPerSale} {unit} / sale` renders the English word "sale" verbatim in a row column. Needs `section.prepRecipes.perSale` or a `T('...')` wrapper.

### SF-4 — `BrandsSection.tsx` access-gate strings not extracted (file was re-touched in Round 2)
`src/screens/cmd/sections/BrandsSection.tsx:134` — `"Not available"` is a hardcoded English heading inside the `!isSuperAdmin` guard block.
`src/screens/cmd/sections/BrandsSection.tsx:136` — `"Brands management is super-admin only."` is the second hardcoded English sentence in that guard.
BrandsSection was explicitly re-opened in Round 2 to wire `roleLabel`. While the guard block is low-frequency, it is a user-visible string. Both should route through `T()`. Suggested keys: `section.brands.notAvailable` / `section.brands.superAdminOnly`.

### SF-5 — `BrandsSection.tsx` list-pane strings not extracted (same re-touched file)
`src/screens/cmd/sections/BrandsSection.tsx:412` — `accessibilityLabel="New brand"` is a hardcoded English string.
`src/screens/cmd/sections/BrandsSection.tsx:414` — `"+ NEW BRAND"` button label is hardcoded.
`src/screens/cmd/sections/BrandsSection.tsx:422-423` — Tab labels `\`Active (${activeBrands.length})\`` and `\`Trash (${trashBrands.length})\`` are hardcoded English with inline counts.
`src/screens/cmd/sections/BrandsSection.tsx:431` — `"loading…"` is hardcoded (a `common.loading` key already exists in the catalog).
`src/screens/cmd/sections/BrandsSection.tsx:437-438` — `'no soft-deleted brands'` and `'no brands yet — click "+ NEW BRAND" to create one'` are hardcoded.

---

## Nits

### N-1 — `lastNDayLetters()` in `DashboardSection.tsx` uses hardcoded two-letter day abbreviations
`src/screens/cmd/sections/DashboardSection.tsx:83` — `['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getDay()]` produces English-only labels for the heatmap column headers. The catalog already has `enum.dayOfWeek.short` keys (Mon/Tue/etc.) accessible via `dayOfWeekShortLabel()`, but those take a canonical day name, not a JS `getDay()` index. A two-character abbreviation form matching the current density (`Su`, `Mo`) is not currently in the catalog. This is a cosmetic miss in a body-level chart component; tracking here since the heatmap column labels will read English for Spanish/Chinese users.

### N-2 — `formatDayLabel()` in `AuditLogSection.tsx` hardcodes locale `'en'` in `toLocaleString`
`src/screens/cmd/sections/AuditLogSection.tsx:40` — `d.toLocaleString('en', { month: 'short' })` produces English month abbreviations ("May", "Apr") regardless of the active locale. The `T` function is already threaded into this helper for `todayPrefix`/`yesterdayPrefix` wrapping; the month abbreviation piece is the one slot that stays English. This is scoped to the audit-log day header label only and the spec explicitly deferred full date/Intl formatting to a follow-up, so this is informational. If fixed, pass the active locale down to `formatDayLabel` and use `d.toLocaleString(activeLocale, { month: 'short' })`.

### N-3 — `AuditLogSection.tsx` `byEntity` panel renders raw internal kind strings
`src/screens/cmd/sections/AuditLogSection.tsx:352` — `{kind}` renders the English internal keys (`item`, `recipe`, `pos_import`, `waste`, etc.) from `inferKind()` directly into the `byEntity` panel's row. These are code-like values, but they appear in a user-facing list column. If these are intentionally treated as opaque technical identifiers (similar to `.tsx` tab IDs), a comment explaining that would prevent future translators from flagging them. If they are meant to be displayed as readable labels, they need a `T()` wrapper. Given the spec's deferred scope for byEntity body text, this is a Nit rather than a Should-fix.

### N-4 — `ReceivingSection.tsx` state pill uses `.toUpperCase()` on an English enum
`src/screens/cmd/sections/ReceivingSection.tsx:391` — `li.state.toUpperCase()` passes `'OK'`, `'SHORT'`, `'PENDING'` directly to `StatusPill.label`. These are internal state values, not user-typed data, and the spec defers receiving body text. Noting for the follow-up sweep: a `T('enum.receivingState.ok')` pattern would close this.

### N-5 — `POsSection.tsx` PO status `.toUpperCase()` similarly hardcoded
`src/screens/cmd/sections/POsSection.tsx:166` — `label={status}` where `status` is `'sent'` or `'rcvd'` (English internal values passed to a `StatusPill`). Line 244: `selStatus.toUpperCase()` and line 398: `status.toUpperCase()` appear in the same file. Same deferral note as N-4.

### N-6 — `PrepRecipesSection.tsx` `PropertiesJson` has hardcoded `'— admin only'`
`src/screens/cmd/sections/PrepRecipesSection.tsx:419` — `value: '— admin only'` and the analogous `RecipesSection.tsx:471` — `value: '— admin only'` are inside `PropertiesJson` entries. `PropertiesJson` renders JSON-like key/value pairs in a monospace block, which makes them feel code-like, but `admin only` is an English phrase a non-English user will read. Since both sections are explicitly tagged as deferred body scope in spec 038, this is a Nit for the follow-up sweep.
