## Test report for spec 002

_Reviewer: test-engineer. Review date: 2026-05-06. Verification run against live local stack._

---

### Acceptance criteria status

- AC1: Root cause identified — architect names the mechanism with evidence. → PASS
  - Section 1 of the Backend design presents a ranked root-cause analysis. Primary diagnosis (container-creation captures CWD as bind-mount source; `docker restart` does not re-resolve) is supported by three independent evidence threads: (a) `package.json:12` confirms `dev:db` is a bare `supabase start` with no path normalization; (b) the reproduction `Source` path shape matches exactly the "captured CWD at first boot" hypothesis; (c) structural analogy to the already-documented realtime publication gotcha. Remaining candidates (temp cache, user-level config, shell env var, CLI functions-dir config) are individually ruled out with read-only probes. No runtime check needed per spec; documentation evidence is sufficient.

- AC2: `docker inspect` shows mount source = `<repo root>/supabase/functions/`, NOT a `.claude/worktrees/` path. → PASS
  - Verified live. Command run:
    ```
    docker inspect supabase_edge_runtime_imr-inventory \
      --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' \
      | grep -i functions
    ```
    Output: `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions -> /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`
  - No `.claude/worktrees/` reference in any of the 12 running `imr-inventory` containers (full sweep confirmed all 12 containers return "no worktree mounts").
  - Note: the narrower `--format` form using `{{if eq .Destination "/home/deno/functions"}}` returns empty on this machine. The actual Destination is `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions`, not `/home/deno/functions`. This matches Build notes Q3. The `grep functions` fallback is the only portable form and is correctly used throughout the spec.

- AC3: `curl http://127.0.0.1:54321/functions/v1/pwa-catalog ...` returns HTTP 200 with valid JSON. → PASS
  - Verified live. Command run (GET with query param, per architect's correction at spec line 213-239):
    ```
    curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=00000000-0000-0000-0000-000000000001" \
      -H "Authorization: Bearer dev_pwa_token_change_me_for_prod"
    ```
    Output: `200`. Response body is valid JSON (102,672 bytes).
  - Error paths also confirmed: wrong token → 401; no auth → 401; POST method → 405.
  - The original spec reproduction case (POST with JSON body) now returns 405, not 503, confirming the boot error is resolved and the architect's method correction is accurate.

- AC4: Spec 001 AC7b retroactively verified — jq subset check confirms every `recipes[].prep_items[].prep_recipe_id` for "2AM Cheeseburger" appears in top-level `prep_recipes[]`. → PASS
  - Verified live. Both jq filters from spec 002 Section 3 run against the live endpoint:
    - 2AM Cheeseburger sanity: `{"menu_item":"2AM Cheeseburger","prep_item_count":2}` (2 prep items, not 5 — the 4 Burger Patty orphans are gone, 1 canonical remains alongside 2AM SAUCE, matching the Path B-revised end-state documented in Build notes).
    - AC7b subset filter: `[]` (zero unresolved prep_recipe_id values).
    - Catalog-wide regression guard: `[]` (every `recipes[].prep_items[]?.prep_recipe_id` across the full catalog resolves in `prep_recipes[]`).
  - These results match exactly the values recorded in spec 002 Build notes "Verification evidence".

- AC5: Spec 001 AC7b checkbox flipped from `[ ]` to `[x]` in `specs/001-repoint-burger-patty-prep-refs.md`. → PASS
  - Verified in source. `specs/001-repoint-burger-patty-prep-refs.md:31` reads `[x] **(AC7b — HTTP path through `pwa-catalog`)** Retroactively verified 2026-05-06...` The checkbox is ticked and the deferral note has been replaced with a full retroactive-verification narrative citing spec 002, the migration replay, and the jq results.

- AC6: CLAUDE.md gains a sanity-check note for the recurring mode-of-failure. → PASS
  - Verified in source. `CLAUDE.md:232-248` contains the "Local edge runtime bind-mount captures CWD at boot" subsection, verbatim from spec 002 Section 4. Includes the one-liner sanity check and the remediation incantation. Placed under "Resolved questions / project context" as designed.

---

### Test run

No automated test runner exists for this spec (infrastructure fix, not a feature). All verification was performed as documented shell commands.

Commands run and outcomes:

```
# AC2 — mount source check
docker inspect supabase_edge_runtime_imr-inventory \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' \
  | grep -i functions
# Result: /host_mnt/...INVENTORY-MANAGEMENT/supabase/functions -> /Users/will/.../supabase/functions
# PASS

# Full container sweep (all 12 imr-inventory containers)
docker ps --format '{{.Names}}' | grep imr-inventory | while read name; do
  docker inspect "$name" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' \
    | grep -i worktrees || echo "(no worktree mounts)"
done
# Result: all 12 containers returned "(no worktree mounts)"
# PASS

# AC3 — HTTP 200
curl -sS -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=00000000-0000-0000-0000-000000000001" \
  -H "Authorization: Bearer dev_pwa_token_change_me_for_prod"
# Result: 200
# PASS

# AC4 — AC7b jq subset check
jq '
  (.prep_recipes | map(.id)) as $emitted
  | (.recipes[] | select(.menu_item == "2AM Cheeseburger") | .prep_items | map(.prep_recipe_id)) as $referenced
  | $referenced - $emitted
' /tmp/pwa-catalog.json
# Result: []
# PASS

# AC4 — catalog-wide regression guard
jq '
  (.prep_recipes | map(.id)) as $emitted
  | [.recipes[].prep_items[]?.prep_recipe_id] as $referenced
  | ($referenced | unique) - $emitted
' /tmp/pwa-catalog.json
# Result: []
# PASS
```

Pass count: 6 of 6 ACs. Fail count: 0. Not tested: 0.

---

### Notes

#### 1. Verification reproducibility — `$PWA_SERVICE_TOKEN` resolution

**Finding (Should-fix level):** The spec's Section 3 verification protocol provides an inline escape hatch for resolving `PWA_SERVICE_TOKEN`:

> If it isn't, inspect what the edge runtime container has set:
> `docker inspect supabase_edge_runtime_imr-inventory --format '{{range .Config.Env}}{{println .}}{{end}}' | grep PWA`
> Use that value (it's a local-only token, fine to read).

This is sufficient for a knowledgeable developer but requires knowing to look at this escape hatch rather than just having `$PWA_SERVICE_TOKEN` set in the environment. The spec does not state where `PWA_SERVICE_TOKEN` _should_ come from in the normal flow — it only says what to do if it isn't already set.

The Build notes (Q2) explain the actual mechanism: `supabase/functions/.env.local.example` ships the dev token pinned as `PWA_SERVICE_TOKEN=dev_pwa_token_change_me_for_prod`. The developer must copy the example to `.env.local` and run `npx supabase functions serve --env-file ./supabase/functions/.env.local` once after a fresh `supabase stop --no-backup && supabase start`. This is documented in Build notes Q2 but not in Section 3's verification protocol itself. A developer following only Section 3 from a fresh checkout would hit a 500 response ("PWA_SERVICE_TOKEN unset on server") without the container-inspection escape hatch pointing them to the solution.

**Recommendation:** The Section 3 curl block should include a sentence like: "On a clean `supabase start` (no prior `functions serve`), `PWA_SERVICE_TOKEN` may not be injected into the edge runtime. Copy `supabase/functions/.env.local.example` → `.env.local`, then run `npx supabase functions serve --env-file ./supabase/functions/.env.local` once, then kill it; the runtime container persists with the token. The `dev_pwa_token_change_me_for_prod` value from the example file is the correct local dev token." This closes the loop without relying on the reader noticing the escape hatch. Blocking: no — the path works, it just requires knowing about Q2 from Build notes.

#### 2. Verification reproducibility — `docker inspect` destination-path fragility

**Finding (Nit):** The spec leads with the narrower `--format '{{range .Mounts}}{{if eq .Destination "/home/deno/functions"}}...'` form, then footnotes it with a fallback. Build notes Q3 confirms the narrower form returned nothing on this machine — the actual Destination is the macOS canonical repo path, not `/home/deno/functions`. The spec presents the narrower form as the primary and the fallback as... a fallback. Code-reviewer also flags this at nit level. For reproducibility, the two forms should swap roles: the `grep functions` form should be the primary, with the `/home/deno/functions` form demoted to an "(older CLI versions)" aside. Not a correctness problem — the fallback is provided — but a fresh reader will try the primary form first, get no output, and be confused before finding the fallback.

#### 3. Regression guard promotion to `scripts/smoke-edge.sh`

**Recommendation:** The developer's handoff suggestion to promote the catalog-wide jq variant to `scripts/smoke-edge.sh` is sound but should be deferred to a separate commit, not this spec. The current `smoke-edge.sh` is scoped to the `fetch-breadbot-sales` function only (JWT-protected, POST-based, different auth model). Adding `pwa-catalog` coverage would require:
- Resolving `store_id` from the local DB (or hard-coding the Towson UUID `00000000-0000-0000-0000-000000000001`).
- Resolving `PWA_SERVICE_TOKEN` from the environment (same gap as item 1 above).
- Structuring the download + jq step in the existing `pass`/`fail`/`skip` pattern.
- Deciding whether this targets local (`127.0.0.1:54321`) or remote (`$SUPABASE_URL`) — the existing script targets remote by default.

None of these are hard, but they represent a scope expansion beyond fixing the bind-mount. The current state (jq commands copy-pasteable from spec 002 Section 3, results recorded in Build notes, filter verified live) is sufficient for this spec. Promoting to `smoke-edge.sh` should be filed as a follow-up if the team wants ongoing regression protection for `pwa-catalog`. This is not a BLOCK.

#### 4. Spec 001 AC7b retro-verification — third-party reproducibility

**Finding (Should-fix):** A developer reading only spec 001 line 31 encounters:

> Retroactively verified 2026-05-06 after the bind-mount fix landed via specs/002-pwa-catalog-bind-mount-fix.md. Local stack rebooted clean from repo root → mount source confirmed... pwa-catalog migration replayed against seeded local DB (Path B-revised: 3 deleted, 1 repointed)...

The phrase "pwa-catalog migration replayed against seeded local DB" is ambiguous. It refers to running the Spec 001 repair migration (`20260504235959_repoint_burger_patty_orphans.sql`) after `supabase start` had already loaded `seed.sql` (which re-introduces the 4 Burger Patty orphans), because the migration is a no-op when run against an empty pre-seed DB. This is the Path B-revised scenario documented in spec 001 section 5b.

A developer trying to reproduce AC7b verification must:
1. Boot the stack (`npm run dev:db`).
2. Replay the migration via `docker exec ... psql < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`.
3. Inject `PWA_SERVICE_TOKEN` via the `functions serve` workaround.
4. Run the jq checks from spec 002 Section 3.

None of this is stated in spec 001 line 31. The reader must trace to spec 002 Build notes to find the `docker exec` command. For standalone reproducibility, spec 001 line 31 should add a parenthetical: "(requires Path B-revised migration replay per spec 002 Build notes — run `docker exec ... psql < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql` after `supabase start`)". Code-reviewer flagged a similar gap (nit level) regarding the lack of a migration-replay note in the AC7b entry. Agrees with that assessment; classifying as Should-fix rather than Nit because it affects the next developer's ability to independently verify AC7b without tribal knowledge.

#### 5. `supabase/functions/.env.local` gitignore correctness

Confirmed: `.env.local` appears in both `/.gitignore:25` and `supabase/.gitignore:7`. The created file will not be committed. No action required.

#### 6. Supabase CLI version upgrade (2.95.4 → 2.98.2) — undocumented side-effect

Build notes Q2 mentions "CLI 2.95.4 → upgraded mid-fix to 2.98.2" in passing. This upgrade is likely why `supabase start` in 2.98.2 no longer auto-loads the `.env.local` file into the edge runtime on container creation (if it ever did), while the pre-existing container from the worktree era had the tokens baked in. Code-reviewer also flags this (nit level). Agree. It is not clear whether the upgrade was intentional or incidental (Homebrew auto-update during the fix session). This matters for reproducibility: if the dev stack is running CLI 2.95.x, the `functions serve` workaround may not be required, but the spec says it is. A one-sentence note in Q2 clarifying intent would close this ambiguity. Classifying as Nit — the workaround is documented and works regardless of CLI version.

#### 7. No test framework — scoped note

Per the review brief, this is acknowledged project-wide and is not flagged as Critical for this spec. For completeness: spec 002 is a local-dev-infrastructure fix with no source code changes. The verification protocol (docker inspect + curl + jq) is the appropriate test medium for this class of work, and it has been executed and documented.

---

### Summary of findings by severity

**Critical:** None.

**Should-fix:**
1. Section 3 verification protocol does not explain the `PWA_SERVICE_TOKEN` sourcing flow for a fresh checkout — requires knowing to trace to Build notes Q2. Add a sentence pointing to the `.env.local.example` → `.env.local` + `functions serve` workaround.
2. Spec 001 AC7b line 31 requires tribal knowledge (trace to spec 002 Build notes) to reproduce the migration-replay prerequisite. Add a parenthetical citing the `docker exec ... psql` command needed.

**Nit:**
1. Section 3 leads with the narrower `/home/deno/functions` destination filter as the primary form; it returns nothing on this machine. The `grep functions` fallback should be promoted to primary.
2. Supabase CLI 2.95.4 → 2.98.2 upgrade mentioned in passing in Q2; intent (deliberate vs. incidental) is not documented. Matters for reproducibility.
3. Regression guard (`pwa-catalog` subset jq check) is currently only in spec prose. Promotion to `scripts/smoke-edge.sh` is worthwhile but out of scope for this spec — file as follow-up if desired.
