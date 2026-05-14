## Test report for spec 028

### Acceptance criteria status

**Track A — Fix `send-invite-email/index.ts`**

- A1: `escapeHtml(value: unknown): string` helper defined inline at module scope, escaping all five chars (`&<>"'`), coercing non-string to `""`, passing UTF-8 unchanged → PASS — `supabase/functions/send-invite-email/index.ts:42-45`
- A2: All four caller-controlled interpolations wrapped (`name`, `role`, `storeNames` in conditional, `registerUrl`, `expiresText`) → PASS — `supabase/functions/send-invite-email/index.ts:84`; `to:[email]` and `subject` correctly NOT wrapped
- A3: No other change to the file — `ADMIN_ROLES`, `requireAdminCaller`, CORS headers, error JSON shape, HTTP status codes all preserved → PASS
- A4: 3-line comment above `escapeHtml` present: (a) threat stated ("HTML-escape caller-controlled interpolations"), (b) spec number "Spec 028" cited, (c) inline-not-shared rationale present → PASS — `supabase/functions/send-invite-email/index.ts:37-41`
  - Minor nit: AC A4 says cross-reference "spec 027 §4.2" by name; actual comment says "spec 028 §3". The architect's canonical source block in the design doc uses "spec 028 §3", so the developer followed the design. Rationale is equivalent. Not a block.

**Track B — Fix `send-welcome-email/index.ts`**

- B1: Byte-identical `escapeHtml` helper with identical 5-char semantics and null coercion, same 3-line comment block → PASS — `supabase/functions/send-welcome-email/index.ts:37-45`; `diff` one-liner returns empty output (confirmed)
- B2: `${escapeHtml(name)}` and `${escapeHtml(APP_URL)}` wrapped; `to:[email]` and `subject` correctly NOT wrapped → PASS — `supabase/functions/send-welcome-email/index.ts:81`
- B3: `verifyFreshRegistration` function body preserved; CORS headers, error JSON shape, and HTTP status codes unchanged → PASS

**Track C — Unit test for the escape helper**

- C1: New jest test at `src/utils/escapeHtml.test.ts` exercising the TS port at `src/utils/escapeHtml.ts`; function body byte-identical to both Deno copies (confirmed by body diff returning empty); test runs under the `unit` project (`testEnvironment: 'node'` via `testMatch: src/utils/**/*.test.ts`) → PASS
- C2 (seven cases):
  - (a) Each of `&`, `<`, `>`, `"`, `'` individually → PASS — `src/utils/escapeHtml.test.ts:28-32`
  - (b) `<script>alert(1)</script>` attack payload → PASS — line 36-38
  - (c) Attribute-context payload `" onerror="alert(1)` → PASS — line 45-47
  - (d) Plain ASCII `Alice` passthrough → PASS — line 51
  - (e) `Café 🍰` UTF-8 / emoji passthrough → PASS — line 57
  - (f) `null`, `undefined`, `42`, `{}` coerce to `""` → PASS — lines 61-64
  - (g) `&amp;` double-escapes to `&amp;amp;` (intentional blind-escape contract) → PASS — line 71
- C3: No mocks, no `src/lib/db.ts` boundary, runs under `unit` jest project (`testEnvironment: node`) → PASS

**Track D — Smoke test for the response path**

- D1: New Arm 5 appended to `scripts/smoke-edge-roles.sh` after Arm 4 (line 269); asserts response body does NOT contain unescaped `<script>` markup → PASS
- D2: Arm 5 SKIPs when `$ADMIN_BEARER` is empty (`if [[ -z "${ADMIN_BEARER}" ]]; then skip ...`) — same SKIP idiom as Arms 3 and 4 → PASS — `scripts/smoke-edge-roles.sh:270-271`
- D3: Payload uses `name="<script>x</script>"`; asserts HTTP 200 or 4xx AND body does NOT contain literal `<script>` (case-insensitive, `grep -qi`); best-effort cleanup deletes `escape-test-${RANDOM}@local.test` from `auth.users` via `docker exec ... psql ...` → PASS — lines 274-303
- D4: Arm 5 is placed after Arm 4's super_admin block (Arm 4 ends line 252; Arm 5 begins line 269); does not run a promote/restore dance; reuses `$ADMIN_BEARER` from Arm 3 → PASS

**Track E — Document the convention**

- E1: New bullet appended to CLAUDE.md under "Conventions already in use" immediately after the spec-027 "Edge function role gates mirror `auth_is_privileged()`" bullet (line 62) → PASS — `CLAUDE.md:62`
- E2: New bullet appended to `.claude/agents/security-auditor.md` under "Edge functions" section after the spec-027 super_admin bullet (line 50) → PASS — `.claude/agents/security-auditor.md:50`
- E3: Both edits are strictly additive; no existing paragraph rewritten → PASS

**Cross-track verification gates**

- CT1: `npx tsc --noEmit` exit 0 → PASS (reported by developer)
- CT2: `npm run typecheck:test` exit 0 → PASS (reported by developer)
- CT3: `npm test -- --ci` 24/24 PASS (7 new tests in `escapeHtml.test.ts`) → PASS (reported by developer)
- CT4: `npm run test:db` 14/14 PASS → PASS (reported by developer)
- CT5: `npm run test:smoke` all PASS including new Arm 5 → PASS (reported by developer)
- CT6: Manual gate — PARTIAL. Developer ran the inline `escapeHtml` helper directly against the template literal with `name='<script>x</script>'` and confirmed output contained `&lt;script&gt;x&lt;/script&gt;`. However, the spec prescribed verification via `docker logs supabase_edge_runtime_imr-inventory` log scraping, not a direct render test. The developer's note explains: the local Resend fallback routes to `auth.admin.inviteUserByEmail` (no email sent, no HTML body in runtime logs), so the docker-log path was not available without a live Resend key. The direct render test is equivalent proof of escape correctness; the smoke arm (Arm 5) confirms the function's response path does not echo unescaped markup. **The deviation from the spec's prescribed verification method is acceptable** given the architectural reason (no Resend key locally). The underlying escape behavior is verified by unit test (C2) and manual direct render.

---

### Test run

Tests were reported by the developer as part of the `READY_FOR_REVIEW` submission. Independent verification of assertions performed by static inspection and bash analysis:

- Byte-identical diff between two Deno `escapeHtml` function bodies: **empty (MATCH)**
- Byte-identical diff between Deno and TS port function bodies: **empty (MATCH)**
- `escapeHtml` call count in `send-invite-email/index.ts`: 5 (name, role, storeNames, registerUrl, expiresText) — all correct
- `escapeHtml` call count in `send-welcome-email/index.ts`: 2 (name, APP_URL) — all correct
- `to: [email]` in both files: NOT wrapped — correct
- `data: { name, role }` Supabase Auth fallback in `send-invite-email`: NOT wrapped — correct (opaque metadata, not HTML)
- Test file has exactly 7 `it(...)` blocks — matches C2 spec
- Arm 5 in smoke script: SKIP-on-missing-bearer present, grep is case-insensitive (`-qi`), cleanup is best-effort (`|| true`), placement is post-Arm-4

Developer-reported test run: 24 PASS, 0 FAIL, 0 NOT TESTED (jest); 14/14 PASS (pgTAP); all PASS (smoke).

---

### Notes

**Smoke Arm 5 assertion posture (should-fix, minor).**
Arm 5 checks that the **response JSON body** does not echo `<script>`. It does NOT (and cannot, locally without a Resend key) check the **rendered HTML email body** that Resend would send. This is explicitly acknowledged in the spec's Track D smoke limitations block and the CT6 manual gate. The test-engineer considers this acceptable per spec design: the unit test at Track C provides direct behavioral proof; the smoke provides a defense-in-depth response-reflection check. No block.

**Arm 5 does not use `jq` for JSON parsing.**
The spec and design do not require `jq` for Arm 5 — the arm just checks for the substring `<script>` in the raw response body, which is a grep operation, not structured JSON parsing. Arms 3 and 4 also use grep rather than jq for their body assertions. Not a gap.

**CT6 verification method deviation (informational, not a block).**
The spec's CT6 gate prescribed docker-log inspection (`docker logs supabase_edge_runtime_imr-inventory`). The developer satisfied it with a direct render test instead, citing that the Resend fallback path (no `RESEND_API_KEY`) routes to `auth.admin.inviteUserByEmail` and never writes a rendered HTML body to the edge runtime logs. The direct render test is functionally equivalent proof of escape correctness and is accepted.

**A4 comment cross-reference wording (nit).**
AC A4 says to cross-reference "spec 027 §4.2 design rationale". The actual comment says "spec 028 §3". The architect's canonical source block in the spec itself uses "spec 028 §3", so the developer followed the design. The rationale conveyed is equivalent. Not a block.

**Double-escape contract (informational).**
AC C2(g) and the test at line 71 both confirm that `&amp;` → `&amp;amp;` (blind, single-pass escape). The task prompt's "single-pass guarantee" is that `&` alone → `&amp;` (not `&amp;amp;`), which is covered by case (a) at line 28. Both contracts are verified.

**Deploy gate — two functions.**
`supabase functions deploy send-invite-email` AND `supabase functions deploy send-welcome-email` must both be run post-merge. This is flagged here for the release-coordinator: two separate deploy invocations are required, not one. If spec 027 has not yet shipped, the `send-invite-email` deploy carries both fixes.
