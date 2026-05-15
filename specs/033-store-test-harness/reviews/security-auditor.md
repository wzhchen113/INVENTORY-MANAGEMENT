# Security audit for spec 033

## Critical (BLOCKS merge)

None.

## High (must fix before deploy)

None.

## Medium

None.

## Low

- `tests/babel-jest-dynamic-import.js:54` — Header comment claims "Literal-source imports only" — the regex `[^'"\`]+` will also match template-literal expressions with `${...}` interpolation (e.g. ``import(`./prefix-${x}`)``) because `$`/`{`/`}` are not in the negated character class. Today no such expression exists in `src/` (verified by `grep -n "import("` — only three static-literal sites at `src/store/useStore.ts:471`, `:474`, `:795`, plus `src/screens/cmd/sections/ReorderSection.tsx:457-458` and `src/components/cmd/Sidebar.tsx:42`, all of which are quoted-literal forms). The rewrite to `require(\`...${x}...\`)` would still be a valid Node call at runtime (CommonJS `require` accepts template literals; the interpolation runs before path resolution) — so even if a future file introduces this shape, the rewrite would not introduce a security bug, only a possible jest-test failure. Not a finding; flagged so a future reader is not surprised. Recommend tightening the regex character class to `[^'"\`${}]+` (or expanding the comment to acknowledge the imprecision) in a future cleanup.

- `tests/babel-jest-dynamic-import.js:65-80` — The transformer wraps `babel-jest` and is wired exclusively via `jest.config.js:62-64`'s `transform` setting inside `baseProject`, which both jest projects (`unit` + `component`) consume. Confirmed:
  - `babel.config.js` does NOT reference the file — Metro's babel preset is `babel-preset-expo` only.
  - `metro.config.js` does NOT reference the file.
  - `vercel.json:2` build command is `npx expo export --platform web`, which invokes Metro (not jest).
  - The transformer is `require()`'d only from `jest.config.js`. No other consumer.
  Production build path (Metro → Expo Web → Vercel) cannot pick up the transformer. This is exactly the scoping the spec brief asked to verify; no finding.

- `src/store/useStore.test.ts:52-103` — Mock surfaces for `../lib/supabase`, `../lib/auth`, `../lib/db` are all empty `jest.fn()` / `jest.fn().mockResolvedValue([])` stubs. No hardcoded tokens, JWTs, API keys, real UUIDs, or PII shapes. The `makeUser` helper (`:123-135`) synthesizes test rows with `email: \`${id}@example.com\`` and `id: \`u1\``/`\`u2\`` strings — clearly synthetic, no real-shaped identifiers. No finding.

## Dependencies

`npm audit --audit-level=high` — **unchanged from baseline.** No `package.json` or `package-lock.json` modifications (`git status` confirms only `jest.config.js`, `src/screens/cmd/sections/UsersSection.tsx`, `tests/README.md` modified; plus untracked spec dir, three new `*.ts` files, and the new `tests/babel-jest-dynamic-import.js`). Audit output identical to spec 032's baseline:

- high: 1 (the pre-existing `@tootallnate/once` → `jest-expo` transitive chain — fix requires major bump to `jest-expo@47.0.1`, out of scope)
- critical: 0
- total: 22

This audit result is inherited from spec 022's framework introduction and is not a spec-033 regression.

## Threat-model coverage walk

The audit brief's six focus areas, addressed in order:

### 1. `userPermissions.ts` extraction correctness

Verified byte-for-byte semantic equivalence against the pre-refactor inline expressions:

**`canDeleteUser` (`src/utils/userPermissions.ts:46-50`):**
```ts
return (isMaster
  ? !isSelf
  : !isSelf && targetRole !== 'admin' && targetRole !== 'master' && targetRole !== 'super_admin')
  && !(targetRole === 'super_admin' && lastOfRole.super_admin)
  && !(targetRole === 'master'      && lastOfRole.master);
```

vs. original (`UsersSection.tsx:284-288` pre-refactor, recovered via `git diff HEAD`):
```ts
const canDelete = (isMaster
  ? !isSelf
  : !isSelf && user.role !== 'admin' && user.role !== 'master' && user.role !== 'super_admin')
  && !(user.role === 'super_admin' && lastOfRole.super_admin)
  && !(user.role === 'master'      && lastOfRole.master);
```

Only difference: `user.role` → `targetRole`. The call site (`UsersSection.tsx:288-293`) rebinds `targetRole: user.role`. All gates preserved:
  - Self-delete refusal (`!isSelf` on BOTH branches) — spec 030 strip.
  - Non-master peer-role gate (admin / master / super_admin exclusions on non-master branch only) — spec 025 AC24.
  - Last-of-role suppression (super_admin + master) — spec 031 mirror.

**`deriveLastOfRole` (`src/utils/userPermissions.ts:69-72`):** identical filter+`length <= 1` expression as `UsersSection.tsx:76-79` pre-refactor. Defensive `<= 1` (not `<`) preserves the empty-array "hide DELETE" behavior from spec 031.

No semantic shift. The server-side gate (`delete-user` edge function + `public.assert_not_last_of_role`) is the authoritative enforcement — this helper is the UX mirror. Even if the helper were buggy and showed a DELETE button it shouldn't, the server would still reject with HTTP 400; the helper is **not** a security boundary. Same shape as `useRole.ts` placeholder (client returns `'admin'` for everyone; server enforces via `auth_is_admin()`).

### 2. Test transformer scope

The transformer at `tests/babel-jest-dynamic-import.js`:
  - Is `require()`'d only from `jest.config.js:63`.
  - Is wired via the jest `transform` field, which is jest-internal — Metro, Babel CLI, and Expo do not consult this field.
  - Is scoped to `baseProject`, used by both `unit` and `component` jest projects only.
  - Does not appear in `babel.config.js`, `metro.config.js`, `vercel.json`, or `tsconfig*.json`.
  - The rewrite (`import('literal')` → `Promise.resolve(require('literal'))`) is applied to source text in-memory and never written back to disk — the actual `useStore.ts:795` file on disk still reads `await import('../lib/auth')` and that's what Metro / Expo Web compiles to a real ESM dynamic import for code-splitting.

No production-build impact possible. No risk of the transformer altering a Vercel deployment artifact.

### 3. `npm audit` baseline

Unchanged. See `## Dependencies` section above.

### 4. Test mock surface

All mocks in `src/store/useStore.test.ts` and `src/utils/userPermissions.test.ts`:
  - `jest.fn()` stubs — no real implementations.
  - `jest.fn().mockResolvedValue([])` / `.mockResolvedValue({...})` — bare empty arrays / empty-object literals.
  - `makeUser()` helper synthesizes obviously-fake rows: `email: \`${id}@example.com\``, `color: '#000000'`, `id: 'u1'`/`'u2'`.
  - No JWTs, no API keys, no real-shaped UUIDs, no production-data slabs, no `super_admin@2amproject.com` or similar identifiable shapes.

Compared to the precedent in `src/lib/auth.test.ts:66`, which uses `access_token: 'fake-token'` — the `useStore.test.ts` mocks don't even reach that shape because the `deleteProfile` test path never traverses the session bearer (it stops at the mocked `deleteUser`).

No sensitive shapes that could leak via test logs, CI output, or accidental copy-paste into production.

### 5. Convention bullet in `tests/README.md`

The new "Store-action tests (spec 033)" subsection at `tests/README.md:198-270`:
  - Strictly additive (`git diff HEAD -- tests/README.md` confirms no existing lines removed).
  - Documents the three-mock pattern, snapshot-and-restore state reset, and the transformer rationale.
  - Does NOT weaken any prior security framing — the "hybrid mocking strategy" table at `:62-71` (rule: never mock `supabase.ts` for component tests because re-implementing chained-builder semantics is the anti-pattern) is untouched. The new subsection acknowledges the store-test case is a different unit-under-test (the store itself) and explicitly carves out the `supabase.ts` mock as "prevent module-eval crash" — not as a re-implementation of the client. Consistent with the existing posture.
  - References the transformer file but does not suggest production code should be modified to support testability — explicitly states "No production-code change."

No finding.

### 6. Transformer regex / AST scoping

The regex `/\bimport\((['"\`])([^'"\`]+)\1\)/g` is the standard "convert ESM dynamic-import to CJS sync-require" shim (matches what `babel-plugin-dynamic-import-node` would emit). Considerations:

  - **Word-boundary anchor `\b`** prevents matching `someImport(...)` or `dynamicImport(...)` variable references.
  - **Quoted-literal requirement** (capture group `(['"\`])` plus backreference `\1`) means computed-source imports like `import(varRef)` are left untouched.
  - **Template-literal edge case** (see Low item 1) — strings with `${...}` interpolation match the negated character class because `$`, `{`, `}` aren't in `['"\`]`. The rewrite would produce `Promise.resolve(require(\`...${x}...\`))`, which is valid CommonJS at runtime. No security risk; only a documentation imprecision.
  - **Scope restriction:** the transformer wraps `babel-jest` and is wired exclusively through `jest.config.js`'s `transform` setting. Metro, the Expo CLI, and `tsc` cannot pick it up.

The transformer cannot accidentally rewrite production code. If it could, the symptom would be a build-time error (jest-only `Promise.resolve(require(...))` wrappers would still resolve at Metro bundle time but might not respect Metro's module-chunking — there is no security implication, only a build-correctness one). Verified that production paths (Vercel: `expo export --platform web` → Metro → Babel via `babel-preset-expo`) do not invoke the transformer.

### Additional checks — items NOT flagged

  - **RLS:** Spec adds no migrations, touches no `supabase/migrations/`, no `auth_can_see_store()` / `auth_is_admin()` reference change. Per-store policies unchanged.
  - **Edge functions:** No `supabase/functions/` changes; no `supabase/config.toml` change to `verify_jwt` settings. `delete-user` (the server-side enforcement of the gates this helper mirrors) is untouched.
  - **Secrets:** No service-role key, service-token bearer, `SUPABASE_SERVICE_ROLE_KEY`, or `RESEND_API_KEY` introductions. No `EXPO_PUBLIC_*` additions.
  - **Logs / telemetry:** No new `console.log` / `console.warn` / `notifyBackendError` payloads. The existing `notifyBackendError` shape (logs error message + label to `console.warn`) is exercised by the test but not modified.
  - **Input validation:** Helpers are pure-TS booleans operating on typed `User['role']` input. The TypeScript type system upstream rules out unknown role strings; the helpers do not defensively handle unknown roles (intentional — matches the pre-refactor inline behavior).
  - **Auth flow:** No realtime subscriptions touched. No JWT handling. No session lifecycle change. `deleteProfile`'s server-side authorization (via `delete-user` edge function's `requireAdminCaller()`) is unchanged.
  - **Architect-design deviation re: the transformer** — the spec's "Files changed" §"Architect-design deviation" section explicitly surfaces the transformer as a deviation from the original mock-resolution claim. From a security posture standpoint, the deviation is benign: the transformer is jest-only, in-tree, no new dev-dependency, and the rewrite is to a standard CommonJS pattern. The alternative (refactoring `useStore.ts:795` to use synchronous `require()`) would have been a production-code change — the chosen path correctly keeps production code untouched.

## Summary

Spec 033 is a pure-test spec with one mechanical, byte-for-byte refactor of `UsersSection.tsx`. The new `userPermissions.ts` helper is pure (no React, no Zustand, no I/O), and its boolean expressions are verbatim copies of the prior inline derivations. The new jest transformer is exclusively wired to jest and cannot impact Metro/Vercel/production builds. No new dependencies, no `npm audit` delta, no migration changes, no edge function changes, no auth surface changes, no realtime publication changes, no PII / secret exposure.

The spec strengthens client-side test coverage of UX gates that mirror server-authoritative refusals (`delete-user` edge function + `assert_not_last_of_role` from spec 031). Since the server is the real gate, even a regression in this helper would only affect UX affordances, not access control — consistent with the project's "server is authoritative; client is a UX hint" posture documented in CLAUDE.md.

No findings block the spec.
