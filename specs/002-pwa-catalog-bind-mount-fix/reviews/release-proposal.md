# Release proposal — Spec 002 (pwa-catalog bind-mount fix)

_Note: this file was written by main Claude on the release-coordinator's behalf — the agent has no `Write` tool grant per its definition (`Tools: Read, Grep, Glob`), so it returned the proposal as a chat message instead. Content below is the agent's verbatim output. Workflow follow-up: either grant `release-coordinator` `Write`, or update CLAUDE.md to specify chat-only output for proposals._

---

## Verdict
verdict: SHIP_READY
rationale: Zero Critical findings across both reviewers; all 6 acceptance criteria PASS with live verification; the 5 Should-fix items are documentation-quality polish on a doc-only deliverable, not blockers.

## Findings summary
- **code-reviewer** (`specs/002-pwa-catalog-bind-mount-fix/reviews/code-reviewer.md`): 0 Critical / 3 Should-fix / 6 Nits. Top issues:
  1. Verification-evidence `->` arrow line (spec:396-397) is ambiguous — both halves are the same path under different macOS naming conventions, but the format mimics the source-→-destination convention used elsewhere in the same spec. Risk of misreading.
  2. Build notes Q2 conflates "best guess on origin" with diagnostic fact (spec:373-379) — the `[edge_runtime.secrets]` follow-up is framed as addressing a confirmed conclusion when it's actually addressing an assumption.
  3. Open `[edge_runtime.secrets]` follow-up (spec:379) lacks an owner and a decision trigger ("If any future spec requires…") so it reads as advisory noise rather than actionable policy.
- **test-engineer** (`specs/002-pwa-catalog-bind-mount-fix/reviews/test-engineer.md`): 0 Critical / 2 Should-fix / 3 Nits. **All 6 ACs PASS** — verified live against the running stack (mount source confirmed, HTTP 200 returned, jq subset filters return `[]`, Spec 001 AC7b checkbox confirmed flipped, CLAUDE.md note confirmed in place at lines 232-248). Top issues:
  1. Section 3 verification protocol doesn't explain the `PWA_SERVICE_TOKEN` sourcing flow for a fresh checkout — a developer following Section 3 alone hits a 500 without tracing to Build notes Q2 first.
  2. Spec 001 AC7b retro-verification text (`specs/001-repoint-burger-patty-prep-refs.md:31`) requires tribal knowledge — reader must trace to Spec 002 Build notes to find the migration-replay `docker exec` prerequisite. Test-engineer reclassified this from code-reviewer's Nit to Should-fix because it materially affects independent reproducibility.
- **security-auditor**: deliberately omitted — no auth/RLS/input-validation/secret-handling/data-exposure surface in this spec. The spec is doc edits + Docker container reboot; no DB schema, no RPC, no edge-function source changes. Documented in dispatch handoff; auditable.
- **backend-architect (post-impl drift)**: deliberately omitted — no source-tree code surface to drift against the architect's design. Same justification.

## Recommended next steps (ordered)

1. **Commit and ship.** All 6 ACs verified live; the spec body, CLAUDE.md policy note, and Spec 001 AC7b retroactive-verification edit all check out.

2. **Optional follow-up polish before commit (worth folding in, ~10 minutes total).** Both reviewers independently flagged the same two readability issues; addressing them costs little and improves agent-reproducibility:

   - **Fold in (high impact, low cost):** Add a one-sentence pointer in Spec 002 Section 3's verification protocol explaining where `PWA_SERVICE_TOKEN` comes from on a fresh checkout (cite the `.env.local.example` → `.env.local` + `functions serve` once flow from Build notes Q2). This is test-engineer's Should-fix #1 — the only finding that affects whether a fresh developer can reproduce the verification at all.

   - **Fold in (medium impact, low cost):** Add a parenthetical to `specs/001-repoint-burger-patty-prep-refs.md:31` citing the Path B-revised migration replay prerequisite (the `docker exec ... psql < ...20260504235959_repoint_burger_patty_orphans.sql` line). Both reviewers flagged this; test-engineer escalated to Should-fix because spec 001 line 31 is now the canonical AC7b record and a third party can't reproduce it from spec 001 alone.

3. **Punt to follow-up (do not block this commit).** These are spec-quality nits, not reproducibility blockers:

   - Code-reviewer Should-fix #2-3: the "best guess" framing in Q2 and the un-owned `[edge_runtime.secrets]` follow-up. These are honest about uncertainty and would be improved by a one-line owner/trigger sentence, but the spec is shippable as-is.
   - All 6 Nits across both reviewers (arrow-line layout consistency, primary-vs-fallback `docker inspect` form ordering, CLAUDE.md command line-wrapping, CLI-version-upgrade documentation, studio-mount functional-impact note, smoke-edge.sh promotion). Cosmetic; can be a single editorial pass later if desired.

4. **Suggested agent for fold-ins (if user accepts step 2):** `backend-developer` for the spec-text edits — same agent that produced the Build notes, holds full context, mutates Status appropriately. No re-review needed for two parenthetical additions on a doc-only spec.

## Out of scope for this review
- **`scripts/smoke-edge.sh` promotion of the `pwa-catalog` jq regression guard.** Test-engineer Note #3 evaluates this and explicitly recommends deferral — adding `pwa-catalog` coverage requires resolving `store_id` and `PWA_SERVICE_TOKEN` plumbing the existing `fetch-breadbot-sales`-only script doesn't have. File as a separate spec if ongoing regression protection is wanted.
- **`[edge_runtime.secrets]` config.toml investigation.** Build notes Q2 flags this as out of scope; code-reviewer Should-fix #3 wants it owned. Either way, it's a separate spec to evaluate whether `supabase start` should auto-inject `PWA_SERVICE_TOKEN` without the `functions serve` workaround.
- **CLI 2.95.4 → 2.98.2 upgrade documentation** (code-reviewer Nit, test-engineer Note #6). Both reviewers note the upgrade is mentioned in passing without intent. Worth one sentence in a future doc pass; not blocking.

## Cross-spec touches noted in dispatch
- **`CLAUDE.md` policy note** (lines 232-248, "Local edge runtime bind-mount captures CWD at boot"): test-engineer verified verbatim presence under "Resolved questions / project context" (AC6 PASS). Code-reviewer flagged the long single-line `docker inspect` command as a Nit (legibility, not correctness). Safe to commit alongside spec 002.
- **`specs/001-repoint-burger-patty-prep-refs.md:31`** (AC7b checkbox flip + retroactive-verification narrative): test-engineer verified flip is in place (AC5 PASS). Both reviewers flagged the missing migration-replay prerequisite mention — test-engineer at Should-fix (#2 above), code-reviewer at Nit. Recommend folding in the parenthetical before committing per step 2 above; otherwise safe to commit as-is.

## Status field
Per spec 002 hard rules and CLAUDE.md, the release-coordinator is read-only. The spec's `Status: READY_FOR_REVIEW` field is not changed by this proposal. After fold-ins (if any), the developer is responsible for advancing status to `DONE`.

## Handoff
next_agent: NONE
prompt: SHIP_READY, 0 Critical, 5 Should-fix (all polish on a doc-only deliverable), top: fresh-checkout `PWA_SERVICE_TOKEN` sourcing pointer in Section 3 + Path B-revised replay note on `specs/001-...md:31` — both worth folding in before commit, neither blocking.
payload_paths:
  - specs/002-pwa-catalog-bind-mount-fix.md
  - specs/002-pwa-catalog-bind-mount-fix/reviews/code-reviewer.md
  - specs/002-pwa-catalog-bind-mount-fix/reviews/test-engineer.md
