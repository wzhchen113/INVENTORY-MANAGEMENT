## Code review for spec 198

Scope read: migration `20261110120000`, `send-invite-email`, `src/lib/inviteLink.ts`, the spec 198 hunks of `src/lib/auth.ts` (L354-543), `InviteLinkPanel.tsx`, `InviteUserDrawer.tsx`, `InviteAdminDrawer.tsx`, `RegisterScreen.tsx`, the `LoginScreen.tsx` effect, the jest files (`inviteUser`, `registerInvitedUser`, `sendInviteEmail.source`, `InviteAdminDrawer`, `LoginScreen.registerHandoff`, `RegisterScreen` and `InviteUserDrawer` titles), both e2e specs, and grep sweeps of the pgTAP files for stale references. I did not review the pgTAP bodies line by line (test-engineer owns coverage).

Convention checks that came back clean:
- No `supabase.from/rpc` outside `auth.ts` (a documented carve-out). The one remaining `from('stores')` read in `inviteUser` is the spec 090 defense-in-depth and is pinned by a test.
- The email is sent through `callEdgeFunction`, with no raw `fetch`.
- `escapeHtml` wraps both `inviteUrl` interpolations in the edge HTML, and the code is regex-gated before use.
- No inline hex or named colors in the new components; `useCmdColors` throughout. The hex values in `InviteAdminDrawer.test.tsx` are a jest theme mock, copied from the sibling test.
- No `Alert.alert` / `window.confirm`.
- `navigator.clipboard` is guarded by `typeof navigator`, and the copy button is `Platform.OS === 'web'` only. `LoginScreen`'s `window.location` use stays inside the web guard.
- Migration is pure ASCII (0 non-ASCII bytes), has `lock_timeout`, and has a fail-closed DO block.
- No new realtime channels, no deleted-legacy-file edits, no `app.json` change.
- i18n: the Cmd drawers and `RegisterScreen` are English-literal throughout the existing code, so the new copy matches the surrounding code. Not a finding.
- Dead callers: no live caller of `get_pending_invitation`, the zero-argument `register_invited_profile()`, or `consume_invitation` remains in `src/`, `e2e/` or `scripts/`. Only stale comments remain (below).

### Critical
None.

### Should-fix
- `src/components/cmd/InviteUserDrawer.tsx:166` — The comment still says the server derives the brand "in get_pending_invitation.resolved_brand_id (spec 069)". That function is dropped by this spec. The comment documents the invariant the line below it depends on, so a reader will go looking for a function that no longer exists. Point it at `create_invitation` step 5 (`coalesce(brand of store_ids[1])`), as `auth.ts:420` already does.
- `src/components/cmd/InviteLinkPanel.tsx:8-14, 118-120` with `src/lib/auth.ts:396-398, 457, 473` — `expiresAt` is read from the RPC, validated into a string, returned in `InviteUserResult`, and then dropped by both drawers (`IssuedInvite` has no field for it). The panel instead hard-codes "expires in 48 hours". That is a second copy of the server's `v_exp` constant. Either carry `expiresAt` into `IssuedInvite` and render it, or drop the field from `InviteUserResult` and the `inviteUser.test.ts` pins. As written it is dead data plus a drift risk. The copy would silently go wrong if the server interval changes.
- `supabase/tests/profiles_insert_hardening.test.sql:8, 17, 597` — The header and Section C banner still name `register_invited_profile()`. The zero-argument function no longer exists (K-6..K-11 were retargeted to `(text)`). Update the three comment lines to `register_invited_profile(text)`. The hunk ownership note (191 vs 198) allows this, since these lines are not in 191's listed hunks. Check line 8 against that list before staging.

### Nits
- `src/components/cmd/InviteLinkPanel.tsx:58` — The success toast always says "Link copied", while the same panel switches its noun to "code" when `link` is null. Today the copy button only shows on web, where a link normally exists, so this is unreachable. It is still inconsistent with `noun`. Use `` `${noun === 'link' ? 'Link' : 'Code'} copied` `` or share one string.
- `src/components/cmd/InviteLinkPanel.tsx:20-27` — `buildIssuedInviteLink` is a pure-ish helper (it reads `Platform`, `window` and `process.env`) that lives in a component file and is imported by two drawers. `src/lib/inviteLink.ts` already holds its siblings (`inviteLinkBase`, `buildInviteLink`) and is explicitly "no react-native imports", which is presumably why it sits here. Acceptable, but a small `src/lib/` wrapper would let the drawers stop importing from a component for non-UI logic. Leave if you prefer.
- `src/components/cmd/InviteUserDrawer.tsx:336-603` and `InviteAdminDrawer.tsx:245-...` — The `issued ? ... : (<ScrollView>...)` ternary leaves the whole form body un-reindented (`<ScrollView>` and children sit at the same depth as the `(`). That makes the diff small, but the closing `)}` at `:603` is easy to misread. Reindent, or extract the form into a `const form = ...` above the return so the return reads `{issued ? panel : form}`.
- `supabase/migrations/20261110120000_invitations_hardening.sql:39-49 vs 598-641` — The header lists `create_invitation` steps as 6 = delete, 7 = insert. The body numbers them 6 = username, 7 = generate, 8 = delete, 9 = insert, 10 = return. Align the header to the body (the body matches the design's section 3.1).
- `supabase/migrations/20261110120000_invitations_hardening.sql:214` — The clamp `UPDATE` is a single 150-character line inside a DO block, while everything around it is wrapped. Wrap it like the other statements.
- `supabase/migrations/20261110120000_invitations_hardening.sql:303-304, 354-355` — The SCOPE predicate is written out four times (and D7 three times). That is deliberate (text checks need to see it, and 191 did the same), so I am not asking for a helper. Just flag it for the next editor: a change to SCOPE has to land in all four policies plus the DO block's text checks.
- `e2e/invite.spec.ts:64` — `MASTER_USER_ID` is a hard-coded seed uuid in the spec. `e2e/fixtures/constants.ts` already holds the other seed ids (`SEED`); move it there so the claim spec and any future spec share one definition.
- `e2e/invite-claim.spec.ts:102, 146, 199` — `link.slice(-32)` is repeated three times. A tiny `codeOf(link)` helper (or have `inviteAndReadLink` return `{ link, code }`) would also remove the "valid format" magic number.
- `e2e/invite-claim.spec.ts:96-104` — `emailRequest` is created before the click and awaited only after the link assertion. If the `invite-link` assertion fails first, the pending promise is left un-awaited. Harmless in Playwright, but `await Promise.all([page.waitForRequest(...), click])` states the ordering more clearly.
- `src/lib/sendInviteEmail.source.test.ts:27, 31, 40, 43` — These pin exact source strings (including the whole `const inviteUrl = ...;` line and the `JSON.stringify({ error: ... })` call). A harmless reformat of the edge function (e.g. a line break or quote change) fails the test. That brittleness is the price of a source probe, and it follows the `authEmailHook` precedent. Consider loosening the first and third to regexes.
- `src/lib/auth.ts:533` — A claim failure after a successful `signUp` surfaces as "Account created but profile setup failed: no pending invitation". The user then cannot retry (their next `signUp` says already registered). The spec marks friendly error mapping out of scope, so I leave this only as a note for the follow-up.
- `src/lib/auth.ts:545-561` — `resendInvite` is the only remaining direct `invitations` read in the client (no callers, spec says leave). (out-of-scope) Its `.single()` read now returns 0 or 1 rows scoped by the new SELECT policy, so its semantics have changed silently.
- `supabase/tests/staff_brand_id_backfill.test.sql:57-71` and `profiles_username.test.sql:7` — The headers still describe retired arms in the present tense, below the "RETIRED (spec 198)" markers. Fine as history, but a one-line "(retired, spec 198)" on each header bullet would stop a reader counting them as live.
- (out-of-scope) `supabase/functions/send-invite-email/index.ts:108-116` — The `inviteUserByEmail` fallback validates `inviteCode` but never uses it, so the fallback mail sends the invitee to `?register=true` with no code. The spec records this as out of scope and as a Risk; noted only so it is not forgotten when mail is verified.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 3 Should-fix, 13 Nit.
payload_paths:
  - specs/198-invitations-hardening/reviews/code-reviewer.md
