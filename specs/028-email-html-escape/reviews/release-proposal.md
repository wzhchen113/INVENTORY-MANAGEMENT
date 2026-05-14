## Verdict
verdict: SHIP_READY
rationale: All four reviewers report 0 Critical and 0 Should-fix on the code itself; test-engineer confirms 22/22 acceptance criteria PASS and every verification gate (typecheck, jest 24/24, pgTAP 14/14, smoke including new Arm 5) is green; the only Should-fix items are operational (release-coordinator deploy-flag surfacing) and cosmetic (a stale spec-prose file-count line), neither of which blocks ship.

## Findings summary

- **code-reviewer**: 0 Critical, 0 Should-fix, 4 Nits. Nits cover (1) smoke-script header still says "Spec 027" only; (2) `$ESCAPE_EMAIL` is `printf`-interpolated into JSON but safe because `$RANDOM` is integer-only; (3) AC C2(a) groups five character mappings into one `it` block — splitting into five would give finer failure messages; (4) the one-line `escapeHtml` body is intentionally a single line and must not be reformatted (otherwise the byte-identical diff one-liner stops being load-bearing).

- **security-auditor**: 0 Critical, 0 High, 0 Medium, 3 Low (all out-of-scope follow-ups). Verifications passed: byte-identical helper between the two Deno copies (empty diff), OWASP-canonical escape order (`&` first), `String.prototype.replace` operates on code points so UTF-8 / emoji passes through, `typeof value !== "string"` short-circuit is wider than the AC requires. Every `${...}` in HTML context is wrapped in both files; the intentional non-wraps (Resend `to:`, static `subject:`, Supabase Auth `data:` metadata, HTTP `Authorization` headers, server-built constants used as `escapeHtml` inputs downstream) are correct. The three Lows: (L1) Arm 5 is response-side only by design — the rendered Resend HTML body cannot be locally inspected without `RESEND_API_KEY`; (L2) `name` field has no max-length enforcement (DoS surface, admin-gated, future spec); (L3) `escapeHtml` does NOT enforce URL-scheme safety — if a future spec wires `APP_URL` to `Deno.env.get()` or accepts a caller-supplied URL, that spec MUST add a `https://`/`http://` allow-list on top.

- **test-engineer**: 22/22 ACs PASS, 0 FAIL. Independent verification by static inspection: byte-identical Deno↔Deno and Deno↔TS body diffs both empty; `escapeHtml` call count is 5 in `send-invite-email` (name, role, storeNames, registerUrl, expiresText) and 2 in `send-welcome-email` (name, APP_URL); 7 `it` blocks in `escapeHtml.test.ts` matches C2; Arm 5 has SKIP-on-missing-bearer, case-insensitive grep, best-effort cleanup, post-Arm-4 placement. Two informational notes: (a) CT6 was satisfied by direct render rather than docker-logs scraping because the local Resend fallback routes to `auth.admin.inviteUserByEmail` and never writes a rendered HTML body to runtime logs — equivalent proof, accepted; (b) the inline-comment cross-reference says "spec 028 §3" rather than the AC's literal "spec 027 §4.2" wording, but matches the architect's canonical source block — equivalent rationale, not a block.

- **backend-architect (post-impl drift)**: 0 Critical, 2 Should-fix (S1 operational deploy-flag, S2 cosmetic stale spec-prose), 9 Nits (all positive confirmations of design adherence). No structural drift — helper bytes match design where bytes were pinned, placement matches where placement was pinned, the load-bearing non-mechanical swap (Track A row 3's outer `${storeNames ? ... : ""}` truthiness left bare while inner `${escapeHtml(storeNames)}` is wrapped) landed exactly as specified. Boundary check confirms no out-of-scope edits: no migrations, no `src/lib/db.ts`, no `src/store/useStore.ts`, no `app.json`, no `package.json`, no Cmd UI changes. The unrelated `src/lib/db.ts`, `src/store/useStore.ts`, and Cmd UI changes visible in `git status` belong to spec 016, not 028.

---

## REQUIRED POST-MERGE STEP — DEPLOY BOTH EDGE FUNCTIONS

**Both functions had source changes in this PR. Neither change takes effect on the live edge runtime until that function is redeployed.** The fix only covers half the surface if either deploy is skipped.

```
supabase functions deploy send-invite-email
supabase functions deploy send-welcome-email
```

- `send-invite-email` is the invite-admin path (4 caller-controlled slots wrapped).
- `send-welcome-email` is the post-registration welcome path (2 slots wrapped). Less visible than the invite flow but is also part of the user-onboarding surface.
- If spec 027 has already shipped, the `send-invite-email` redeploy here is the second redeploy of the function inside the spec 027/028 window — not a no-op.
- If spec 027 has NOT yet shipped at merge time, this `send-invite-email` deploy carries both fixes (027's `ADMIN_ROLES` parity + 028's `escapeHtml` swaps).

---

## Recommended next steps (ordered)

1. **Commit and deploy.** The user runs the commit and then runs **both** `supabase functions deploy` commands listed above. The two-deploy requirement is the single most important release-time action — surface it before anything else.

2. **(Optional, fast-follow nit cleanup — non-blocking.)** Fix the stale "Expected file count: 5-7 files" line in `specs/028-email-html-escape/spec.md:562-564`. Actual landed count is 7 (or 8 including the spec file itself). Pure documentation correction; can be folded into the next spec's housekeeping.

3. **(Optional, fast-follow nit cleanup — non-blocking.)** Update the header comment of `scripts/smoke-edge-roles.sh:1-6` to say "Spec 027 + 028 smoke for the send-invite-email role gate and HTML-escape behavior." The Arm 5 block at line 255 is self-documenting, but the file-level one-liner is now out of date. Cosmetic.

4. **(Optional, fast-follow test refinement — non-blocking.)** In `src/utils/escapeHtml.test.ts:27-33`, split the AC C2(a) `it` block (currently five `expect` calls grouped under one case) into five separate `it` blocks, one per character. Jest stops at the first failing `expect` inside an `it`, so splitting gives finer-grained failure attribution. All five characters are still exercised by the attack-payload cases (C2(b)/(c)), so this is purely diagnostic ergonomics.

## Out of scope for this review

These were flagged by reviewers but are explicit out-of-scope items for spec 028 — they belong in separate future specs, not in this PR:

- **`javascript:` URL-scheme defense (security-auditor L3).** `escapeHtml` does not enforce URL-scheme safety. If a future spec wires `APP_URL` (or any `href` value) to `Deno.env.get()` or a caller-supplied field, that spec MUST add an `https://`/`http://` allow-list check on top of `escapeHtml`. Today `APP_URL` is hardcoded to `https://hopeful-lewin.vercel.app`, so this is a future-drift trap, not a current vulnerability. Suggest filing a follow-up spec to document the URL-scheme convention in `CLAUDE.md` and `.claude/agents/security-auditor.md`.

- **`name` max-length DoS cap (security-auditor L2).** `send-invite-email/index.ts:63-67` validates that `email` and `name` are truthy but accepts arbitrary-length strings. The trigger for spec 028 is HTML injection, not DoS, and the role gate restricts the surface to admins. Belongs to a future hardening spec (matches spec 025 M4 deferred list).

- **Resend-mock smoke for the rendered HTML body (security-auditor L1 / test-engineer note).** Arm 5 checks the JSON response body only; the rendered Resend HTML body cannot be locally inspected without a `RESEND_API_KEY`. When a Resend mock or staging key becomes available, a future spec could tighten Arm 5 (or add Arm 6) to scrape the rendered body. The current coverage (jest test on the TS port + manual CT6 + response-body smoke) is sufficient for this spec.

- **Spec chain context (informational, no action).** Three specs have now landed end-to-end:
  - **026** — DB RLS for `invitations` broadened to `super_admin`.
  - **027** — Edge function role gate broadened to `super_admin`.
  - **028** — Email body HTML escape (closes the spec 025 M4 finding).
  Together these close the `super_admin` invite end-to-end gap **and** the XSS-into-mail-client vector. Worth noting in the PR description / release notes for traceability.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 0 blocking items. Post-merge requires TWO deploys: `supabase functions deploy send-invite-email` AND `supabase functions deploy send-welcome-email`.
payload_paths:
  - specs/028-email-html-escape/reviews/release-proposal.md
