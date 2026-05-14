# Code review for spec 028

Spec: `specs/028-email-html-escape/spec.md`
Files reviewed:
- `supabase/functions/send-invite-email/index.ts`
- `supabase/functions/send-welcome-email/index.ts`
- `src/utils/escapeHtml.ts`
- `src/utils/escapeHtml.test.ts`
- `scripts/smoke-edge-roles.sh`
- `CLAUDE.md`
- `.claude/agents/security-auditor.md`

### Critical

None.

### Should-fix

None.

### Nits

- `scripts/smoke-edge-roles.sh:1-6` — The script's top-of-file description still reads "Spec 027 smoke for the send-invite-email role gate." after Arm 5 (spec 028) was appended. A future reader skimming the header won't know spec 028 extended this script. The Arm 5 block comment at line 255 is self-documenting, but the file-level one-line description at line 2 could say "Spec 027 + 028 smoke for the send-invite-email role gate and HTML-escape behavior." Cosmetic only.

- `scripts/smoke-edge-roles.sh:274` — `PAYLOAD` is constructed via `printf` interpolating `$ESCAPE_EMAIL` directly into a JSON literal rather than using `jq`. This works today because `$ESCAPE_EMAIL` is `escape-test-${RANDOM}@local.test` — `$RANDOM` is always an integer, so no characters requiring JSON-escaping are possible. The concern is forward-drift: if someone changes the email prefix to something containing a double-quote, the JSON would silently break. The sibling Arms 3 and 4 use `printf` for the login payload in the same pattern, so this is consistent with existing convention. Not a correctness issue given `$RANDOM`'s integer guarantee — flagged for awareness only.

- `src/utils/escapeHtml.test.ts:27-33` — The first `it` block groups all five character-entity mappings into a single test case with five `expect` calls. The spec AC C2(a) explicitly says "five separate `expect` calls, one per character" — this matches the requirement as written. Noting it as a stylistic observation: the five mappings are logically the same contract and grouping them is reasonable, but if this `it` case fails, the test output will not identify which of the five characters caused the failure (Jest stops at the first failing `expect` within an `it`). Splitting into five separate `it` calls would give finer-grained failure messages. Low priority given this is a pure-function escape test where all five characters are exercised together in the attack-payload cases anyway.

- `supabase/functions/send-invite-email/index.ts:44` and `supabase/functions/send-welcome-email/index.ts:44` — The `escapeHtml` function body is a single long line with five chained `.replace()` calls. This is intentional per the spec design (one-line body makes byte-identical diff trivial) and is explicitly called out in the architect design. Noted only so future maintainers don't reformat it for style — reformatting would invalidate the diff-one-liner reviewer check and force a manual line-by-line comparison to confirm the five-char escape is intact.
