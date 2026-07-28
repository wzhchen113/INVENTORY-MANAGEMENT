# Security audit for spec 142

Scope: phone-tier list/detail sections + global phone chrome. Reviewed the staged
diff (`git diff --cached --stat`, 45 files) against the spec's frontend-only claim.

## Frontend-only claim — verified

The spec asserts (§ Backend design §0) no migrations, RLS, edge functions, or
`src/lib/db.ts` contract changes. Confirmed against the actual diff:

- No files under `supabase/migrations/`, `supabase/functions/`, or `supabase/config.toml` staged.
- No `src/lib/db.ts` change staged.
- No `package.json` change — dependency audit skipped (no new libs; spec confirms
  "no new libs").
- No new `supabase.from` / `supabase.rpc` / `import ... supabase` call sites in the
  new phone subtree or the new chrome components (grep clean). All phone components
  read existing `useStore` slices and invoke the existing `logWaste` action —
  consistent with the `db.ts`-centralization rule and its documented carve-outs.
- Role-gating boundary untouched: the `RoleRouter` and `useRole` are not modified.
  New phone code contains no `useRole()` calls; the only `useRole` imports in the
  changed host sections (`VendorsSection.tsx` `useIsSuperAdmin`) are pre-existing
  and unchanged. Phone tier renders inside the already admin-only Cmd shell, so no
  new authorization surface is introduced.

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

None.

## Reviewed surfaces (evidence)

- **CALL VENDOR `tel:` path** — `src/screens/cmd/sections/phone/PhoneVendorsList.tsx:45`:
  `Linking.openURL(\`tel:${vendor.phone.replace(/[^\d+]/g, '')}\`)`. The vendor-supplied
  phone string is stripped to `[\d+]` before interpolation, so no additional URI
  scheme, path, query, or control characters can be injected into `openURL`. Empty
  phone short-circuits to an info toast (line 41-44). No injection surface. Not a finding.

- **Waste-log sheet → `logWaste`** — `src/screens/cmd/sections/phone/PhoneWasteLogSheet.tsx:66-83`.
  `save()` guards `if (!item || qty <= 0) return;`; the qty stepper clamps the floor
  to 1 (`Math.max(1, q - 1)`, line 185). It calls the existing `logWaste` store action
  with the same payload shape as the desktop path — no new validation is bypassed, and
  the optimistic-then-revert + `notifyBackendError` discipline is inherited, not
  re-implemented. Client-supplied `storeId` / `loggedByUserId` are the existing pattern;
  server-side per-store RLS (`auth_can_see_store()`) remains the enforcement boundary and
  is unchanged. Not a finding.

- **Secrets / PII** — no `Deno.env` / `process.env` / `EXPO_PUBLIC_*` / API-key /
  token / password references in any changed file. i18n additions
  (`common.editOnDesktop`, `common.availableOnDesktop`, `section.inventory.editOnDesktop`)
  are benign UI strings across en/es/zh-CN. No secrets or PII in code or catalogs.

- **New network / external resources** — none. No `fetch`, `XMLHttpRequest`, or
  hard-coded URLs introduced. The only outbound side effects are the sanitized `tel:`
  deep link and in-app `usePaletteAction` section switches.

- **Host-section guards** — all six guards (`VendorsSection`, `WasteLogSection`,
  `MenuImpactSection`, `RecipesSection`, `PrepRecipesSection`, `InventoryCatalogMode`)
  are pure `if (isPhone) return <Phone... />` forks placed after all hooks, with the
  desktop/tablet subtree unchanged. No auth/role logic touched.

## Dependencies

No `package.json` changes — `npm audit` skipped.
