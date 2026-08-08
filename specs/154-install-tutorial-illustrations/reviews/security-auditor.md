# Security audit for spec 154 — Phone-frame illustrations for the Add-to-Home-Screen tutorial

Reviewed: `CLAUDE.md`, `specs/154-install-tutorial-illustrations.md`, full staged diff
(`git diff HEAD`, 15 files / +1333 / −62).

**Verdict: no Critical, no High, no Medium. Two Low (informational).** Nothing blocks merge.

This is a genuinely visual-only change. Every attack surface this project's threat model
cares about (RLS, edge functions, service tokens, PII in responses/logs, dependency
supply chain) is untouched by the diff.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/i18n/en.json:178-184` + the five sibling catalogs — `chrome.installGuide.art.appName`
  hard-codes `"I.M.R"` in six files, duplicating the PWA manifest `short_name`. Not a
  security issue (no PII, no secret, no credential — it is the public brand short name
  already shipped in the manifest and the page title). Flagged only as drift surface: a
  future brand rename must touch seven places. Informational; no action required for this
  spec.
- `src/components/illustrations/StepIllustration.tsx:184-276` — trademark-adjacent, as
  requested by the dispatcher. The drawings are stylized suggestions of OS chrome
  (rounded body, toolbar, share sheet, overflow dropdown, dialog) built from this app's
  own `useCmdColors()` / `useStaffColors()` tokens. There is **no** vendor logo, wordmark,
  glyph trace, or brand color anywhere in the file — `appIcon()` at line 172-182 draws an
  abstract three-bar mark in `P.highlight`, not an Apple/Google asset, and AC-7 (zero
  image assets) holds: the diff adds nothing under `assets/` or `public/`. The literal
  strings drawn inside the pictures (`"Add to Home Screen"`, `"Install app"`, `"Add"`,
  `"Install"`) are functional OS UI labels, not marks, and remain fully localized. The
  words "Safari" / "Chrome" appear only in the pre-existing spec-153 step prose, which is
  ordinary nominative reference. **Noted, not blocking** — I see no IP exposure here, and
  this is a business call rather than a security one.

### Verification performed against the dispatcher's checklist

1. **No new network calls.** Grepped every changed file under `src/**` for
   `fetch(`, `XMLHttpRequest`, `axios`, `supabase`, `EXPO_PUBLIC`, `process.env`,
   `Linking.`, `WebView`, `eval(`, `require(`, `dangerouslySetInnerHTML`. The only hits
   are (a) prose in code comments and (b) the pre-existing `jest.mock('../../../lib/supabase')`
   in `src/screens/staff/screens/Settings.test.tsx:13`, untouched by this diff. Zero
   runtime network or storage calls added.
2. **No supabase import, direct or transitive.** `src/components/illustrations/StepIllustration.tsx:37-40`
   imports exactly `react`, `react-native`, `react-native-svg`, and a **type-only** import
   of `InstallArt` from `src/lib/installGuide`. Walked the transitive chain:
   `installGuide.ts:30-32` → `react`, `react-native`, `./notificationState`;
   `notificationState.ts:21-22` → `react-native` and `import type { SubscribeResult }`
   from `./webPush` (type-only, erased at compile — the runtime `webPush` module, which
   *does* hold supabase calls, is never pulled in). The spec-063 staff slice-isolation
   contract therefore survives `src/screens/staff/components/InstallGuideCard.tsx:26-30`
   reaching into the shared `src/components/` tree: no `useStore`, no supabase client, no
   auth path is dragged into the staff bundle.
3. **No store contract change.** Neither `src/store/useStore.ts` nor
   `src/screens/staff/store/` appears in the diff. `src/lib/installGuide.ts` gains only a
   pure `InstallArt` string union and an `art` field on the pure `InstallStep` model
   (lines 43-52, 65-66); `installSteps()` stays pure/total with its `never` guard intact.
4. **No PII or secrets in the new i18n keys, either catalog set.** All five new keys in
   all six files are static OS button labels plus the public brand short name. No email,
   no store name, no user id, no token, no URL, no key material. Verified in
   `src/i18n/{en,es,zh-CN}.json` and `src/screens/staff/i18n/{en,es,zh-CN}.json` (identical
   key sets — the two existing parity suites gate this).
5. **No dependency added.** `package.json` and `package-lock.json` are **not** in
   `git diff HEAD --name-only`. `react-native-svg` is pre-existing (`package.json:62`);
   `@playwright/test@^1.60.0` is pre-existing from spec 078 (`package.json:70`,
   `playwright.config.ts`) and was used only as a local browser-check harness, not added
   here. No untracked files in the working tree.
6. **No injection surface in the rendered labels.** `StepIllustration.tsx:506-531` renders
   `labels[l.id]` as the child of an RN `<Text>`, which react-native-web emits as an
   escaped DOM text node — not `dangerouslySetInnerHTML`, not an SVG `<text>` with raw
   markup. The values are compile-time catalog constants resolved through each surface's
   own `t` / `T`, never request or user input. No XSS path.
7. **No unbounded arithmetic.** `scale = width / spec.w` (line 489) divides by a
   module-level constant (`PW=124` / `DW=176`), and both call sites clamp `width` with
   `Math.max(140, Math.min(280, windowWidth - 96))` (`InstallGuideSheet.tsx`) and
   `Math.max(120, Math.min(200, windowWidth - 64))` (`InstallGuideCard.tsx`), so a
   zero/negative `windowWidth` cannot produce NaN or a divide-by-zero.
8. **AC-REG3 holds (no backend surface).** Confirmed by `git diff HEAD --stat`: nothing
   under `supabase/**`, no `src/lib/db.ts`, no `vercel.json`, no `app.json` (slug
   untouched, per the CLAUDE.md do-not-auto-fix rule), no `assets/**`, no `public/**`.
   No migration, so the `db-migrations-applied.yml` gate has nothing new to assert.
9. **Palette tokens resolve.** Spot-checked that every slot the two call sites map exists,
   so no `undefined` reaches an SVG `fill`: `accentBg` / `accentFg` / `borderStrong` in
   `src/theme/colors.ts:187-229` (both light and dark), `primaryPressedLight` /
   `textOnPrimary` / `borderStrong` in `src/screens/staff/theme.ts:41-105` (both modes).

### Project-specific checklist — N/A for this diff

- RLS on new tables — no migration in the diff.
- Edge function `verify_jwt` / service-token bearer — no `supabase/functions/**` change.
- `super_admin` in `ADMIN_ROLES`, `escapeHtml` on Resend HTML bodies, last-of-role guard,
  `caller.id != target.id` self-guard — no role-gated, mail-sending, or destructive path
  added.
- `callEdgeFunction` vs raw `fetch` — no edge-function call site added.
- Realtime publication / channel scoping — no subscription added.
- Client-side `useRole()` used as a security boundary — not used anywhere in the diff.

### Dependencies

`package.json` unchanged (and `package-lock.json` unchanged) — `npm audit` skipped per
process step 3. No new transitive surface introduced by this spec.
