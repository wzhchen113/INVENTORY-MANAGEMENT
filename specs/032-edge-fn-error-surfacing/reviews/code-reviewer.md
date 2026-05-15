## Code review for spec 032

### Critical

None.

### Should-fix

- `src/lib/auth.test.ts:61` — `describe` name is `'callEdgeFunction (via deleteUser)'` but the spec AC (§"Jest test coverage") specifies `describe('callEdgeFunction', () => { ... })` verbatim. The parenthetical clarifies the indirection but deviates from the spec-mandated name. Fix: rename to `describe('callEdgeFunction', ...)` and move the "via deleteUser" explanation to a comment above the `describe` block (the file header already explains this clearly at lines 5-16, so the describe body doesn't need it).

- `src/lib/auth.test.ts:72-109` — The three 2xx test cases (cases 1, 2, 3) assert only `{ error: null }` through `deleteUser`. The spec AC states "Each test asserts both `data` and `error` fields where relevant." Because `callEdgeFunction` is private and `deleteUser` discards `data`, the `data` path on 2xx is never directly asserted. Specifically, a bug that returned `{ data: null, error: null }` instead of `{ data: <body>, error: null }` on a 2xx+JSON response would not be caught by these tests. The test file header (lines 5-16) explains this limitation honestly, but since the spec AC names asserting `data` as a requirement, the test leaves that AC partially unmet. Options: (a) expose `callEdgeFunction` via a `/* @internal */` export guarded by `if (process.env.NODE_ENV === 'test')` to allow direct assertion, or (b) add a tiny exported test-only wrapper in `auth.ts` (single line), or (c) accept the limitation and document it as deferred. The current behavior is functionally correct for the load-bearing surface (`error` path), but the 2xx `data` shape (e.g. the `{ success: true }` body from `delete-user`'s success path) is not pinned by any assertion.

### Nits

- `src/lib/auth.ts:147` — `catch (e: any)` to access `e?.message` is the pattern the architect specified, but the optional-chain on `e?.message` is redundant once you've annotated `e` as `any` (an `any`-typed value can never be `null`/`undefined` in a way that would throw on `.message`). The `?.` defensive chain is harmless but slightly contradicts the `any` annotation. Not a bug; just inconsistent defensive style.

- `src/lib/auth.test.ts:163` — The body string `'upstream nginx 502 error page'` embeds "502" while the mock `status` is `500`. The test is correct (it expects `"HTTP 500"` from the mock's `status` field, not from parsing the body), but a reader skimming the test may notice the mismatch and second-guess whether the assertion is intentional. A comment or a simpler body like `'Internal Server Error'` would remove the ambiguity.

- `src/lib/auth.test.ts:61` — (Out-of-scope) The indirect-access pattern used throughout the test (testing a private helper via one of its callers) creates a tight coupling: any future change to `deleteUser` that adds its own try/catch or remaps the error would silently break the coverage without the test failing. This is a structural note for the test-engineer rather than a code change here.

- `src/lib/auth.ts:153` — `let parsed: any = null` — the `any` is necessary given the uncertain JSON shape returned by edge functions, which matches the architect's rationale at spec §1. The `any` is intentional and consistent with `data: any` in the return type. No action needed; noting for completeness.
