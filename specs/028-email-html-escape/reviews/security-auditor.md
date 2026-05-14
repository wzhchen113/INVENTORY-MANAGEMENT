# Security audit for spec 028

## Scope reviewed

- `supabase/functions/send-invite-email/index.ts` (escape helper + 5 template wraps)
- `supabase/functions/send-welcome-email/index.ts` (escape helper + 2 template wraps)
- `src/utils/escapeHtml.ts` (TS mirror)
- `src/utils/escapeHtml.test.ts` (7 jest cases)
- `scripts/smoke-edge-roles.sh` (Arm 5 appended)
- `CLAUDE.md` + `.claude/agents/security-auditor.md` (convention docs)

### Verification: byte-identical helper across the three copies

Ran the spec's `diff` one-liner:

```
diff <(sed -n '/^function escapeHtml/,/^}/p' supabase/functions/send-invite-email/index.ts) \
     <(sed -n '/^function escapeHtml/,/^}/p' supabase/functions/send-welcome-email/index.ts)
```

Output: **empty** (zero diff between the two Deno copies). The TS port at `src/utils/escapeHtml.ts:6-9` differs in the signature line only (`export` keyword) — the function body between the braces is byte-identical to the Deno copies. Load-bearing reviewer check satisfied.

### Verification: escape semantics

The five-replace chain runs in the OWASP-canonical order:

```js
value.replace(/&/g, "&amp;")    // FIRST: & before others
     .replace(/</g, "&lt;")
     .replace(/>/g, "&gt;")
     .replace(/"/g, "&quot;")
     .replace(/'/g, "&#39;");
```

`&` is escaped first, so `<` becoming `&lt;` does NOT then get re-mangled to `&amp;lt;`. This is correct. UTF-8 byte sequences (emoji, accented chars, CJK) pass through unchanged because `String.prototype.replace` operates on code points, not bytes. The `typeof value !== "string"` short-circuit covers `null`, `undefined`, numbers, objects, booleans, symbols, functions — wider than the AC text requires, never throws.

### Verification: every interpolation accounted for

Grepped both files for `${...}` patterns and walked each one:

**`send-invite-email/index.ts`:**

| Location                            | Interpolation              | Disposition       |
|-------------------------------------|----------------------------|-------------------|
| `:26` (createClient `Authorization`) | `${token}`                | HTTP header value, not HTML — bare is correct |
| `:70` (`registerUrl` const)         | `${APP_URL}?register=true` | Server-side string concat used as input to `escapeHtml(registerUrl)` at `:84` — bare here is correct |
| `:77` (Resend `Authorization`)      | `${RESEND_API_KEY}`        | HTTP header value, not HTML — bare is correct |
| `:84` (`html:` body, slot 1)        | `${escapeHtml(name)}`      | Wrapped |
| `:84` (`html:` body, slot 2)        | `${escapeHtml(role)}`      | Wrapped |
| `:84` (`html:` body, slot 3, ternary truthiness) | `${storeNames ? ... : ""}` | JS truthiness check on raw value, not HTML interpolation — bare is correct |
| `:84` (`html:` body, slot 4, nested inside ternary) | `${escapeHtml(storeNames)}` | Wrapped |
| `:84` (`html:` body, slot 5, `href` attribute) | `${escapeHtml(registerUrl)}` | Wrapped |
| `:84` (`html:` body, slot 6)        | `${escapeHtml(expiresText)}` | Wrapped |

All five HTML-context slots are wrapped. The three non-HTML interpolations (HTTP Authorization headers x2, the bare string concat for `registerUrl` that gets escaped downstream) are intentionally bare.

**`send-welcome-email/index.ts`:**

| Location                          | Interpolation              | Disposition       |
|-----------------------------------|----------------------------|-------------------|
| `:24` (createClient `Authorization`) | `${token}`              | HTTP header value, not HTML — bare is correct |
| `:74` (Resend `Authorization`)    | `${RESEND_API_KEY}`        | HTTP header value, not HTML — bare is correct |
| `:81` (`html:` body, slot 1)      | `${escapeHtml(name)}`      | Wrapped |
| `:81` (`html:` body, slot 2, `href` attribute) | `${escapeHtml(APP_URL)}` | Wrapped |

All two HTML-context slots are wrapped. The intentional non-wraps (per spec design):

- `to: [email]` on `send-invite-email:82` and `send-welcome-email:79` — Resend's RFC-5322 address parser is the appropriate escape boundary, not HTML.
- `subject:` on `send-invite-email:83` and `send-welcome-email:80` — static string literals, no interpolation.
- `data: { name, role }` payload to `auth.admin.inviteUserByEmail` on `send-invite-email:97` — Supabase Auth API treats `data` as opaque structured metadata; escaping would corrupt round-trip.
- JSON error path `(e as Error).message` on both files — JSON serialization is the boundary; the response is `Content-Type: application/json` and not rendered as HTML.

Defense-in-depth wraps (`registerUrl`, `expiresText`, `APP_URL`) are server-built constants today but wrapped anyway. Per spec Q4, this is a deliberate uniformity choice — every `${...}` in HTML context gets wrapped so a future maintainer cannot miss "is this slot caller-controlled or not?" by inspection. This is correct security posture.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- **Smoke Arm 5 is response-side only, by design.** `scripts/smoke-edge-roles.sh:269-303` asserts the JSON response body does not contain literal `<script>`. The primary attack surface (the rendered Resend HTML body) is not inspected at runtime because local stacks have no `RESEND_API_KEY` and the function falls through to `auth.admin.inviteUserByEmail()`, which passes `data: { name, role }` to Supabase Auth as opaque metadata — the HTML email body never renders. The unit test (`src/utils/escapeHtml.test.ts`) covers the escape function in isolation, and CT6 is a manual gate that the implementer satisfied by direct rendering rather than docker-logs-grep (spec `:1085-1100`). Net coverage is sufficient given the byte-identical helper triangulates between the jest-tested TS port and the unrunnable Deno copies — but the response-only smoke is a known limitation that future maintainers should understand if they tighten the assertion. Not a fix in this spec; flag for the next time a Resend mock becomes available.

- **`name` field has no max-length enforcement.** `supabase/functions/send-invite-email/index.ts:63-67` validates that `email` and `name` are truthy but accepts arbitrary-length strings. A malicious admin could submit a 10MB `name` payload; `escapeHtml` would happily process it (V8 string ops scale linearly), but the resulting email body could exceed Resend's transport limits or hit the edge runtime's response size cap. Not a fix in this spec — the trigger here is HTML injection, not DoS, and the role gate at `:52-58` restricts the surface to admins. Out of scope per spec out-of-scope #1 / #4 (the broader Mediums list deferred to future specs).

- **Defense-in-depth wrap of `registerUrl` does NOT enforce URL-scheme safety.** If `APP_URL` is ever changed to read from `Deno.env.get()` or accept a query parameter and an attacker injects `javascript:alert(1)`, `escapeHtml` will only encode characters that appear in that scheme — none of `j`, `a`, `v`, etc. are in the five-char set. The `<a href="javascript:alert(1)">` would still execute in many mail clients. This is NOT a regression in spec 028 (the rendered URL is `APP_URL = "https://hopeful-lewin.vercel.app"` — hardcoded `https`). It IS a future-drift trap that the spec's defense-in-depth narrative does NOT close. If a future spec wires `APP_URL` to `Deno.env.get()` or a caller-supplied field, that spec MUST add a URL-scheme allow-list check on top of `escapeHtml`. Flag for the convention docs in a follow-up; spec 028 itself is fine.

### Dependencies

No `package.json` or `package-lock.json` changes (`git diff package.json package-lock.json` produced no output). `npm audit` baseline unchanged — skipped per audit playbook rule "no package.json changes — skipped."

---

## Summary

Spec 028 ships the correct fix for the spec 025 M-finding. The five-character escape is OWASP-canonical, the order is correct (`&` first), the null-safety contract is wider than required, and the byte-identical helper diff is empty. Every HTML-context interpolation in both edge functions is wrapped; the three intentional non-wraps (Resend `to:`, static `subject:`, Supabase Auth `data:` metadata) are documented in the spec and verified by inspection. Arm 5's response-side smoke complements the jest test on the TS port and the manual CT6 gate.

No Critical, High, or Medium findings. Three Lows are noted as future-spec items, not blockers.

This spec is **clear to ship** from the security perspective. Manual `supabase functions deploy send-invite-email` and `supabase functions deploy send-welcome-email` are required post-merge — surface this in the release proposal.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 3 Low.
payload_paths:
  - specs/028-email-html-escape/reviews/security-auditor.md
