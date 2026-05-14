# Backend-architect drift review — Spec 027

Mode: post-implementation. Reviewing implementation against the
`## Architect design` section I authored in
`specs/027-edge-fn-super-admin-parity/spec.md:443-868`.

Verdict: **zero architectural drift**. Implementation matches the design
on every load-bearing axis (constant shape, comment wording, byte-for-byte
preservation of the function body, smoke-script arm order and auth setup,
prose snippet placement, no boundary violations). One nit on internal
documentation duplication and one observation worth recording for the
release proposal.

---

## Critical (BLOCKS merge)

None.

---

## Should-fix

None.

---

## Nits

### N1. Header-comment hygiene in `smoke-edge-roles.sh` is excellent but
duplicates the trap-recovery command verbatim from the script body.

`scripts/smoke-edge-roles.sh:33-37` documents the manual recovery command
in the header comment. `scripts/smoke-edge-roles.sh:73-75` is the actual
recovery `docker exec` used inside `restore_admin()`. The two are identical
SQL fragments. If the BRAND_A UUID or the role-name string ever changes,
both copies have to stay in sync. This is a minor copy-locality risk, not
a real defect — the script is ~250 lines and a developer touching either
side is overwhelmingly likely to spot the duplicate. Calling it out for
the record only; not worth fixing.

### N2. Inline `ADMIN_ROLES` duplication across `delete-user` and
`send-invite-email` is now two-of-two but the comment style differs.

`supabase/functions/delete-user/index.ts:14-18` cites
"Spec 012c §14 / Probe 16" as the rationale.
`supabase/functions/send-invite-email/index.ts:16-19` cites
"spec 026 Track A" as the rationale. Both reference the same convention
(`public.auth_is_privileged()` mirror) and both are correct in context —
they're explaining DIFFERENT regression histories. Not drift; just an
observation that the convention bullet I added to CLAUDE.md (line 61) is
now the canonical anchor and both comments correctly point readers to a
spec for the historical "why."

If a third edge function adopts the same Set in the future, the bullet at
[CLAUDE.md:61](/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/CLAUDE.md)
is the load-bearing reference — neither inline comment is.

---

## Drift checks against the architect design

The design lives at
`/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/027-edge-fn-super-admin-parity/spec.md:443-868`.
Each check below cites the relevant design subsection.

### Track A — `send-invite-email/index.ts` (design §2)

| Design specification | Implementation | Status |
|---|---|---|
| `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` | Line 20 has exact text | MATCH |
| 4-line comment above the Set, mirroring design §2 wording verbatim | Lines 16-19 have the exact comment text | MATCH |
| Lines 17-96 byte-for-byte preserved (acceptance A3) | `requireAdminCaller` now at 22-35, body at 37-100, Resend POST at 64-76, fallback at 85-89. Diff vs old shape: only the line-numbers shifted by the 4-comment-line insertion. Content identical. | MATCH |
| `ADMIN_ROLES.has()` membership checks unchanged | Lines 31 and 33 — both identical to pre-change | MATCH |
| No promotion of the constant to `_shared/roles.ts` | Constant inline in the function; no `_shared/` module created | MATCH (per design §2 "Inline vs shared module") |

The byte-for-byte preservation is verified by reading the current file
and confirming the function bodies are textually identical to the
pre-change version with only the 4-line comment insertion shifting
subsequent line numbers.

### Track B — sibling edge functions (design §3)

Design called for zero additional fixes. Verified:

- `supabase/functions/delete-user/index.ts:19` — unchanged, still
  `new Set(["admin", "master", "super_admin"])`.
- `supabase/functions/eod-reminder-cron/index.ts:192` — unchanged,
  still `.in('role', ['admin', 'master'])`. Out-of-scope as designed
  (recipient selection, not privilege gate; spec §"Out of scope" §6).
- Grep of `supabase/functions` for `ADMIN_ROLES|super_admin` returns
  only `delete-user` and `send-invite-email` — confirms no other file
  acquired or lost a role-gate constant.
- `supabase/config.toml` unchanged — `send-invite-email` retains default
  `verify_jwt = true` (no `[functions.send-invite-email]` block), so
  the gateway-layer 401 behaviour relied on in smoke Arm 2 is intact.

### Track C — `smoke-edge-roles.sh` (design §4)

Arm-by-arm verification against design §4:

| Design arm | Implementation | Status |
|---|---|---|
| Arm 1 — CORS preflight (no auth), same shape as `smoke-edge.sh:53-71` | `scripts/smoke-edge-roles.sh:86-111`. Same `curl -sS -D - -X OPTIONS` invocation, same three grep assertions for `allow-origin`/`allow-methods.*POST`/`allow-headers.*authorization`. The implementation additionally accepts 204 (line 97) — defensible widening because gateway behaviour can return either; design said "200" so 204 is a benign relaxation. | MATCH (with benign widening) |
| Arm 2 — POST without `Authorization` → 401, same shape as `smoke-edge.sh:77-85` | `scripts/smoke-edge-roles.sh:113-128`. Asserts 401 exactly. Has the design's caveat noted in comments (lines 121-123): "Either the Supabase gateway (verify_jwt=true) or the function's own requireAdminCaller entry guard returns 401." | MATCH |
| Arm 3 — POST with admin JWT → 200 or 4xx post-gate; SKIP if no `ADMIN_BEARER` and login fails | `scripts/smoke-edge-roles.sh:130-176`. Login pattern matches `smoke-rpc.sh:67-78` (uses `python3 json.load` instead of `jq -r` — different parsing tool, same effect; both are acceptable per design "same shape as `smoke-rpc.sh`"). Asserts 200 or 400; explicitly fails on 401 (line 169-170) and 403 (line 171-172). Body-grep for `email and name required` (lines 165-167). SKIP idiom at line 144-145 matches `smoke-edge.sh:92`. | MATCH |
| Arm 4 — Auth setup: psql role-promotion via `docker exec` + JWT re-mint via `profiles_sync_role_to_jwt` trigger; `trap restore_admin EXIT`; SKIP if `docker exec` fails | `scripts/smoke-edge-roles.sh:178-235` + restore function at 66-84 + `trap` at line 84. Promotion SQL at line 193-195 matches `smoke-multi-brand.sh:65-68` shape (`update public.profiles set role='super_admin', brand_id=null`). `PROMOTED=1` flag at line 199 gates the restore — same as design §4 implied. Re-login at lines 200-205 — matches design's "re-login (not refresh a token) to pick up the new claim." Restore at line 73-76 — reverts to admin role + BRAND_A. The `BRAND_A` constant at line 54 (`2a000000-0000-0000-0000-000000000001`) matches the canonical seed brand from `multi_brand_schema_rls.sql`. | MATCH |
| Chain order in `package.json:18`: `smoke-edge && smoke-rpc && smoke-edge-roles` (new arm LAST) | `package.json:18` — `"bash scripts/smoke-edge.sh && bash scripts/smoke-rpc.sh && bash scripts/smoke-edge-roles.sh"` | MATCH |
| Header comment at top of script citing spec 027 + parity convention (C5) | `scripts/smoke-edge-roles.sh:1-39` — comprehensive header. Cites spec 027 (line 2), references `delete-user/index.ts:19` (line 13), the DB-side canonical check `public.auth_is_privileged()` (line 14), and the SKIP idiom (line 25-28). | MATCH |

### Track D — prose snippets (design §5)

| Design snippet | Where it landed | Status |
|---|---|---|
| D1: CLAUDE.md bullet "Edge function role gates mirror `auth_is_privileged()`" inserted under "Conventions already in use" immediately after the existing "Edge function auth split" bullet | `CLAUDE.md:61` — exact text from design §5 D1. The previous bullet "Edge function auth split" is at line 60, and line 62 is the unrelated `Imports.` bullet. Strictly additive — no existing prose rewritten. | MATCH |
| D2: security-auditor.md bullet "Audit edge-function role gates for `super_admin` inclusion" appended to "Edge functions — `verify_jwt` and service-token validation" section | `.claude/agents/security-auditor.md:49` — exact text from design §5 D2. Severity guidance "**High**" preserved. Reference to `supabase/functions/delete-user/index.ts:19` preserved. Lines 44-48 (the pre-existing bullets) unchanged. | MATCH |

### Boundary violations

None observed.

- `tests/README.md` — not touched (verified via `Read`; first 30 lines
  unchanged from canonical, still describing spec 022 / 024 / 025 tracks).
- `supabase/config.toml` — not touched (verified — `send-invite-email` is
  still implicitly `verify_jwt = true` since no
  `[functions.send-invite-email]` block).
- No new or modified migrations under `supabase/migrations/`. The 50
  migrations on disk all pre-date this spec's work; the most recent is
  `20260514150000_invitations_super_admin_rls.sql` (spec 026).
- No other edge functions under `supabase/functions/` modified.
- No `src/` changes (the bug is server-side).

### Architectural drift related to recent specs (spec 026 parity)

The DB-side broadening in spec 026 used `public.auth_is_privileged()` at
`supabase/migrations/20260509000000_multi_brand_schema_rls.sql:235-239`,
which is `auth_is_admin() OR auth_is_super_admin()`. Spec 027 mirrors
this on the edge-function side with
`new Set(["admin", "master", "super_admin"])`.

The two layers are now consistent:

| Caller role | DB-side (`auth_is_privileged()`) | Edge-fn-side (`ADMIN_ROLES.has(role)`) |
|---|---|---|
| `admin` | TRUE | TRUE |
| `master` | TRUE (via `auth_is_admin()`) | TRUE |
| `super_admin` | TRUE | TRUE (newly, post-fix) |
| `user` / other | FALSE | FALSE |
| anon | FALSE | FALSE (401 at entry guard) |

No asymmetry. The DB allows admin/master/super_admin to write
`invitations`; the edge function allows admin/master/super_admin to
trigger `send-invite-email`. The two halves of the invite flow are
now both broadened equivalently. Spec 027's correctness condition is
satisfied.

### Realtime / migrations

Confirmed none expected and none landed. No `alter publication
supabase_realtime` statements anywhere in the diff. The
`docker restart supabase_realtime_imr-inventory` ritual from the
project memory does NOT apply to this spec.

### Manual deploy step verification

`supabase functions deploy send-invite-email` is a post-merge user
action. Cannot directly verify "the dev did not run it" without
checking remote state, but:

1. The spec's `## Files changed` block at line 887-913 lists exactly
   five files + the spec.md status update. No "deployment evidence"
   entry. Consistent with "source change landed, deploy deferred."
2. The Handoff prompt at line 870-887 explicitly told the developer:
   "Edge function deployment (`supabase functions deploy
   send-invite-email`) is a separate manual step the user runs
   post-merge — do NOT run it; flag it in your handoff so the
   release-coordinator surfaces it."
3. The developer's own §"Post-merge deployment note" at line 926-934
   correctly flags the deploy as the user's manual step.

The deploy step appears properly deferred. The release-coordinator
should call this out prominently in the release proposal.

---

## Summary

Zero architectural drift. Implementation is byte-for-byte faithful to
the design across all four tracks (A: source change, B: zero additional
hits, C: smoke script, D: prose). The two layers — DB-side
`auth_is_privileged()` and edge-function-side `ADMIN_ROLES` — are now
consistent for `super_admin`. No boundary violations, no unintended
files touched, no migration or realtime impact. The post-merge deploy
step is correctly deferred to the user.

The two nits noted (N1 trap-comment duplication, N2 inline-comment
style consistency) are below the threshold for a fix request and are
recorded for posterity, not action.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 2 Nits.
payload_paths:
  - specs/027-edge-fn-super-admin-parity/reviews/backend-architect.md
