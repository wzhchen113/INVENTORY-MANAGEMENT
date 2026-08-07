# Release proposal — spec 152: session loss must be honest

## Verdict

verdict: SHIP_READY
rationale: Zero Criticals across all three reviews, every Medium/Should-fix/test-gap from the round is applied and verified in the staged tree, and the two remaining items are explicitly owner-decisions (a CLAUDE.md line and a product call), not defects.

## Findings summary

- **code-reviewer** — 0 Critical, 3 Should-fix, 4 Nits. Top issues: (1) spec-063 slice-isolation erosion — `sessionWatch.ts` statically imported both stores while staff `Settings.tsx` imported from it; (2) `handleSessionLost`'s JSDoc claimed a single caller while `SessionLostBanner` is a second one; (3) the new probe sat unbounded in front of every load including each 400 ms realtime reload. Explicitly endorsed the fail-open probe design and the `markIntentionalSignOut()`-before-`signOut()` ordering as race-free, and confirmed a single subscription install with correct effect cleanup.
- **security-auditor** — 0 Critical, 0 High, 3 Medium, 4 Low. Top issues: M1 identity change undetected (auth-js `BroadcastChannel` replay leaves tab 1 rendering A's shell on B's JWT — bounded by RLS, so UI-truth not leak); M2 the bail lands after two awaits and could arm a false banner over the *next* session, whose primary button force-ejects a legitimate user; M3 the intentional-sign-out marker stays armed for the tab's lifetime when `signOut()` fails on a non-401/404/403; plus the data slices surviving both teardown paths. Clean on the axes that matter for a deploy: no token/session material logged or persisted, `sessionLost` is in-memory only, no new env vars or network surface, no RLS/grant/RPC/edge-function change, and nothing in the diff is used as an authorization decision.
- **test-engineer** — all 13 original ACs PASS (AC-1…AC-10, AC-REG1…AC-REG3), none FAIL or NOT TESTED; typecheck + `typecheck:test` clean; full jest green. One real gap flagged: AC-4's two call sites were wired but the *ordering* relative to `signOut()` was unpinned, so a refactor that reordered them would go uncaught.
- **backend-architect** — not invoked. Correct: frontend-only diff, no migration, no edge function, no contract surface to drift against (independently corroborated by both other reviewers' zero-diff checks on `src/hooks/`, `storeVisibility.ts`, and the whole `supabase/` tree).

### Fix-round verification (read against the staged tree, not taken on trust)

| finding | verified at |
|---|---|
| security M1 — identity change | `src/lib/sessionWatch.ts:148-182` `handleAuthEvent` treats `nextUserId !== current` as affected and reasons `'switched'`; distinct copy `chrome.sessionSwitched` present in all six catalogs (`src/i18n/{en,es,zh-CN}.json:164`, `src/screens/staff/i18n/{en,es,zh-CN}.json:446`); the flag is consumed only inside `if (isLoss)`, so an identity change is never suppressed |
| security M2 — stale bail | `src/store/useStore.ts:1723` captures `owner` before the probe, `:1739` `if ((get().currentUser?.id ?? null) !== owner) return;` fires **before** the `set()`; `login()` adds `sessionLost: false` at `:1135` |
| security M3 — stuck marker | `clearIntentionalSignOut()` exported at `sessionWatch.ts:109`, called on `logout()`'s `signOut()` rejection (`useStore.ts:1224-1226`), on staff `Settings.tsx:103`, and on `login()` (`useStore.ts:1140-1142`); consumed on any null-session event at `sessionWatch.ts:170-171` |
| security Medium — data slices | `SIGNED_OUT_DATA_RESET` at `useStore.ts:937-971`, applied by `logout()` (`:1205`) and `handleSessionLost()` (`:1243`); preferences deliberately excluded |
| code SF — spec-063 seam | `sessionWatch.ts` imports only `./supabase` — no store, no i18n; surfaces register from `App.tsx:363-402` (admin first = announcement priority), unregistered in the same effect's cleanup |
| code SF — unbounded probe | `SESSION_PROBE_TIMEOUT_MS = 4000` + `withProbeTimeout` race that resolves `true` and always clears its timer (`useStore.ts:975-998`), wired at `:1727` |
| test gap — call-site order | `invocationCallOrder` pins in `useStore.sessionLoss.spec152.test.ts:334-335` (admin) and `Settings.test.tsx:160-163` (staff, incl. "clean sign-out leaves the marker armed") |

Every applied fix is present, correctly ordered relative to its side effect, and matches what the spec's review-round table claims. No fix introduced a new finding on re-read.

### Verification caveat (non-blocking, worth one line to the owner)

The three reviewer files were written **before** the fix round; test-engineer's transcript shows the pre-fix run (192 suites / 1960 tests). The post-fix gate evidence (192 / 1979, both typechecks clean, live repro re-verified including the identity-switch tab teardown) is the developer's own, not independently re-reviewed. Given the diff is frontend-only and the fixes are statically verified above, a fresh `npx tsc --noEmit && npm run typecheck:test && npx jest` immediately before the commit is sufficient re-confirmation — that is step 1 below, per the project's "run full jest before commit" rule.

## Recommended next steps (ordered)

1. **Re-run the local gates on the final tree** — `npx tsc --noEmit`, `npm run typecheck:test`, full `npx jest` (not a subset). Expect 192 suites / 1979 tests.
2. **Stage and commit.** Frontend-only: no `supabase db push`, no `supabase functions deploy`. Suggested subject: `Honest session loss: auth watcher, load-time session probe, signed-out indicator (spec 152)`.
3. **Push to `main`.** Vercel builds on push; that is the entire deploy.
4. **Confirm both CI gates green after the push** — `gh run list --branch main --workflow test.yml --limit 1` and `gh run list --branch main --workflow db-migrations-applied.yml --limit 1`. The migrations gate should be unchanged from the 1e7a6c0 baseline (no migration in this diff); if it is red, that is pre-existing drift, not spec 152, and should be diffed repo-vs-`schema_migrations` before anything else.
5. **Prod smoke (2 minutes, no fixture needed).** Sign in, confirm the chrome dot still reads `connected`; press sign out and confirm the sign-in screen appears with **no** "Session expired" toast (AC-4, the one path every user hits daily and the only regression risk in the deliberate flow).

Optional follow-ups, not blocking ship:

- `SIGNED_OUT_DATA_RESET` omits `recipeCategories` / `ingredientCategories`, which hold brand-catalog display names rather than the `create()` English defaults after a load. Category *names* from the previous brand can survive a sign-out for the window before the next load resolves. Strictly smaller than the rows the reset does clear, and no PII — fold into a future hygiene pass if it ever surfaces.
- code-reviewer's nit about the `handleSessionLost` doc comment is resolved, but the module-header cross-reference in `sessionWatch.ts:35-38` now carries the CLAUDE.md carve-out rationale in code only — see the first out-of-scope item below.

## Out of scope for this review

- **CLAUDE.md carve-out line for `sessionWatch.ts`** (code-reviewer nit, deferred in the spec). `onAuthStateChange` is auth-client plumbing, not PostgREST/RPC, so the documented rule's letter doesn't require the entry; the rationale currently lives in the module header. Editing CLAUDE.md is the owner's call, not an agent's — surfacing as a question, not doing it.
- **Auto-eject after N consecutive bails** (security-auditor Low). A dead session with no auth event ever arriving can sit on a populated screen indefinitely; the banner plus the signed-out indicator make that visible and honest, which is this spec's charter. Escalating to a forced bounce on a timer is a product decision — needs its own spec.
- **Staff EOD read paths** (code-reviewer, out-of-scope by their own framing). The staff screens' direct `supabase.rpc` reads were never audited for the same "RLS-empty silently replaces good data" shape. The incident was an admin/super_admin session and this spec deliberately scoped part 2 to `loadFromSupabase`. Follow-up spec.
- **Why the owner's token died** (spec non-goal). Multi-tab refresh-token rotation is the leading candidate; spec 152 makes the failure self-describing regardless of trigger. If it recurs post-deploy, the new toast copy distinguishes "expired" from "switched" and should narrow it immediately.
- **`app.json` slug**, untouched and must stay that way.
