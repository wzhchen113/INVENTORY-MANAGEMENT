## Code review for spec 163

Scope: migration `20261008000000_get_profile_emails.sql`, pgTAP `get_profile_emails.test.sql`, `src/lib/db.ts` (`fetchProfileEmails`, `fetchBrandAdmins`), `src/lib/auth.ts` (`fetchAllUsers`), the three jest files, and the staged `UsersSection.tsx` identity-line change.

I could only read the files, not run `git diff`, so the staged `UsersSection.tsx` change was reviewed by reading the current file at lines 373-378. I ran no tests. Security of the definer function's predicate is deferred to security-auditor. Structural drift is deferred to the architect.

Project-policy checks, all clean:
- The only `supabase.rpc('get_profile_emails')` call site is `db.ts:252`.
- No legacy-file edits.
- No `app.json` change.
- No inline colors.
- No web-only APIs.
- No new realtime channels.
- No new test-file pattern: jest and pgTAP only, in the established tracks.
- The migration uses `begin;`/`commit;`, which matches sibling migrations.

### Critical
None.

### Should-fix
- `src/lib/auth.ts:655-657` — The spec-163 comment ("auth.users emails … win; the invitation inference below is the fallback") floats alone between the `Promise.all` and the "Cleanup #4" comment. It documents no code of its own, and the precedence expression it describes is 28 lines down at line 683. It also leaves two adjacent comment blocks. Delete it and put the one-line pointer on the `email:` line at 683, as `db.ts:5511` already does.
- `src/lib/auth.ts:641-649` — This comment still describes the invitation lookup as the email-inference mechanism ("Pull invitation rows for email inference"). It now sits directly above a `Promise.all` that also awaits the RPC result. Reword the lead-in to say the invitations are the fallback source, so a reader does not take the RPC to be an afterthought of this block.

### Nits
- `src/lib/db.ts:5479-5484` — "profiles has no email column; we infer each user's email from the invitation row that registered them" is now only half true. Inference is the fallback after the RPC. Add "(fallback; spec 163)" or a similar qualifier.
- `src/lib/db.ts:5525-5531` — The "active rows finally have emails to dedup against" comment predates the RPC. Dedup now runs against the resolved auth.users emails, and that is the expected behavior change the spec calls out. A one-clause update would help the next reader.
- `src/lib/auth.ts:618-625` and `src/lib/db.ts:5460-5467` — The `safeProfileEmails` wrapper is duplicated verbatim apart from the log prefix. The spec explicitly chose inline over a shared helper (§5), so this is not a defect. If a third consumer appears, extract it. Both copies type the catch as `catch (e: any)`; `unknown` plus a narrow would be cleaner, but `any` matches the surrounding code.
- `src/lib/db.fetchBrandAdmins.test.ts:425` — `expect(Toast.show).not.toHaveBeenCalled()` can never fail. `db.ts` has no `react-native-toast-message` import, so the assertion proves nothing. The `jest.mock` and import at lines 85-90 add noise for a vacuous check. Either drop both or assert on something observable. The same assertion in `auth.fetchAllUsers.test.ts:245` and `:268` is slightly more meaningful, since `auth.ts` does reference Toast.
- `supabase/tests/get_profile_emails.test.sql:140` — Arm 3 matches the literal `'search_path=public, auth'`. That depends on Postgres's `proconfig` string formatting (comma plus space). It passed locally, so it is fine today. A looser check such as `proconfig::text ~ 'search_path'` plus a separate content assertion would survive a formatting change.
- `supabase/tests/get_profile_emails.test.sql:182-266` — The arms are not executed in numeric order: arms 17 and 18 run before 14 and 15, because they are grouped by principal. The header documents this. The "planned N but ran M" detector is unaffected. It is only a skim-reading cost.
- `src/screens/cmd/sections/UsersSection.tsx:376` — The literal `'(email not loaded)'` is hardcoded English. The sibling `PhoneUsers.tsx:135` and `:228` use `T('section.users.phone.noEmail')`, which maps to the same string in `en.json:1503`. The same literal also appears in `BrandsSection.tsx:972`. The spec says to keep this line unchanged, so (out-of-scope) it is a candidate for a later i18n pass. It is already on the CLAUDE.md memory backlog as part of the "InventoryCountSection i18n pass" family.
- `supabase/migrations/20261008000000_get_profile_emails.sql:49-53` — The inline `--` comments inside the `$$` body become part of `pg_get_functiondef`. That is harmless, and the normalized-md5 rollout check compares the same text. It does mean any later whitespace or comment edit to the body changes the prod-verification hash. Keep the repo copy and the MCP copy byte-identical.
- The pgTAP file has no assertion that `service_role` gets zero rows. The migration comment justifies this by saying `auth_is_privileged()` is false without a JWT. It is a one-arm add if the security-auditor wants it. I am not asking for it here, because it would change the spec's `plan(18)`.

### Verified correct (no action)
- `fetchProfileEmails` (`db.ts:247-261`) dedupes ids, short-circuits on empty input without a network call, uses `track(kind:'read')`, threads `abortSignal`, and throws on error. It skips falsy emails. The signature and behavior match the spec.
- Precedence is identical in both consumers (`rpc || profile_id invite || name invite || ''`), as the spec requires. Pending rows still use `inv.email`.
- `fetchAllUsers` starts the RPC before `user_stores` and the brand-store read. `safeProfileEmails` can never reject, so there is no unhandled-rejection risk if a later await throws into the outer `catch { return [] }`.
- The `async` try/await wrapper correctly turns a synchronous throw from an un-mocked export into a caught rejection. The two sync-throw jest cases pin this.
- All five required mock files and cases are present. `auth.signIn.test.ts` adds `fetchProfileEmails: jest.fn()` to the explicit `./db` mock.
- The staged `UsersSection.tsx:373-378` logic matches the spec's `@username · email · shortId` rule. "(email not loaded)" shows only when there is neither a username nor an email. The spec 163 changes do not touch the file, as required.
