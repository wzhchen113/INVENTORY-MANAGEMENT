# Backend-architect post-impl drift review — spec 028

Spec: `specs/028-email-html-escape/spec.md`
Status on entry: `READY_FOR_REVIEW`
Mode: post-implementation drift review (not design mode; `Status:` left
untouched per agent contract).

Reviewed against the `## Architect design` section the architect authored
in the spec (lines 609-998).

## Summary verdict

**No drift.** Implementation matches the design byte-for-byte where the
design pinned bytes; matches placement-for-placement where the design
pinned structural position; matches intent-for-intent on the
non-wrapped surfaces (the four "do NOT wrap" call-outs all stand). One
**Should-fix** flagged on the spec's own self-reported file count
(rounding error, not a structural defect) and one **Should-fix** /
**operational** call-out on the two-deploy post-merge step — both
informational, neither blocks ship.

---

## Critical (BLOCKS merge)

None.

---

## Should-fix

### S1. Two-deploy post-merge step needs release-coordinator surfacing

Not a code defect — a release-step concern the review prompt asked me to
flag. The spec is explicit (out-of-scope #12 and the architect's
"Cross-cutting" note at lines 921-932): edge-function deployment is the
user's manual post-merge step. **Two** functions need to redeploy:

    supabase functions deploy send-invite-email
    supabase functions deploy send-welcome-email

Both functions had source-level changes in this PR (the inline
`escapeHtml` helper + the interpolation swaps inside the `html:`
template literal). Neither change takes effect on the live edge
runtime until that function is redeployed.

Two implications for `release-coordinator`:

1. The release proposal MUST list **both** deploy commands. A
   reviewer who reads only the file-changed list might miss that
   `send-welcome-email` also needs to redeploy (it's less visible
   than the invite flow but is also part of the user-onboarding
   surface).
2. If spec 027 has not yet shipped at merge time, the
   `send-invite-email` deploy carries both fixes (spec 027's
   `ADMIN_ROLES` parity + spec 028's `escapeHtml` swaps). If 027
   shipped separately, this PR's `send-invite-email` deploy is the
   second redeploy of the function within the spec 027/028 window
   — note that to avoid the user thinking the second deploy is a
   no-op.

Severity rationale: not Critical because the source change is correct
on disk; the operational step is well-documented in the spec and
the dev handoff. But the design-doc author explicitly asked me to
flag this, and the release-coordinator reads reviewer files, so this
finding routes the deploy-flag forward.

### S2. Spec's "Expected file count" is now stale

`specs/028-email-html-escape/spec.md:562-564` says "Expected file
count: 5-7 files (5 if architect appends to `smoke-edge-roles.sh`; 7
if architect ships a new sibling script + package.json update + the
doc files)."

Actual landed file count = **7**: the two edge functions, the new TS
mirror + its jest test, the smoke script edit, the two doc files
(`CLAUDE.md` + `.claude/agents/security-auditor.md`). The dev's
"Files changed" tally also lists the spec file itself (Status flip),
which makes the visible count **8** including the spec.

The architect picked Option A for Q3 (append to existing smoke
script) which the spec said should yield 5 files, but the actual
output landed at 7 because the spec's "5 files" rounding-down didn't
count `CLAUDE.md` + `.claude/agents/security-auditor.md` (Track E)
nor `src/utils/escapeHtml.test.ts` (Track C2). This is a spec-text
miscount, not an implementation drift. No action required; flagged
so the post-spec audit trail is accurate.

Severity rationale: documentation accuracy, not security or
correctness. Does not block ship.

---

## Nits

### N1. Track A swap #3's outer truthiness is correctly preserved

`supabase/functions/send-invite-email/index.ts:84` contains the
load-bearing subtle swap from the design's Track A table row 3:

> `${storeNames ? ` with access to <strong>${escapeHtml(storeNames)}</strong>` : ""}`

Verified: the **outer** `${storeNames ? ... : ""}` ternary condition is
bare (a JS truthiness check on the raw value, correct), and the
**inner** `${escapeHtml(storeNames)}` inside the nested template
literal is wrapped (the HTML interpolation, correct). This is the one
non-mechanical swap and it landed exactly as the design specified.
Flagging as a nit only because it's the most likely place a future
maintainer would mis-edit; the current state is right.

### N2. Helper body is byte-identical between the two Deno files

Ran a structural equivalence check via grep on the canonical block
(lines 42-45 in both files). The five-character escape chain, the
order (`&` first, then `<`, `>`, `"`, `'`), the `typeof value !==
"string"` short-circuit, and the closing brace match character-for-
character between:

- `supabase/functions/send-invite-email/index.ts:42-45`
- `supabase/functions/send-welcome-email/index.ts:42-45`

The TS port at `src/utils/escapeHtml.ts:6-9` has the matching body
between the curly braces; only the signature line differs (the
`export` keyword and the `function escapeHtml(value: unknown): string`
shape — both expected, called out in design Q1 paragraph 2).

The design's reviewer one-liner `diff <(sed -n '/^function
escapeHtml/,/^}/p' ...) <(sed -n ... )` would return an empty diff if
run. (I verified by grepping the body bytes; the result of a literal
`diff` would be empty.)

### N3. Helper insertion point matches design placement

The design (lines 709-712 for Track A, lines 745-747 for Track B)
specified module scope, between the gate function's close brace
and `Deno.serve` opener. Verified:

- `send-invite-email/index.ts`: helper at lines 42-45, between
  `requireAdminCaller`'s close brace at line 35 and `Deno.serve` at
  line 47. Lines 36-41 are the 5-line docblock. **Match.**
- `send-welcome-email/index.ts`: helper at lines 42-45, between
  `verifyFreshRegistration`'s close brace at line 35 and `Deno.serve`
  at line 47. Same 5-line docblock at 36-41. **Match.**

### N4. The four intentional non-wraps are correctly preserved

All four "do NOT wrap" surfaces the design called out and the review
prompt re-validated are correctly left bare:

- `to: [email]` on `send-invite-email/index.ts:82` — RFC-5322 address
  field, not HTML. **Correctly unwrapped.**
- `to: [email]` on `send-welcome-email/index.ts:79` — same. **Correctly
  unwrapped.**
- `subject:` on `send-invite-email/index.ts:83` and `send-welcome-email/index.ts:80` —
  both static string literals with no interpolation; the welcome
  subject uses `—` (em-dash) which is a string-literal Unicode
  escape, not a template interpolation. **Correctly unwrapped.**
- `data: { name, role }` payload to
  `supabase.auth.admin.inviteUserByEmail` on
  `send-invite-email/index.ts:97` — structured metadata round-trips
  through Supabase Auth opaquely; escaping it would corrupt the
  payload. **Correctly unwrapped** (design Track A note at lines
  739-741 explicitly carved this out).

### N5. Track D smoke arm placement matches design

`scripts/smoke-edge-roles.sh:269-304` is Arm 5, placed after Arm 4's
super_admin block at line 252 and before the summary block at line
306. The design at lines 800-806 specified "after Arm 4's super_admin
block (between lines 252 and 254)" — the actual landing point shifted
to lines 269-304 because the dev included a multi-line ASCII-banner
docblock at 254-268. The banner is purely documentation; the
structural placement (after Arm 4, before the `printf '\n'` summary
trailer) is correct.

The arm reuses `$ADMIN_BEARER` from Arm 3 per design D2. SKIPs on
missing bearer (design D2). The cleanup `delete from auth.users`
docker exec is best-effort (`>/dev/null 2>&1 || true`), correct.
The trap from Arm 4 is unaffected because Arm 5 does not
promote/demote (design D4).

### N6. Track E doc bullets are strictly additive

- `CLAUDE.md:62` — the new bullet was inserted immediately after the
  spec-027 "Edge function role gates mirror `auth_is_privileged()`"
  bullet (line 61), exactly per design E1. The bullet preceding it
  (line 61) and the bullet following it (line 63, the Imports bullet)
  are unchanged. **Strictly additive.**
- `.claude/agents/security-auditor.md:50` — the new bullet was
  inserted under the "Edge functions — `verify_jwt` and service-token
  validation" section, after the spec-027 super_admin audit bullet
  (line 49). The bullet preceding it (line 49) and the section
  following it ("Secrets" at line 52) are unchanged. **Strictly
  additive.**

### N7. No boundary violations

Verified the dev did not touch any out-of-scope surface:

- No `supabase/migrations/` changes (spec out-of-scope #7). git
  status confirms.
- No `src/lib/db.ts` changes (design "Cross-cutting" note). git
  status confirms — `src/lib/db.ts` modifications shown in git status
  belong to spec 016, not 028.
- No `src/store/useStore.ts` changes (design "Cross-cutting" note).
  The `src/store/useStore.ts` modification in git status belongs to
  spec 016.
- No `tests/README.md` changes (would have been out-of-scope cleanup).
  Not touched.
- No Cmd UI section changes. The Cmd UI files in git status
  (`ReportsSection.tsx`, `NewReportModal.tsx`, etc.) belong to spec
  016, not 028.
- No `app.json` changes (CLAUDE.md "DO NOT AUTO-FIX"). Not touched.
- No `package.json` changes (design said "No `package.json` edit
  needed" at line 867 because `test:smoke` already chains
  `smoke-edge-roles.sh`). Not touched.

### N8. The src/utils/escapeHtml.ts TS port lives but is unused at runtime

Per design Track C and spec out-of-scope #8, the new
`src/utils/escapeHtml.ts` is NOT imported by any client code. It
exists exclusively as the jest-testable mirror. Confirmed by absence
of `import.*escapeHtml.*utils` matches outside the test file itself.
This is correct per the design's intent.

### N9. Realtime / publication untouched

The spec is server-side only and explicitly does not change
`supabase_realtime` publication membership (spec Q6 and design
"Cross-cutting" line 920-921). No `docker restart
supabase_realtime_imr-inventory` step is needed for this spec. Flagged
only because the standard architect-design checklist includes this
gotcha; this spec is a clean N/A on it.

---

## Files reviewed

- `specs/028-email-html-escape/spec.md` (the architect's design at
  lines 609-998)
- `supabase/functions/send-invite-email/index.ts` (Track A landing)
- `supabase/functions/send-welcome-email/index.ts` (Track B landing)
- `src/utils/escapeHtml.ts` (Track C TS port)
- `src/utils/escapeHtml.test.ts` (Track C jest cases)
- `scripts/smoke-edge-roles.sh` (Track D Arm 5)
- `CLAUDE.md` lines 60-63 (Track E1 bullet placement)
- `.claude/agents/security-auditor.md` lines 44-51 (Track E2 bullet
  placement)
- git status for boundary-violation negative-space check

## Findings count

- Critical: 0
- Should-fix: 2 (both informational/operational, neither blocks ship)
- Nits: 9 (all positive confirmations of design adherence)

No structural drift. Spec is shippable subject to the standard
release-coordinator synthesis and the manual two-deploy step.
