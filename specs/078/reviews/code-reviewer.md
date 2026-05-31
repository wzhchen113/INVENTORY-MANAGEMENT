## Code review for spec 078 (Playwright E2E framework)

Reviewer: code-reviewer
Files reviewed: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/auth.setup.ts`,
`e2e/fixtures/constants.ts`, `e2e/auth.spec.ts`, `e2e/eod.spec.ts`,
`e2e/invite.spec.ts`, `e2e/dashboard.spec.ts`, `e2e/reorder.spec.ts`,
`e2e/audit.spec.ts`, `e2e/dark-mode.spec.ts`, `e2e/tsconfig.json`,
`.github/workflows/e2e.yml`, `package.json`, `.gitignore`, `tsconfig.json`,
`tests/README.md`, `src/screens/LoginScreen.tsx`,
`src/screens/cmd/ResponsiveCmdShell.tsx`,
`src/screens/cmd/sections/DashboardSection.tsx`,
`src/screens/cmd/sections/ReorderSection.tsx`,
`src/screens/cmd/sections/AuditLogSection.tsx`,
`src/screens/cmd/sections/UsersSection.tsx`,
`src/components/cmd/InviteUserDrawer.tsx`.

---

### Critical

None.

---

### Should-fix

**1. `e2e/invite.spec.ts:12-19` — header comment block is stale and contradicts the actual code.**

The "ROLE-SELECTOR NOTE" comment was written for the pre-fix admin-path spec. After the master-fix was applied, three sentences in that block became false:
- "admin@local.test is a plain admin" — the spec now authenticates as master.
- "this admin-path spec does NOT click a role chip" — line 55 now asserts `invite-role-user` is visible.
- "A master-path invite that exercises invite-role-* is a deferred add (would need master storageState)" — the spec now runs under master storageState and does observe the role chip.

The per-`test.use` block comment at lines 32-35 was added by the fix and correctly explains why master is used, so the intent is readable — but the stale file-header comment directly above it is contradictory and will mislead the next maintainer. Delete or rewrite lines 12-19.

**Suggested fix:** Replace lines 12-19 with a concise note, e.g.:
```
// ROLE: this spec runs as master (STORAGE_STATE.master). The Users & access
// section is master-gated (Spec 030); a plain admin never sees the sidebar
// entry. master also sees the invite-role chips (verified in the test body).
```

---

**2. `playwright.config.ts:79-80` — `EXPO_PUBLIC_NEW_UI` is a deleted feature flag being injected into the web server.**

`EXPO_PUBLIC_NEW_UI` was removed from the production code in spec 025 (deleted `AppNavigator.tsx` + `featureFlags.ts`). It is no longer read anywhere in the live code path (confirmed: no `process.env.EXPO_PUBLIC_NEW_UI` usage in `src/` except a stale comment in `CmdAtomsPreview.tsx`). Passing it as an env var to the Expo dev server is harmless but misleading — the comment "mirrors .env.local so the dev server renders the same surface developers see locally" implies it has a runtime effect that it no longer has.

If a developer tries to understand what controls the app surface under E2E, this comment will send them on a false trail. Remove the entry (or, if there is a `.env.local` that still sets it for local dev compatibility, document that context explicitly).

---

### Nits

**3. `e2e/dark-mode.spec.ts:59` — non-null assertion `match!` after a Playwright assertion that does not narrow the TypeScript type.**

```ts
expect(match, `expected an rgb(a) background, got "${bg}"`).not.toBeNull();
const [r, g, b] = match!.slice(1).map(Number);
```

`expect(...).not.toBeNull()` throws at runtime when `match` is null, so the `!` is safe in practice. However, it is a TypeScript non-null assertion used to suppress a type error that Playwright's assertion does not statically eliminate — exactly the pattern CLAUDE.md flags as a concern. The idiomatic fix is to early-return if null:

```ts
if (!match) throw new Error(`expected an rgb(a) background, got "${bg}"`);
const [r, g, b] = match.slice(1).map(Number);
```

This eliminates the `!` and gives a clearer error than the Playwright assertion message (which includes the matcher name).

---

**4. `e2e/eod.spec.ts:47-74` — `gotoTowsonEod` helper is scoped inside `test.describe` but reads like a module-level fixture.**

The function is a plain `async function` inside the describe block. This is valid Playwright/JS, but the pattern for reusable navigation helpers in Playwright is either a named fixture (registered in a custom `test.extend()`) or a top-level function in a `helpers/` module. Inside-describe placement means it cannot be reused across spec files if a future spec also navigates to EODCount. Low risk for now since EOD is a single spec, but worth noting for consistency with the project's growing E2E tree.

(Out-of-scope for this spec — flag for the next iteration that adds EOD coverage.)

---

**5. `tests/README.md:499` — `e2e/tsconfig.json` entry in the directory tree is listed but there is no prose about it.**

The Track 4 directory tree at line 499 lists `e2e/tsconfig.json` without a comment. The other entries have inline annotations (e.g. `global-setup.ts ← OQ-4 runtime fixture`). Adding `← scopes TS for the e2e tree (base excludes e2e/**)` in-line (matching the style of `e2e/tsconfig.json`'s own header comment) would be consistent with the tree's existing style.

---

**6. `e2e/auth.setup.ts` — three setup blocks run sequentially (Playwright default), but the file comment and architecture note say "per-role setup." No explicit ordering is documented.**

All three `setup()` calls produce independent output files (`admin.json`, `master.json`, `staff.json`), so ordering does not affect correctness. But a future developer who adds a fourth role will not know that the setup blocks are independent and serial by default. One-line comment clarifying "these blocks are independent — each writes its own file; order is irrelevant" would prevent a future "does master need to run after admin?" question.

Minor; no behavior concern.

## Resolution (post-review fix-pass — main Claude)

All findings addressed or consciously deferred:

- **Should-fix #1 (stale invite.spec.ts header block)** — **fixed.** The file-header "Signed in as admin" + "ROLE-SELECTOR NOTE" block (written for the pre-fix admin path) was rewritten to a "WHY MASTER, NOT ADMIN" block consistent with the shipped `test.use({ storageState: STORAGE_STATE.master })`. The redundant inline comment above `test.use` was trimmed to a one-liner pointer.
- **Should-fix #2 (dead `EXPO_PUBLIC_NEW_UI` in playwright.config.ts)** — **fixed.** The env injection + its misleading "mirrors .env.local" comment were removed (the flag was deleted from production in spec 025; nothing reads it).
- **Nits** — `dark-mode.spec.ts` `match!`, `gotoTowsonEod` helper placement, README tree annotation, and the `auth.setup.ts` "setup blocks independent" comment: left as-is (genuinely cosmetic; no behavioral or correctness impact). Logged for a future tidy pass.

### Cross-track collision fixed (surfaced by test-engineer, diagnosed spec-078-induced)

test-engineer reported pgTAP `missed_order_audit_rpc.test.sql` arm C.1 failing locally. Root cause: spec 078's `global-setup.ts` COMMITS order_schedule rows (2 vendors × 7 weekdays) on the **Towson** store, and spec 075's pgTAP arm C also uses Towson as its positive-case store — so the missed-order RPC counted the committed fixture rows and returned >1. **CI was never affected** (test.yml + e2e.yml run against separate fresh `db reset` stacks), but a local dev running `npm run e2e` then `scripts/test-db.sh` would hit a false pgTAP failure.

**Fix:** added `e2e/global-teardown.ts` (wired via `globalTeardown` in playwright.config.ts) that deletes exactly the fixture rows global-setup inserted (Towson + the two fixture vendor_ids, all weekdays), making `npm run e2e` hermetic for its order_schedule footprint. Verified: full E2E suite still 13/13 green (teardown logs "fixture removed from Towson"); pgTAP back to **38/38**.

### Security-auditor Low also folded in

Added an exported `assertLocalStack(url)` guard in `global-setup.ts` (reused by the teardown): both service-role fixtures refuse to run against a non-`localhost`/`127.0.0.1` URL unless `E2E_ALLOW_REMOTE=1` is set — prevents a stray prod `EXPO_PUBLIC_SUPABASE_URL` from ever being targeted.

Re-verified post-fix-pass: E2E 13/13, pgTAP 38/38, jest 386/386, `tsc -p e2e/tsconfig.json` exit 0.
