## Code review for spec 002

_Reviewer: code-reviewer. Review scope: doc quality and decision rationale (no source-tree code changes in this spec)._

---

### Critical

None.

---

### Should-fix

- `specs/002-pwa-catalog-bind-mount-fix.md:396-397` — The "Verification evidence" block contains a `->` arrow line that is redundant and slightly misleading. The pre-fix entry reads:

  ```
  /host_mnt/.../INVENTORY-MANAGEMENT/.claude/worktrees/pensive-raman-4d93c5/supabase/functions
    -> /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.claude/worktrees/pensive-raman-4d93c5/supabase/functions
  ```

  Both halves of this line refer to the same real path — one is the macOS host-mount alias (`/host_mnt/...`) and one is the canonical macOS path (`/Users/will/...`). A future reader could easily misread this as "source → destination", which is the format used elsewhere in the same spec for Docker bind-mounts. The format is not explained inline. Either add a brief parenthetical ("macOS alias → canonical path; same directory") or collapse to just the canonical path. The post-fix line uses a different layout (no arrow), which makes the inconsistency more confusing.

- `specs/002-pwa-catalog-bind-mount-fix.md:373-379` (Build notes, Q2) — The narrative says "Best guess on origin: a prior `supabase functions serve --env-file ...` invocation against the worktree CWD created the container with those values." This is labeled a "best guess" but is asserted in the same paragraph as diagnostic fact that informs the workaround decision. The "best guess" qualifier should either be elevated to evidence (show the container-inspection output that confirms the env vars were baked in, not injected at runtime) or clearly marked as an unresolved question so the follow-up `[edge_runtime.secrets]` investigation is understood to be addressing an assumption, not a confirmed conclusion. As written, the Q2 section conflates "what we observed" with "why that happened" in a way that could mislead the next person who hits this.

- `specs/002-pwa-catalog-bind-mount-fix.md:379` (Build notes, Q2) — The open `[edge_runtime.secrets]` follow-up question is framed adequately as a real option (referencing the commented-out block at `supabase/config.toml:378`), but the answer space isn't closed: it says "out of scope for this spec; flagged for follow-up" without naming who owns that follow-up or what the decision trigger is. Per CLAUDE.md conventions, agent-facing policy notes should tell the agent what to do, not just what was observed. Recommend adding a one-sentence decision rule, e.g., "If any future spec requires a clean `supabase start` to inject `PWA_SERVICE_TOKEN` without a manual `functions serve` step, file a new spec to evaluate `[edge_runtime.secrets]`." Without this, the follow-up is advisory noise.

---

### Nits

- `specs/002-pwa-catalog-bind-mount-fix.md:31` (spec body, Reproduction section) — The reproduction's `docker inspect` command uses a bare `grep -A 5 '"Mounts"'` pattern. This was superseded in Section 3 of the Backend design, which provides the more precise `--format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'` form. The reproduction section was not updated to match. Minor inconsistency — a reader skimming only the Reproduction section will get the weaker command. Not a correctness problem, but the spec would read more cleanly if the Reproduction section pointed to the verification protocol form.

- `specs/002-pwa-catalog-bind-mount-fix.md:213` (Backend design, Section 3) — The note "The standard Supabase edge-runtime container mount destination is `/home/deno/functions`" is presented as a confident assertion, then immediately walked back ("If your CLI version uses a different path…"). Build notes Q3 confirms the narrower filter returned nothing on this box. The spec would be cleaner if the qualified sentence were the primary form and the `/home/deno/functions` example were demoted to a "(CLI 2.95.x used this, may vary)" aside, rather than leading with false confidence.

- `CLAUDE.md:244` (policy note) — The sanity-check command is written as a single long line:

  ```
  docker inspect supabase_edge_runtime_imr-inventory --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep functions
  ```

  This is harder to read inline than the multi-line form used in the architect's design (spec Section 3, which wraps the `--format` flag for clarity). The rest of the "Resolved questions" entries don't contain shell commands, so there's no existing precedent to follow, but consistency with the spec's own verification section would favor the wrapped form. Cosmetic, but the command is the load-bearing content of this policy note — legibility matters.

- `specs/001-repoint-burger-patty-prep-refs.md:31` (AC7b retro-verification text) — The description says `jq` subset filter `($referenced - $emitted)` returned `[]`. This matches spec 002 Section 3's jq filter body exactly (`$referenced - $emitted`). However, the AC7b line doesn't mention that the Path B-revised migration replay was a prerequisite for this result — the reader needs to trace to Build notes "Path B-revised migration replay" to understand why `supabase start` alone wasn't sufficient to land in the AC7b end-state. A one-clause addition ("after Path B-revised migration replay per spec 002 Build notes") would make the AC7b entry self-contained. Not wrong as written; just requires cross-file tracing that isn't hinted at.

- `specs/002-pwa-catalog-bind-mount-fix.md:384-390` (Build notes, "Stale studio mount finding") — The finding notes a second stale mount on `supabase_studio_imr-inventory` from a *different* worktree name (`interesting-bouman-f72d26`) than the primary issue (`pensive-raman-4d93c5`). This is surfaced correctly per the spec's curiosity-probe hard rule. However, there is no mention of whether the studio stale mount had any functional impact (was Studio UI broken?), or whether this finding warrants its own CLAUDE.md note. The "no action required" conclusion is reasonable, but a brief one-liner on functional impact (e.g., "Studio UI was unaffected because Studio reads from the DB, not from the functions directory") would close the loop rather than leaving it as an implicit assumption.

- `specs/002-pwa-catalog-bind-mount-fix.md:375` (Build notes, Q2) — "CLI 2.95.4 → upgraded mid-fix to 2.98.2" is mentioned in passing but the upgrade itself is not called out as a deliberate decision or a side-effect with risk. CLAUDE.md's local-dev stack memory explicitly pins the local stack configuration. A one-sentence note explaining whether the CLI upgrade was intentional (e.g., to get a specific fix) or incidental (e.g., Homebrew/npm auto-update), and whether it changes anything about `dev:db` behavior, would be useful for reproducibility. As written, a reader cannot tell if 2.98.2 is now a dependency or a happy accident.
