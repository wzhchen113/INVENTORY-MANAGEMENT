# Spec 002: Fix pwa-catalog edge runtime bind-mount

Status: DONE

**Type:** Local infrastructure / dev tooling
**Filed:** 2026-05-06
**Severity:** Low (workaround exists; no production impact)
**Blocks:** [Spec 001](001-repoint-burger-patty-prep-refs.md) AC7b

## User story
As a developer running the local Supabase stack via `npm run dev:db`, I want the `supabase_edge_runtime_imr-inventory` container to bind-mount its `/functions` source from the active checkout's `supabase/functions/` directory, so that I can exercise edge functions over local HTTP (e.g. `pwa-catalog`) and verify acceptance criteria that require a real HTTP path — most immediately Spec 001 AC7b.

## Background
The local `pwa-catalog` edge function returns `503 BOOT_ERROR`. The `supabase_edge_runtime_imr-inventory` Docker container is bind-mounted to a stale Claude Code worktree path (`.claude/worktrees/pensive-raman-4d93c5/supabase/functions/`) that no longer contains function source. Restarting the container does not help — the mount target is fixed at `npm run dev:db` boot time.

When Claude Code worktree mode is enabled, ephemeral worktrees live under `.claude/worktrees/<random-name>/`. At some point, an `npm run dev:db` boot captured a then-active worktree path as the bind-mount source for the edge runtime. The worktree was later abandoned/deleted, but the mount config is fixed at container creation. Per CLAUDE.md, `.claude/worktrees/` is auto-managed and current work happens on `main` — so the worktree this points at no longer reflects active development.

The directory was added to `.gitignore` in commit `f54d039` (2026-05-06).

## Reproduction

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/pwa-catalog \
  -H "Authorization: Bearer $PWA_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"brand_id":"2a000000-0000-0000-0000-000000000001"}'
# → 503 BOOT_ERROR
```

Inspect to confirm:
```bash
docker inspect supabase_edge_runtime_imr-inventory | grep -A 5 '"Mounts"'
# Source: .../.claude/worktrees/pensive-raman-4d93c5/supabase/functions/
```

## Impact

- **Spec 001 AC7b** (HTTP-path verification of `pwa-catalog` payload self-consistency) is currently **DEFERRED**. The data invariant was verified via SQL-equivalent subset check, but the function's serialization, `is_current = true` filter logic, and service-token validation path are unexercised locally.
- Any future spec with an AC requiring local HTTP testing of any edge function will hit the same wall.
- No production impact — remote edge runtime is a separate Supabase-managed deployment.

## Suggested fix paths (for architect to evaluate)

1. **Force a clean re-bind on next dev-stack boot.**
   ```bash
   npx supabase stop --no-backup
   # confirm container removed
   npx supabase start  # or `npm run dev:db` if it wraps that
   docker inspect supabase_edge_runtime_imr-inventory | grep Source
   ```
   Mount source should now be `<repo root>/supabase/functions/`. If it is, the issue is cured for this checkout.

2. **If (1) doesn't help, investigate why `supabase start` chose the worktree path.** Likely culprits:
   - Stale `supabase/.temp/` cache pinning the path
   - A leftover entry in `~/.supabase/` user config
   - An env var (`SUPABASE_WORKDIR` or similar) locked to the worktree path
   - Supabase CLI capturing CWD at first-boot vs every-boot

3. **Document expected dev-stack boot state in CLAUDE.md** — after `npm run dev:db`, the edge runtime mount should always point at the active checkout's `supabase/functions/`. Add as a sanity check to the local-dev checklist.

## Acceptance criteria

- [ ] Root cause identified — architect names which mechanism (cache, config, CLI behavior, worktree handoff, etc.) actually caused the stale bind-mount, with evidence.
- [ ] `docker inspect supabase_edge_runtime_imr-inventory` shows mount source = `<repo root>/supabase/functions/`, NOT a `.claude/worktrees/` path.
- [ ] `curl http://127.0.0.1:54321/functions/v1/pwa-catalog -H "Authorization: Bearer $PWA_SERVICE_TOKEN" ...` returns HTTP 200 with valid JSON (not `503 BOOT_ERROR`).
- [ ] Spec 001 AC7b retroactively verified — `jq`-based subset check on the HTTP response confirms every `recipes[].prep_items[].prep_recipe_id` for "2AM Cheeseburger" appears in top-level `prep_recipes[]`.
- [ ] Spec 001 AC7b checkbox flipped from `[ ]` to `[x]` in `specs/001-repoint-burger-patty-prep-refs.md`.
- [ ] If the root cause is a recurring mode-of-failure (e.g., worktree handoff capturing CWD), CLAUDE.md gains a sanity-check note in the local-dev section so the next agent doesn't get burned the same way.

## Out of scope

- Production / hosted edge runtime — this issue is local-only.
- Refactoring `pwa-catalog/index.ts` itself.
- The 399 `prep_recipe_ingredients` orphans (separate spec).

## References

- [specs/001-repoint-burger-patty-prep-refs.md](001-repoint-burger-patty-prep-refs.md) — Spec 001, AC7b
- `supabase/functions/pwa-catalog/index.ts` — the function whose HTTP path is failing
- `supabase/config.toml:381-385` — `verify_jwt = false` + service-token config
- `package.json` — `dev:db` script
- `CLAUDE.md` — "Empty directories" section, `.claude/worktrees/` policy; local-dev memory at `memory/project_local_dev_stack.md`
- Commit `f54d039` — added `.claude/worktrees/` to `.gitignore`
- Commit `6a2a6b3` — Spec 001 close-out (this issue is the deferred work)

## Backend design

This is a local-dev-infrastructure spec, not a feature. There are no Postgres / RLS / RPC / db.ts surface changes to design. The "design" is a diagnosis, a fix script, a verification protocol, a one-line policy note, and a risk/blast-radius assessment. Sections that don't apply ("Data model changes", "RLS impact", "API contract", "Frontend store impact") are intentionally omitted.

### 1. Root cause (ranked)

Read-only investigation summary. **Highest-likelihood cause is #1 by a wide margin; the others were checked and ruled out.**

**1. Container-creation captures CWD as the bind-mount source; restarts don't re-resolve. (Most likely — primary diagnosis.)**

The Supabase CLI's local stack invokes Docker with bind-mounts whose source is computed from the CLI's working directory at `supabase start` time. The `supabase_edge_runtime_<project>` container in particular receives a bind-mount of `<cwd>/supabase/functions/` to `/home/deno/functions` (or equivalent) inside the container. Once the container is *created*, the mount source is baked into the container's config — `docker restart` re-runs the entrypoint but does not re-resolve the mount; only `docker rm` followed by `docker create` (which is what `supabase stop` then `supabase start` does) recomputes it.

Evidence:
- `package.json:12` — `dev:db` is literally `supabase start`, no wrapper or path normalization. The CLI runs in whatever CWD the user invoked `npm` from.
- The reproduction case (`Source: .../.claude/worktrees/pensive-raman-4d93c5/supabase/functions/`) is exactly the shape that "captured CWD at first boot, never refreshed since" produces. A Claude Code worktree session at `.claude/worktrees/pensive-raman-4d93c5/` was active when `supabase start` was last run; the worktree has since been abandoned (CLAUDE.md notes current work happens on `main`, and `.gitignore` excluded the directory in `f54d039`), but the container persisted across that handoff.
- This is structurally identical to the realtime-publication gotcha already documented in `memory/project_realtime_publication_gotcha.md`: "first-boot captures state, restart-in-place doesn't re-snapshot." Different container, same shape.
- `supabase/config.toml` has no `[edge_runtime]` directive that pins a path; only `policy = "per_worker"`, `inspector_port`, `deno_version`. The path is implicit-from-CWD, not declared.

**2. `supabase/.temp/` cache pinning the path. Ruled out.**

Read-only listing via individual file probes shows `supabase/.temp/` contains only version pins and a remote project ref:
- `cli-latest` → `v2.98.2`
- `project-ref` → `ebwnovzzkwhsdxkpyjka`
- `postgres-version` → `17.6.1.084`
- `gotrue-version` → `v2.189.0`
- `rest-version` → `v14.4`
- `storage-version` → `v1.54.0`
- `edge-runtime-version` → not present
- `pooler-url` → remote pooler URL

No CWD-cache, no functions-dir lock. This rules out cache-based path pinning.

**3. User-level Supabase CLI config under `~/.supabase/`. Ruled out.**

Read-only probe: `~/.supabase/access-token`, `~/.supabase/config`, `~/.supabase/config.toml`, `~/.supabase/cli.json` — none exist. There is no user-level state binding the CLI to any path.

**4. Shell-rc env var (`SUPABASE_WORKDIR` or similar). Ruled out.**

`~/.zshrc` contents: NVM init, envman load, two Python aliases. No Supabase env. The only way for an env var to have leaked in would be the shell session that ran `supabase start` — and even if it did, it would still resolve to a real path, not lock to a stale worktree across container recreations.

**5. The CLI itself reading the wrong functions-dir.** Ruled out.

`supabase/config.toml` does not declare a custom `functions_dir`. The CLI defaults to `<cwd>/supabase/functions`, which is the canonical location. The `pwa-catalog` source at `supabase/functions/pwa-catalog/index.ts` is present, valid, and matches `[functions.pwa-catalog]` in config.toml. The bug is in *which* `supabase/functions/` Docker is mounting, not in the CLI's choice of name.

**Conclusion.** The container was created during a `supabase start` invocation whose CWD was a Claude Code worktree (`.claude/worktrees/pensive-raman-4d93c5/`). Since then, every subsequent `npm run dev:db` from `main` has been a no-op for that container (it's already running), and any `docker restart` has reused the baked-in mount config. The container has never been re-created from `main`'s CWD.

### 2. Recommended fix path

Fix path **(1)** from the spec — force a clean container teardown so the next `supabase start` re-resolves the bind-mount from the current `main` CWD. This is the minimal surgical fix and matches the reproduction's expected resolution.

**Pre-fix verification** (read-only, confirms diagnosis before mutating anything):

```bash
# A. Confirm CWD is the repo root, not a worktree.
pwd
# Expected: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT

# B. Confirm the broken mount is exactly what the spec describes.
docker inspect supabase_edge_runtime_imr-inventory \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
# Expected: a line whose Source contains ".claude/worktrees/" — the broken state.
# If Source is already "<repo root>/supabase/functions" the bug is already cured;
# stop here and skip to verification.

# C. Sanity-check no other container has the same problem (curiosity probe; do
#    not act on the result without surfacing to the user).
docker ps --format '{{.Names}}' | grep imr-inventory | while read name; do
  echo "=== $name ==="
  docker inspect "$name" --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' \
    | grep -i worktrees || echo "(no worktree mounts)"
done
```

**Fix execution** (the user runs these — architect designs only):

```bash
# 1. Stop the local stack, removing containers. --no-backup skips the volume
#    snapshot; the local DB will be recreated from migrations + seed.sql on
#    next start, which is the expected dev workflow per memory/project_local_dev_stack.md.
npx supabase stop --no-backup

# 2. Confirm all imr-inventory containers are gone.
docker ps -a --format '{{.Names}}' | grep imr-inventory || echo "(all gone — good)"

# 3. Boot fresh from the repo root. CWD must be the repo root, not a worktree.
cd /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT
npm run dev:db
# Wait for "started" output — typically 10-30s.
```

**Escape hatch / reversal.** If something misfires:
- The `--no-backup` flag means local DB volume is destroyed, but `supabase/seed.sql` and migrations recreate the dataset deterministically on next `supabase start`. No data loss in any meaningful sense (the local DB is reproducible by design).
- If the new container also gets a bad mount (e.g., user accidentally ran from a worktree directory), repeat steps 1-3 with extra care to `cd` to the repo root first. The fix is idempotent.
- If `supabase stop` itself errors (e.g., a container is in a broken state), `docker rm -f $(docker ps -aq --filter name=imr-inventory)` is the manual fallback. Surface this to the user — do NOT have a developer-agent run it without confirmation; it's destructive.

**Why not fix path (3) — "document expected boot state" — alone?** Documentation alone doesn't unblock AC7b. We need both: the fix to clear the current bad state, and a policy note (Section 4 below) so the next agent doesn't re-create it. The two are complementary, not alternatives.

**Why not a deeper fix (force-bind via config.toml)?** `supabase/config.toml` has no documented `[edge_runtime].functions_dir` field, and even if it did, hard-coding a path would break every other developer's checkout. The CWD-relative default is correct; the only bug is the container persistence across CWD changes.

### 3. Verification protocol

Maps 1-to-1 to the spec's acceptance criteria. The developer (or backend-developer agent) runs these in order; ALL must pass.

**AC: "Root cause identified."**
Already satisfied by Section 1 above. No runtime check needed.

**AC: "`docker inspect ...` shows mount source = `<repo root>/supabase/functions/`, NOT a `.claude/worktrees/` path."**

```bash
docker inspect supabase_edge_runtime_imr-inventory \
  --format '{{range .Mounts}}{{if eq .Destination "/home/deno/functions"}}{{.Source}}{{end}}{{end}}'
# Expected: /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions
# (or with a trailing slash; either is fine)
# Failure mode: contains ".claude/worktrees" → fix did not take. Re-run Section 2.
```

Note on `Destination`: the standard Supabase edge-runtime container mount destination is `/home/deno/functions`. If your CLI version uses a different path (older versions used `/functions`), the developer should drop the `if eq` filter and grep `.Source` for the repo root instead. Suggested fallback:

```bash
docker inspect supabase_edge_runtime_imr-inventory \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' \
  | grep -i 'functions'
# Expected: a line beginning with /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions
```

**AC: "`curl http://127.0.0.1:54321/functions/v1/pwa-catalog ...` returns HTTP 200 with valid JSON."**

The `pwa-catalog` function takes `store_id` as a **GET query param**, not a POST body (see `supabase/functions/pwa-catalog/index.ts:72-80`). The reproduction in the spec body uses `-X POST` with a JSON body, which would return 405 even if the runtime were healthy. Use the correct shape:

```bash
# Pull the local store_id from the seeded dataset. Towson is the canonical
# test store per memory/project_local_dev_stack.md.
STORE_ID=$(docker exec -i supabase_db_imr-inventory \
  psql -U postgres -d postgres -tAc \
  "select id from public.stores where name ilike 'towson%' limit 1;")
echo "STORE_ID=$STORE_ID"

# PWA_SERVICE_TOKEN sourcing on a fresh checkout: copy
# `supabase/functions/.env.local.example` → `supabase/functions/.env.local`,
# then run `npx supabase functions serve --env-file ./supabase/functions/.env.local`
# once to bake the env into the edge runtime container. After that, the value is
# also available via `docker inspect supabase_edge_runtime_imr-inventory --format
# '{{range .Config.Env}}{{println .}}{{end}}' | grep PWA`. See `## Build notes`
# Q2 below for the full rationale (CLI 2.98.2 doesn't auto-load .env.local on
# `supabase start`; only `functions serve --env-file` does).

curl -sS -i \
  "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=$STORE_ID" \
  -H "Authorization: Bearer $PWA_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  | head -40
# Expected first line: HTTP/1.1 200 OK
# Failure modes:
#   503 BOOT_ERROR  → bind-mount fix did not take, or function source has a syntax error
#   401             → PWA_SERVICE_TOKEN is wrong / unset
#   404             → wrong store_id
#   405             → method mismatch (you sent POST instead of GET)
```

**AC7b: "every `recipes[].prep_items[].prep_recipe_id` for 2AM Cheeseburger appears in top-level `prep_recipes[]`."**

Save the response and apply this `jq` filter. The filter computes the set difference (referenced prep IDs minus emitted prep IDs, scoped to the 2AM Cheeseburger recipe) and asserts it's empty.

```bash
curl -sS \
  "http://127.0.0.1:54321/functions/v1/pwa-catalog?store_id=$STORE_ID" \
  -H "Authorization: Bearer $PWA_SERVICE_TOKEN" \
  > /tmp/pwa-catalog.json

# Sanity: 2AM Cheeseburger is present and has prep_items.
jq '.recipes[] | select(.menu_item == "2AM Cheeseburger") | {menu_item, prep_item_count: (.prep_items | length)}' \
  /tmp/pwa-catalog.json
# Expected: {"menu_item":"2AM Cheeseburger","prep_item_count":<n>} where n > 0.

# AC7b subset check. Returns the array of unresolved prep_recipe_id values.
# MUST be exactly [].
jq '
  (.prep_recipes | map(.id)) as $emitted
  | (.recipes[] | select(.menu_item == "2AM Cheeseburger") | .prep_items | map(.prep_recipe_id)) as $referenced
  | $referenced - $emitted
' /tmp/pwa-catalog.json
# Expected: []
# Failure mode: a non-empty array → some referenced prep IDs are missing from
# prep_recipes[]. That would mean Spec 001's data fix didn't actually land
# OR pwa-catalog's is_current=true filter is excluding the canonical row.
```

A stricter cross-check that doesn't trust the `menu_item` string match (in case naming changes):

```bash
# Catalog-wide subset: every prep referenced by any recipe must be emitted.
# Useful as a regression guard beyond the 2AM Cheeseburger.
jq '
  (.prep_recipes | map(.id)) as $emitted
  | [.recipes[].prep_items[]?.prep_recipe_id] as $referenced
  | ($referenced | unique) - $emitted
' /tmp/pwa-catalog.json
# Expected: []
```

Run both. Record output in the spec body.

**AC: "Spec 001 AC7b checkbox flipped from `[ ]` to `[x]`."**

This is a documentation edit on `specs/001-repoint-burger-patty-prep-refs.md`, line 31. The developer agent should:
1. Edit that single checkbox.
2. Update the surrounding deferral note to reflect that AC7b is now verified, citing this spec by filename.
3. NOT change the rest of the Spec 001 body or its `Status: DONE`.

**AC: "If recurring mode-of-failure, CLAUDE.md gains a sanity-check note."**

See Section 4.

### 4. Project-policy note (proposed `CLAUDE.md` addition)

The failure mode is structurally recurring. Two precedents now exist for "Supabase local container captures something at first-boot and never re-snapshots": the realtime publication gotcha (`memory/project_realtime_publication_gotcha.md`) and this one. The next agent will get burned the same way unless we surface it.

**Proposed addition to `CLAUDE.md`**, under the existing "Resolved questions / project context" section, as a new subsection. Keep it short — one paragraph plus a one-liner check, in the project's existing voice:

```markdown
### Local edge runtime bind-mount captures CWD at boot

`supabase start` (via `npm run dev:db`) bind-mounts `<cwd>/supabase/functions/`
into `supabase_edge_runtime_imr-inventory` at *container creation* time, not at
every restart. If the stack was first booted from a since-deleted directory
(e.g., a `.claude/worktrees/<name>/` worktree), the mount stays pinned there
even after you `cd` back to the repo root and `docker restart`. Symptom:
`pwa-catalog` and other edge functions return `503 BOOT_ERROR` locally with
otherwise unexplained "function source not found" errors in the runtime logs.

**Sanity check before debugging an edge function locally:**

`docker inspect supabase_edge_runtime_imr-inventory --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep functions`
should print a path under the active repo root. If it points at
`.claude/worktrees/` or any other stale path, run `npx supabase stop --no-backup
&& npm run dev:db` from the repo root to force a clean re-bind. Same shape as
the realtime gotcha — `docker restart` alone won't help.
```

**Alternative placement.** The user could instead add this as a memory under `memory/project_edge_runtime_bind_mount_gotcha.md`. Given that the realtime sibling is already a memory and the local-dev stack note is also a memory, that placement may be more consistent. Either works; flagging as user choice rather than prescribing.

**Decision for the developer agent:** add the policy note to `CLAUDE.md` under "Resolved questions / project context" as designed above, unless the user (during build phase) directs them to the memory location instead. Do not duplicate to both.

### 5. Risk / blast radius

**Worst case if the fix misfires.** The fix script runs `supabase stop --no-backup` followed by `npm run dev:db`. The `--no-backup` flag destroys the local DB volume. Concrete risks:

1. **Lost local-only mutations.** Any data the user typed into the running stack since the last `db reset` is gone after `supabase stop --no-backup`. Per `memory/project_local_dev_stack.md`, the stack is reproducible from `migrations/` + `seed.sql` in ~10s, so this is the expected workflow. NOT a real risk for normal use, but worth flagging if the user has been doing live exploration in Studio.
2. **Edge function secrets.** `PWA_SERVICE_TOKEN` lives in `supabase/functions/.env.local` (gitignored) per the `dev:functions` script wiring. That file persists on disk through `supabase stop`, so secrets survive. **However**: a probe during this design found no `supabase/functions/.env.local` file currently exists in this checkout. If the developer agent finds the new edge runtime can't read `PWA_SERVICE_TOKEN`, that file may need to be (re)created. Surface to user; do NOT invent a token value.
3. **`supabase stop` hanging or partially failing.** If a container is in a broken state, `supabase stop` may report success while leaving an orphan container. The `docker ps -a | grep imr-inventory` confirmation step in the fix catches this. Manual fallback (`docker rm -f`) requires user confirmation.
4. **Wrong CWD on re-boot.** If the user runs `npm run dev:db` from a worktree by accident, we re-create the bug. The fix script explicitly `cd`s to the absolute repo root before `npm run dev:db` to defend against this.

**Uncommitted-state implications.** Working tree currently has:
- `M .claude/launch.json` — staged-modification of a Claude Code config file. The fix touches no files in `.claude/`, so this is unaffected. Leave alone.
- `?? docs/internal/prep-canonicalness-notes.md` — untracked notes file. The fix touches no files in `docs/`, so this is unaffected. Leave alone.

**The fix itself touches:**
- Docker container state (destroy + recreate) — not source-controlled.
- Local Postgres volume (destroyed by `--no-backup`, recreated by next `supabase start`) — not source-controlled.
- One spec file edit on `specs/001-repoint-burger-patty-prep-refs.md` (flip the AC7b checkbox after verification passes).
- One policy edit on `CLAUDE.md` (or a new memory file under `memory/`).

**Files the developer-agent must NOT touch** (per CLAUDE.md):
- `app.json` (slug).
- `src/screens/AdminScreens.tsx`.
- Any of `src/store/useSupabaseStore.ts`, `src/store/useJsonServerSync.ts`, `db.json`, the `npm run db` script.

This spec doesn't ask for anything in those files anyway, but stating it for completeness.

### 6. Realtime impact

None. This is a local Docker-config issue. No `supabase_realtime` publication change. The realtime container can stay running across the fix; only `supabase_edge_runtime_imr-inventory` is being re-created. (Note: `supabase stop --no-backup` will tear down ALL containers, including realtime — they'll all come back on `supabase start`. The publication gotcha from `memory/project_realtime_publication_gotcha.md` does NOT apply here because the publication itself isn't changing; only the realtime container's slot is being re-snapshotted from the same publication state.)

### 7. Edge function changes

None to source. `pwa-catalog/index.ts` is correct; the only reason it's failing locally is the bind-mount, not the code. `verify_jwt = false` setting in `supabase/config.toml:384-385` stays as-is.

### 8. Open questions / things flagged for user judgement

1. **Policy note placement** — `CLAUDE.md` subsection vs `memory/project_edge_runtime_bind_mount_gotcha.md`. Section 4 above offers both options; user picks during build.
2. **`supabase/functions/.env.local` may not exist on disk in this checkout.** If `PWA_SERVICE_TOKEN` isn't in the new edge runtime's env after re-boot, the developer agent must surface to user, not invent a value.
3. **Mount destination string in the verification command.** Different Supabase CLI versions use different paths inside the edge runtime container (`/home/deno/functions` vs `/functions`). The fallback `docker inspect ... | grep functions` form is provided to dodge that fragility.

## Build notes

Implementation 2026-05-06. All ACs verified. Decisions made on the three open questions:

### Q1 (policy-note placement) — landed in CLAUDE.md
Added under "Resolved questions / project context" as designed, alongside the existing `app.json` slug note. Not duplicated to a memory file. Keeps the gotcha co-located with the other dev-environment policies.

### Q2 (`.env.local` / `PWA_SERVICE_TOKEN` delivery) — actual mechanism diverged from architect's expectation; documented below
Architect's expectation (Section 5, point 2) was that `.env.local` would persist secrets through `supabase stop`. Reality on this checkout (CLI 2.95.4 → upgraded mid-fix to 2.98.2):

- Pre-fix: `supabase/functions/.env.local` did **not** exist on disk; the broken edge runtime container nonetheless had `PWA_SERVICE_TOKEN=dev_pwa_token_change_me_for_prod` (and `STAFF_SERVICE_TOKEN`) baked into its env. Best guess on origin: a prior `supabase functions serve --env-file ...` invocation against the worktree CWD created the container with those values, and `supabase start` then reused it.
- Post-fix `supabase stop --no-backup && supabase start`: container recreated cleanly with the correct mount, but **without** `PWA_SERVICE_TOKEN`. `npm run dev:db` (`supabase start`) does **not** auto-load `supabase/functions/.env.local` into the edge runtime in CLI 2.98.2 — only `npm run dev:functions` (`supabase functions serve --env-file ./supabase/functions/.env.local`) does.
- Workaround applied (no source-tree changes): copied `supabase/functions/.env.local.example` → `.env.local` (ships pinned dev tokens and is documented for that purpose at line 2: "Copy to `.env.local` and fill in real values"), then ran `npx supabase functions serve --env-file ./supabase/functions/.env.local` once. That CLI invocation re-creates the edge runtime container with the env-file values, **preserving the now-correct mount**. After killing the foreground `serve` process, the edge runtime container persists with both the right mount and the right env. `pwa-catalog` then returned HTTP 200.
- `.env.local` is gitignored (`/.gitignore` line for `.env.local` + `supabase/.gitignore` per the example file's comment), so this is a local-only artifact. **No invented token values** — used the documented dev token from the example file.
- Open question for the user: whether to add an `[edge_runtime.secrets]` block to `supabase/config.toml` (committed, declares which env vars the edge runtime should pick up via `env(VAR)` syntax) so future `supabase start` boots inject these secrets without the `functions serve` workaround. Out of scope for this spec; flagged for follow-up.

### Q3 (mount-destination fragility) — used the `grep functions` fallback throughout
The narrower form (`if eq .Destination "/home/deno/functions"`) returned nothing on this box's edge runtime — the destination string varies. Stuck with the fallback `docker inspect ... | grep functions` form for both the diagnosis snapshot and the post-fix verification. Result was unambiguous (one mount line per container, source path obvious).

### Stale studio mount finding (curiosity probe — not in spec scope)
The pre-fix `docker inspect` sweep (Section 2 step C) surfaced **two** stale worktree mounts, not one:

- `supabase_edge_runtime_imr-inventory` → `.../.claude/worktrees/pensive-raman-4d93c5/supabase/functions` (the spec's headline issue)
- `supabase_studio_imr-inventory` → `.../.claude/worktrees/interesting-bouman-f72d26/supabase/{functions,snippets}` (additional stale worktree mount, different worktree name)

Both were cleared by the same `supabase stop --no-backup && supabase start` cycle. Post-fix sweep confirms zero containers reference any worktree path. Surfaced here per spec hard rule "do not act on the result without surfacing to the user" — no action required, the fix happens to cure both.

### Verification evidence

```
# Pre-fix mount (broken):
/host_mnt/.../INVENTORY-MANAGEMENT/.claude/worktrees/pensive-raman-4d93c5/supabase/functions
  -> /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/.claude/worktrees/pensive-raman-4d93c5/supabase/functions

# Post-fix mount (correct):
/host_mnt/.../INVENTORY-MANAGEMENT/supabase/functions
  -> /Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions

# pwa-catalog HTTP smoke (after Path B-revised migration replay):
curl -i ".../pwa-catalog?store_id=<towson>" -> HTTP/1.1 200 OK, Content-Length: 102672

# AC7b 2AM Cheeseburger subset filter:
[]   # zero unresolved prep_recipe_id values

# Stricter catalog-wide subset (regression guard):
[]   # every recipes[].prep_items[].prep_recipe_id resolves in prep_recipes[]

# Recipe state for 2AM Cheeseburger after fix:
prep_item_count: 2 (was 5: 4 Burger Patty orphans + 1 valid 2AM SAUCE)
  - 66d823bb-...  (2AM SAUCE,    is_current=true, qty 20g)
  - 500ef28d-...  (Burger Patty, is_current=true, qty 6oz, canonical)
```

### Path B-revised migration replay (required to seed local DB into the AC7b end-state)
Per Spec 001 section 5b "Apply-path semantics and verification limits": `supabase start` against an empty DB runs migrations first (no-op for the repoint repair) then loads `seed.sql` (re-introduces the 4 Burger Patty orphans). Path B-revised is the documented manual remediation. Ran:

```
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres \
  < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql
```

Output: `NOTICE: Spec 001: cleared 4 Burger Patty orphans (3 deleted as collisions, 1 repointed to canonical 500ef28d-...)`. Matches the documented `(3, 1)` Path B-revised end-state exactly. No spec changes — this is using the existing migration as designed.

## Files changed

### CLAUDE.md (policy note)
- `CLAUDE.md` — added "Local edge runtime bind-mount captures CWD at boot" subsection under "Resolved questions / project context" with the sanity-check command and remediation incantation. Verbatim text from spec 002 Section 4.

### specs/ (status + Spec 001 retroactive verification + close-out fold-ins)
- `specs/001-repoint-burger-patty-prep-refs.md` — (2026-05-06 build) flipped AC7b checkbox `[ ]` → `[x]`; replaced the DEFERRED note with a retroactive-verification note citing this spec, the Path B-revised migration replay, and the jq subset results. (2026-05-06 close-out fold-in) added a parenthetical naming the migration-replay prerequisite (`docker exec -i supabase_db_imr-inventory psql ... < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`) so AC7b is reproducible from spec 001 alone. No other content changed; `Status: DONE` preserved across both passes.
- `specs/002-pwa-catalog-bind-mount-fix.md` (this file) — (2026-05-06 build) `Status: READY_FOR_BUILD` → `READY_FOR_REVIEW`; appended this `## Build notes` section and this `## Files changed` list. (2026-05-06 close-out fold-in) added a one-sentence `PWA_SERVICE_TOKEN` sourcing pointer in Section 3's verification protocol cross-linking to Build notes Q2; updated this Files-changed list to reflect today's two fold-in edits; `Status: READY_FOR_REVIEW` → `DONE` per release-coordinator's SHIP_READY proposal at `specs/002-pwa-catalog-bind-mount-fix/reviews/release-proposal.md`.

### supabase/ (local-only artifact, not committed)
- `supabase/functions/.env.local` — created by copying `.env.local.example` to satisfy the `dev:functions` env-file contract. Gitignored (per `/.gitignore` `.env.local` rule). Surfaced as Open Q2 above; no invented token values, used the documented pinned dev tokens from the example file.

### Local infrastructure (Docker container state — not in source tree)
- `supabase_edge_runtime_imr-inventory` — destroyed via `supabase stop --no-backup`, re-created via `supabase start`, then re-created a second time via `supabase functions serve --env-file ...` to populate `PWA_SERVICE_TOKEN`/`STAFF_SERVICE_TOKEN`. Final state: correct mount + correct env. Not source-controlled.
- `supabase_studio_imr-inventory` — incidentally cleared of its separate stale worktree mount during the same fix cycle. Surfaced in Build notes "Stale studio mount finding".
- All other `supabase_*_imr-inventory` containers — destroyed and re-created from migrations + seed by the same cycle. No data loss in any meaningful sense (local DB is reproducible by design).
