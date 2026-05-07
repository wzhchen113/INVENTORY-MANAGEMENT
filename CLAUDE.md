# Project: I.M.R (`imr-inventory`)

## What this is

Admin web/native app for the 2AM PROJECT restaurant brand — inventory, recipes, sales, and brand-catalog management for store managers. Sibling apps (staff app, customer PWA) live elsewhere; this repo only contains the admin surface. See [package.json](package.json), [app.json](app.json), [README.md](README.md).

## Stack

**Frontend**
- Expo SDK 54, React Native 0.81, react-native-web 0.21, React 19.1 — [package.json](package.json)
- TypeScript 5.3 strict — [tsconfig.json](tsconfig.json)
- Metro + Babel with `@/*` → `src/*` alias — [babel.config.js](babel.config.js), [metro.config.js](metro.config.js), [tsconfig.json:7](tsconfig.json)
- State: Zustand 4.5, single store at [src/store/useStore.ts](src/store/useStore.ts) (~51 KB)
- Routing: React Navigation 6 + custom desktop "Cmd" shell — [src/navigation/CmdNavigator.tsx](src/navigation/CmdNavigator.tsx), [src/navigation/AppNavigator.tsx](src/navigation/AppNavigator.tsx)
- CSV (PapaParse), charts (react-native-chart-kit + custom SVG), jsPDF export, expo-notifications + custom web-push at [src/lib/webPush.ts](src/lib/webPush.ts)

**Backend**
- Supabase JS 2.101, Postgres 17, Realtime, 10 Edge Functions on Deno 2 — [supabase/config.toml](supabase/config.toml), [supabase/functions/](supabase/functions/)
- Auth: Supabase email+password; admin role via JWT `app_metadata.role` checked by `auth_is_admin()`; per-store visibility via `auth_can_see_store()` — [supabase/migrations/20260504173035_per_store_rls_hardening.sql](supabase/migrations/20260504173035_per_store_rls_hardening.sql)

**Database**
- 30 timestamped migrations in [supabase/migrations/](supabase/migrations/), 2026-04-05 → 2026-05-05
- Init schema: [supabase/migrations/20260405000759_init_schema.sql](supabase/migrations/20260405000759_init_schema.sql)
- Brand-catalog refactor phases P1/P2/P3/P5 landed 2026-05-04
- [supabase/seed.sql](supabase/seed.sql) (286 KB) was pulled from prod 2026-05-02

**Deploy**
- Web → Vercel: `buildCommand: npx expo export --platform web` — [vercel.json](vercel.json)
- Native → EAS — [eas.json](eas.json)

## Project structure

```
App.tsx                       # Root; flips between legacy and Cmd UI based on flag
src/
  navigation/                 # AppNavigator (legacy) + CmdNavigator (new desktop shell)
  screens/
    cmd/sections/             # 14 desktop Cmd UI sections (current target)
    AdminScreens.tsx          # 104 KB legacy mega-screen (see Current state)
    InventoryListScreen / ItemDetailScreen  # mobile fallback under 1100 px
  store/                      # Zustand stores (see Open questions re: duplicates)
  lib/                        # db.ts (PostgREST/RPC), featureFlags.ts, webPush.ts, ...
  hooks/                      # useRealtimeSync, useRole, useColors, ...
  theme/                      # Light/Dark/Cmd palettes + token files
  utils/                      # confirmAction.ts (cross-platform), helpers
supabase/
  migrations/                 # 30 SQL migrations
  functions/                  # 10 Deno edge functions
  config.toml                 # per-function verify_jwt settings
scripts/                      # one-off ts-node + curl smoke scripts (no test runner)
```

## Conventions already in use

- **UI fork via env flag.** [App.tsx:117](App.tsx) selects `CmdNavigator` vs `AppNavigator` based on `EXPO_PUBLIC_NEW_UI` ([src/lib/featureFlags.ts:5](src/lib/featureFlags.ts)). Cmd UI is the active development target; legacy screens still ship.
- **DB access centralized.** All PostgREST/RPC traffic flows through [src/lib/db.ts](src/lib/db.ts) (~64 KB single file). snake_case → camelCase via local `mapItem`-style helpers.
- **Optimistic-then-revert + toast.** Backend errors surfaced via `notifyBackendError` ([src/store/useStore.ts:23](src/store/useStore.ts)) — `console.warn` + `react-native-toast-message`.
- **Realtime sync.** Debounced 400 ms reload across two channels (`store-{id}` + `brand-{id}`) — [src/hooks/useRealtimeSync.ts](src/hooks/useRealtimeSync.ts), wired from [src/navigation/CmdNavigator.tsx:87](src/navigation/CmdNavigator.tsx).
- **Role hook is a placeholder.** [src/hooks/useRole.ts](src/hooks/useRole.ts) returns `'admin'` for everyone — intentional because staff use a separate app.
- **Theming.** Token files under [src/theme/](src/theme/) with separate Light/Dark/Cmd palettes; hooks `useColors()` / `useCmdColors()`. Dark-mode pref cached in localStorage / AsyncStorage and synced to `profiles.dark_mode`.
- **Cross-platform confirm.** [src/utils/confirmAction.ts](src/utils/confirmAction.ts) routes to `window.confirm` on web vs `Alert.alert` on native.
- **Edge function auth split.** JWT-protected by default; `staff-*` and `pwa-catalog` set `verify_jwt = false` and validate a service-token bearer themselves — [supabase/config.toml:381](supabase/config.toml).
- **Imports.** `@/*` alias is configured but rarely used; the codebase mostly uses relative imports — inconsistent.

## Current state

**Built / live**
- Cmd UI desktop sections in [src/screens/cmd/sections/](src/screens/cmd/sections/)
- Per-store RLS hardening — [supabase/migrations/20260504173035_per_store_rls_hardening.sql](supabase/migrations/20260504173035_per_store_rls_hardening.sql)
- Brand-catalog refactor through phase P5 (migrations dated 2026-05-04)
- 10 edge functions in [supabase/functions/](supabase/functions/)

**Placeholder behavior (intentional)**
- [src/hooks/useRole.ts](src/hooks/useRole.ts) hardcodes `'admin'`.

**Gaps and unknowns**
- **No test framework.** No jest/vitest, no `*.test.*` files. Only [scripts/test-unit-conversion.ts](scripts/test-unit-conversion.ts) (one-off ts-node) and [scripts/smoke-edge.sh](scripts/smoke-edge.sh) (curl smoke test).
- **No CI workflow on disk.** [README.md](README.md) references `.github/workflows/db-migrations-applied.yml` but no `.github/` directory exists in the repo.
- **Empty placeholders.** [.claude/agents/_archive/](.claude/agents/_archive/), [specs/](specs/), and [.claude/worktrees/](.claude/worktrees/) are all empty.
- **Possibly-stale legacy data layer.** [db.json](db.json) (json-server seed), [src/store/useJsonServerSync.ts](src/store/useJsonServerSync.ts), and the `npm run db` script in [package.json](package.json) reference an abandoned data layer.
- **Two coexisting stores.** [src/store/useStore.ts](src/store/useStore.ts) (51 KB, live) and [src/store/useSupabaseStore.ts](src/store/useSupabaseStore.ts) (15 KB) — relationship unclear.
- **Large legacy file.** [src/screens/AdminScreens.tsx](src/screens/AdminScreens.tsx) is 104 KB single-file (legacy UI). Flagged for size, not a defect.
- **Identity drift.** [app.json](app.json) `slug` is `towson-inventory` while [package.json](package.json) name and brand are `imr-inventory` / "2AM PROJECT".
- **Stray asset.** `2AM_Project_Menu_Ingredients.xlsx` (19 KB) sits at repo root, not referenced by code.

## Agent workflow

This project uses 10 subagents in `.claude/agents/`. Claude Code blocks nested subagent delegation, so **main Claude is always the dispatcher**. Each subagent ends its turn with a *handoff payload* recommending the next agent; main Claude reads the payload and makes the next call.

### Agents

**Specialists** (do the work, mutate the spec's `Status:` field):
- `product-manager` — writes the spec from a feature request
- `backend-architect` — designs the contract (and post-impl, reviews drift)
- `backend-developer` — implements backend
- `frontend-developer` — implements frontend
- `code-reviewer` — reviews for quality
- `security-auditor` — reviews for vulnerabilities
- `test-engineer` — reviews coverage and acceptance criteria
- `release-coordinator` — synthesizes reviewer findings into a single proposal

**Routing layer** (advisory, never mutate `Status:`):
- `workflow-orchestrator` — drafts the next routing decision
- `workflow-auditor` — APPROVE / REVISE / REJECT verdict on the draft

### Topology

```
user ──▶ main Claude ──▶ subagent ──▶ main Claude ──▶ user
              ▲                            │
              └─────── handoff payload ────┘
```

Subagents never call each other.

### Typical pipeline

```
product-manager
  │
  ▼
backend-architect  (design mode)
  │
  ▼
backend-developer + frontend-developer            (parallel)
  │
  ▼
code-reviewer + security-auditor + test-engineer  (parallel fan-out)
  + backend-architect (post-impl mode)
  │  findings written to specs/<spec>/reviews/<reviewer>.md
  ▼
release-coordinator
  │  proposal written to specs/<spec>/reviews/release-proposal.md
  ▼
user decides
```

### Handoff payload format

```
## Handoff
next_agent: <agent-name | comma-separated | NONE>
prompt: <one short paragraph drafting what to ask next>
payload_paths:
  - <relevant paths>
```

`NONE` returns control to the user. Comma-separated names trigger parallel dispatch.

### Recommended-next table

| Agent                                            | Recommends                                                                       | When                                                                          |
|--------------------------------------------------|----------------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| product-manager                                  | backend-architect                                                                | After setting `Status: READY_FOR_ARCH`. Returns NONE if status stays DRAFT.   |
| backend-architect (design)                       | backend-developer, frontend-developer (one or both)                              | After setting `Status: READY_FOR_BUILD`.                                      |
| backend-architect (post-impl)                    | NONE                                                                             | Findings to `specs/<spec>/reviews/backend-architect.md`.                      |
| backend-developer                                | code-reviewer, security-auditor, test-engineer, backend-architect (post-impl)    | After setting `Status: READY_FOR_REVIEW`.                                     |
| frontend-developer                               | code-reviewer, security-auditor, test-engineer (+ architect if backend changed)  | Same.                                                                         |
| code-reviewer / security-auditor / test-engineer | NONE                                                                             | Findings to `specs/<spec>/reviews/<name>.md`.                                 |
| release-coordinator                              | NONE                                                                             | Proposal at `specs/<spec>/reviews/release-proposal.md`.                       |
| workflow-orchestrator                            | workflow-auditor                                                                 | Output is a *draft*; auditor must APPROVE before main Claude acts on it.      |
| workflow-auditor                                 | (verdict — APPROVE / REVISE / REJECT)                                            | Read-only.                                                                    |

### Spec status state machine

```
(no spec) ─[user request]─▶
DRAFT ─[PM resolves open questions]─▶
READY_FOR_ARCH ─[architect produces design]─▶
READY_FOR_BUILD ─[dev(s) implement]─▶
READY_FOR_REVIEW ─[reviewers + release-coordinator]─▶ user
```

Only specialists write `Status:`. The routing layer reads it and routes — never writes.

### Routing layer (non-linear cases)

For mid-pipeline ambiguity, ad-hoc requests, or redo decisions, main Claude dispatches `workflow-orchestrator`. The orchestrator returns a draft routing decision. Main Claude then dispatches `workflow-auditor` on the draft.

- APPROVE → main Claude dispatches the recommended specialist.
- REVISE → orchestrator revises and main Claude re-dispatches the auditor. Cap at 2 revisions, then escalate to user.
- REJECT → return to user with the rejection reason.

Ad-hoc work that doesn't belong in the pipeline gets `next_agent: NONE` from the orchestrator and main Claude handles it directly.

### Hard rules

- `release-coordinator` cannot recommend SHIP_READY if **any** reviewer flagged a Critical (security, broken acceptance criteria, contract drift, broken build).
- `release-coordinator` reads the actual reviewer files in `specs/<spec>/reviews/`, not second-hand summaries.
- Reviewer findings are advisory. The decision to redo work is the user's, informed by `release-coordinator`'s proposal.
- Main Claude does not auto-commit on SHIP_READY. The user confirms the commit.


## Resolved questions / project context

These were open questions during the initial audit. Answers below are now project policy.

### CI workflow
The `.github/workflows/db-migrations-applied.yml` workflow referenced in README was meant to be added but couldn't be pushed due to a `workflow`-scoped token permission issue. Status: pending re-push when token is updated. Agents: do not assume this CI gate is currently running. If working on database migrations, manually verify migrations are applied — don't rely on automation.

### Data layer (active vs. legacy)
**Active:** Supabase is the data layer. `src/store/useStore.ts` is the current store.

**Legacy — do not modify:**
- `src/store/useSupabaseStore.ts`
- `src/store/useJsonServerSync.ts`
- `db.json`
- The `npm run db` script in `package.json`

These are kept for reference only and will be deleted after the project is complete. Agents should never modify these files. New features go in `useStore.ts`.

### Codebase-auditor agent
One-time use. Moved to `.claude/agents/_archive/` immediately after this CLAUDE.md was committed.

### Empty directories
- `specs/` — placeholder for feature specs the `product-manager` agent will produce. See Agent workflow section.
- `.claude/worktrees/` — auto-managed by Claude Code when worktree mode is enabled. Currently we work directly on `main`. This directory should be in `.gitignore` and agents should never commit anything inside it.

### Legacy admin screens
`src/screens/AdminScreens.tsx` (104 KB) is legacy. It will be removed when `EXPO_PUBLIC_NEW_UI` becomes default — target: next month, when the new UI directory stabilizes.

**Agents must NOT add new functionality to this file.** New admin screens go in the new UI directory. If a task seems to require modifying `AdminScreens.tsx`, surface as a question first.

### Repo-root spreadsheet
`2AM_Project_Menu_Ingredients.xlsx` is an outdated reference document from before the inventory database existed. To be moved to `/docs/archive/` or removed in a future cleanup pass. Not used by code. Agents should not modify it.

### app.json slug mismatch (DO NOT AUTO-FIX)
`app.json` has `slug: towson-inventory` from the project's original name. The package and brand are now `imr-inventory` / "2AM PROJECT". The `app.json` slug was never updated.

**Agents must NOT change the `app.json` slug without explicit user approval.** This value may be load-bearing for EAS builds, app store identifiers, or push notification certificates. Surface any need to change it as an open question first.

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
