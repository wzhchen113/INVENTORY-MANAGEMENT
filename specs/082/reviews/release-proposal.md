# Release proposal — spec 082 (Users & access: "(email not loaded)" fix, Option A+B)

## Verdict
verdict: SHIP_READY
rationale: Zero Critical/High across all four reviewers, the lone should-fix (pgTAP arm-B invariant) and the actionable Low (anon-grant hardening) were both folded in and re-verified, and the latest test.yml + e2e.yml on main are green.

## What this ships

**The bug (prod-confirmed).** In the admin **Users & access** section, every REGISTERED (`status: 'active'`) user rendered "**(email not loaded)**" instead of their email (reported via prod screenshot — Bobby/admin and Charles/user). Root cause: `profiles` has no email column, so the section infers each email from `invitations`, but `fetchBrandAdmins` filtered the inference source `.eq('used', false)` — once a user registers their invite flips to `used = true` and drops out, leaving no row to match. This was NOT cosmetic: with `email = ''`, "**Reset PW**" bailed with "No email on file" for every registered user, and the DELETE confirmation lost the email.

**The A+B fix (backend / data-layer only — no frontend surface):**
- **A — `src/lib/db.ts` `fetchBrandAdmins`:** drop the `.eq('used', false)` filter so email-inference sources from ALL brand invitations; build the synthetic PENDING rows from a new `pendingInvites = invites.filter(!used)` subset so consumed invites never become phantom pending rows (existing `activeEmails` dedup preserved); rewrite the stale/false `:3266-3271` comment to match reality. The `inviteByProfileId ?? inviteByName` id-first precedence is unchanged.
- **B — migration `20260531000000_consume_invitation_sets_profile_id.sql`:** `CREATE OR REPLACE consume_invitation(uuid, text)` adding a single `profile_id = auth.uid()` to the UPDATE `SET` (byte-identical otherwise — same SECURITY DEFINER / `search_path = public` / null-guard / idempotency), plus a one-time idempotent backfill linking legacy `used = true` + sentinel-`profile_id` invites to registered profiles via `invitations.email → auth.users.email → auth.users.id (= profiles.id)`, sentinel-guarded and `exists`-joined to `public.profiles`.
- **Hardening folded in (security-auditor Low #1 + architect recommendation):** added `revoke execute on function public.consume_invitation(uuid, text) from public, anon;` right after the `grant … to authenticated`, matching the spec-005 anon-lockdown house standard (`20260505065303`). Pinned with a new pgTAP **arm E** using a catalog-query `has_function_privilege` check (deliberately NOT the spec-067-segfault `set role anon` pattern).

All reviewer items are resolved or consciously deferred (3 cosmetic nits). The migration is additive / non-destructive, re-runnable, and the one observable contract delta (the now-set `profile_id` on consume) needs no caller change.

## Findings summary
- **code-reviewer**: 0 Critical, 1 Should-fix, 3 Nits. Should-fix (pgTAP arm-B "profile_id-not-overwritten" unasserted) FIXED by test-engineer (`plan(7)→plan(8)`) — the invariant is now witnessed, not just mechanically argued. 3 Nits DEFERRED (cosmetic, none affect correctness): non-UUID `profile_id` strings in the jest fixture, an aging "0 expected on local" `raise notice`, and a pre-existing silent `invitesRes.error` swallow (out-of-scope hardening).
- **security-auditor**: 0 Critical / 0 High / 0 Medium, 2 Low. Low #1 (pre-existing PUBLIC/anon EXECUTE grant on `consume_invitation`) FIXED in the fix-pass via the revoke + arm E above. Low #2 (the new `profile_id = auth.uid()` write enabling a cosmetic email-mislabel) — NO ACTION: grants no access (link is a display-label map key only, not role/store), the grief vector is pre-existing and unchanged, and it is gated behind an unguessable UUID + matching email. `npm audit`: 17 vulns unchanged from baseline, **0 new** (no `package.json` change).
- **test-engineer**: PASS — all 7 acceptance criteria PASS. pgTAP 39/39 (the 082 file at 9 assertions incl. arm E), jest 402, tsc 0. Confirmed the fix is load-bearing: a USED invite now yields an email (would fail under the old `used=false` filter), and id-match beats name-match. Closed the arm-B gap. Two documentation gaps noted, both non-blocking and user-accepted: AC1's "verified against the local seed" clause is unsatisfiable (seed has zero invitation rows — verified via hermetic fixtures instead), and no Playwright E2E for the Reset-PW/DELETE buttons (spec marked optional; UI is a trivial downstream consumer of the now-tested `email` field).
- **backend-architect** (post-impl drift): **0 DRIFT** — all 6 checklist items PASS (consume_invitation byte-shape, the sentinel-guarded backfill predicate, the fetchBrandAdmins dual-array split, no scope creep, clean migration tail-append, test parity). Explicitly endorsed folding in the revoke (done), while drawing the boundary that sweeping OTHER RPCs for stray grants is a separate hardening spec.

## Recommended next steps (ordered)

SHIP_READY:

1. **Authorize the commit.** The commit is the user's to make (main Claude does not auto-commit on SHIP_READY). Suggested message in the established format: `Spec 082: Users section email-not-loaded fix — A+B + anon-grant hardening (SHIP_READY)`.

2. **PROD MIGRATION REQUIRED — this is NOT a Vercel-only deploy.** This spec adds `supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql`. After merge the user MUST run:

   ```
   npx supabase db push --linked
   ```

   The backfill runs at apply time and resolves EXISTING registered users' emails in one shot — the reported Bobby/Charles fix lands on apply, with no per-user action. Until pushed, the `db-migrations-applied` drift gate will flag the new local-only migration as missing from prod. Per CLAUDE.md, after the push confirm the latest `test.yml` run on `main` is green (`gh run list --branch main --limit 1`).

3. (optional, non-blocking) Follow-ups for a future housekeeping pass: the 3 deferred nits (jest fixture UUID shape, the migration `raise notice` wording, the `invitesRes.error` silent swallow) and a Playwright E2E exercising the Reset-PW / DELETE flow against a seeded registered user.

## Out of scope for this review
- **The bootstrap `super_admin` / any no-invitation account stays "(email not loaded)".** Documented out-of-scope per the user's explicit A+B choice (spec §9) — there is no invitation row to link, so neither A (name-match) nor B (`profile_id` link) can supply its email, and the backfill cannot help. The future path is **Option C** (an `email` column on `profiles`, backfilled from `auth.users` via a service-role/edge path and kept in sync on registration) — a separate, heavier spec.
- The pre-existing silent `invitesRes.error` swallow in `fetchBrandAdmins` (a latent footgun, one-line fix) — a separate hardening, flagged by code-reviewer as out-of-scope.
- Sweeping other SECURITY DEFINER RPCs for stray PUBLIC/anon grants — backend-architect explicitly scoped this as a separate audit spec, distinct from the in-scope fold-in (justified only because this migration already redefines `consume_invitation`).
- The sibling `fetchInvitationsForUserLookup` / `fetchAllUsers` and the BrandsSection members tab — already resolve emails correctly; verified read-only, not touched.

## Handoff
next_agent: NONE
prompt: SHIP_READY — spec 082 (Users-section email-not-loaded fix, A+B + anon-grant hardening). 0 Critical/High across all 4 reviewers; the lone should-fix (pgTAP arm-B invariant) and the actionable Low (revoke PUBLIC/anon on consume_invitation) were folded in and re-verified (pgTAP 39/39, jest 402, tsc 0); test.yml + e2e.yml green on main. PROD-MIGRATION REQUIRED: user must run `npx supabase db push --linked` post-merge (backfill resolves existing users at apply time — NOT a Vercel-only deploy). super_admin/no-invitation account stays "(email not loaded)" — user-accepted out-of-scope (Option C is the future path). Commit is the user's to authorize.
payload_paths:
  - specs/082/reviews/release-proposal.md
