# Backend-architect post-impl drift review — Spec 047

Mode: post-implementation drift review.
Scope: `.github/workflows/test.yml` against the design in
[specs/047-ci-node24-action-runtime.md](../../047-ci-node24-action-runtime.md)
`## Backend design` section.

## Summary

No drift. The implementation matches the design exactly on placement,
naming, value, and scope. The design's "no DB / no RLS / no API contract
/ no edge function / no realtime / no useStore / no db.ts" assertions
all still hold — confirmed by inspection of the diff surface (single
file under `.github/workflows/`).

0 Critical · 0 Should-fix · 0 Minor.

## Per-axis findings

### Placement (workflow-scope vs per-job, between `permissions:` and `jobs:`)

PASS. The `env:` block sits at workflow scope on lines 46-47 of
`.github/workflows/test.yml`, between the existing `permissions:`
block (lines 36-37) and the `jobs:` key (line 49). This is exactly
where the design specified ("between the existing top-level
`permissions:` block (line 36-37) and the `jobs:` key (line 39)" —
spec line 102). The intervening comment block on lines 39-45 shifted
the `jobs:` line number from 39 to 49, which is the natural
consequence of inserting the comment + env block above it and is not
drift.

The choice of workflow-level over per-job also matches the design's
Q1 resolution (spec lines 122-137).

### Naming and value

PASS. The variable name and value match the design verbatim:

- Design (spec line 106): `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`
- Implementation (test.yml:47): `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`

YAML-encoded `true` (bareword) renders as the string `"true"` in the
environment exported to the runner, which is what GitHub's runner
checks (case-insensitive string comparison against `"true"`). Quoted
`"true"` would also work; the bareword choice here is conventional
and fine.

### Comment clarity vs design intent

PASS. The inline comment on lines 39-45 covers all three design
intentions:

1. Names the three JS-based actions in scope (`actions/checkout@v4`,
   `actions/setup-node@v4`, `supabase/setup-cli@v1`) — captures the
   Q2 parity-check decision from spec lines 139-158 without
   re-litigating it.
2. Identifies the upcoming GitHub deadline (~June 2, 2026) — matches
   spec context line 13 and spec line 8.
3. Explicitly disambiguates the action runtime Node from the project
   Node (`node-version: '20'`), echoing the AC bullet 5 contract
   from spec lines 32-33 and the design rationale on spec lines
   115-118.

The comment also points at "spec 047" as the audit trail, which is
the convention used elsewhere in the file (lines 1-3 cite specs 022,
024, 025; line 35 cites "security-auditor M1"; line 55 cites
"code-reviewer S2 + test-engineer"). Consistent with file norms.

### Design's N/A assertions

PASS — all confirmed:

- **No DB.** No migration under `supabase/migrations/`. Verified the
  spec's "Migration filename: none" assertion (spec line 97).
- **No RLS.** No policy changes — the change is in
  `.github/workflows/`, which does not touch SQL. Verified spec line
  89.
- **No API contract.** No PostgREST/RPC change. No additions to
  `src/lib/db.ts`. Verified spec line 90 and line 93.
- **No edge function.** No file under `supabase/functions/` touched;
  `supabase/config.toml` `verify_jwt` settings unchanged. Verified
  spec line 91.
- **No realtime impact.** No publication membership change. Confirms
  spec line 94-95 — and importantly means **no**
  `docker restart supabase_realtime_imr-inventory` step is needed on
  dev machines after pulling this commit. The realtime gotcha
  (CLAUDE.md memory entry) is not engaged by this spec.
- **No `src/store/useStore.ts` impact.** Verified spec line 96.

### AC coverage from diff-alone perspective

- AC bullet 1 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` applies to
  all four jobs): PASS via workflow-scope env propagation.
- AC bullet 2 (no other workflow files need treatment):
  PASS — `.github/workflows/` contains only `test.yml`.
- AC bullet 5 (`node-version: '20'` unchanged): PASS — lines 63, 84,
  106 (which correspond to the old 53, 74, 96 references in the spec,
  shifted by the 10-line insertion above) still read `node-version:
  '20'`.

AC bullets 3 and 4 verify only on the next CI push — that's the
post-merge verification posture flagged in the design's Verification
plan (spec lines 210-219). Diff-time review cannot bind on those;
that's by design, not drift.

## Conclusion

The implementation is faithful to the design. No drift, no Criticals,
no Should-fix, no Minor findings. Safe to ship pending the AC-3/AC-4
post-merge confirmation on the next push to `main`.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings by severity.
payload_paths:
  - specs/047-ci-node24-action-runtime/reviews/backend-architect.md
