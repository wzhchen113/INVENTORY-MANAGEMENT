# Security audit for spec 038

Scope reviewed: the `profiles.locale` write path, CHECK constraint
enforcement, `coerceLocale` defense-in-depth, i18n string substitution
attack surface, JSON catalog content, the `AuthResult.locale` envelope,
the logout reset path, the migration shape, and confirmation that no new
edge functions were introduced. No package.json changes — `npm audit` is
not blocked on this spec.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

- `src/store/useStore.ts:514-518` — Logout resets the in-memory `locale`
  slice to `'en'` but does NOT clear `LOCALE_KEY` (`'imr.locale'`) from
  `localStorage` / `AsyncStorage`. Impact: after a sign-out, the cached
  value persists on disk; if the user reloads the tab BEFORE the next
  sign-in, `readCachedLocaleSync()` at
  `App.tsx:74-81` re-hydrates the previous user's locale into the store,
  producing a flash of the previous user's chrome language on the login
  screen and during the period before `getSession()` resolves. Privacy
  cost: low — reveals only that a prior user preferred ES or zh-CN, no
  auth boundary crossed, no PII. The spec explicitly flagged this as the
  intended Low concern in focus-area #7. Fix: in `logout`, also call
  `try { localStorage.removeItem(LOCALE_KEY) } catch {}` and the
  AsyncStorage equivalent (best-effort, mirroring
  `clearActiveBrandLocal` at `src/store/useStore.ts:79-87`). Not blocking
  because (a) the leaked preference is non-sensitive, (b) `coerceLocale`
  + the post-`getSession` `hydrateLocale` call at `App.tsx:209`
  re-overrides the cached value as soon as the new user's session
  resolves, so the wrong-locale render window is one boot animation
  long.

- Pre-existing observation, not introduced by spec 038, but worth
  noting because spec 038 explicitly ratifies it as
  "no new policy needed" — `supabase/migrations/20260502071736_remote_schema.sql:417-422`
  defines `"Users can update own profile" ... USING ((id = auth.uid()))`
  with no column-scoped grants. This policy authorizes a user to UPDATE
  ANY column on their own row, not just `locale` / `dark_mode` /
  `sidebar_layout`. For `locale` specifically the impact is contained
  because the new `profiles_locale_check` CHECK constraint
  (`supabase/migrations/20260516000000_profiles_locale.sql:43-45`)
  rejects values outside `('en','es','zh-CN')` at the DB layer
  regardless of how the write arrives. So the CHECK is the binding
  constraint, not the RLS column scope. Locale is a user-preference
  column by design and should be self-writable. No action requested for
  spec 038; flagged purely so future specs that add new user-writable
  columns to `profiles` know to confirm the same posture (rely on a
  CHECK for value bounds rather than expecting the RLS policy to
  column-gate the write).

### Notes (informational; no fix required)

These were the focus areas the prompt asked about. Findings of "no
issue" are documented here so reviewers can see the evidence.

1. **`profiles.locale` write path** —
   `src/lib/db.ts:1291-1300` `saveLocale(userId, locale)` runs
   `supabase.from('profiles').update({ locale }).eq('id', userId)`.
   Properly scoped to `auth.uid()` by the existing "Users can update
   own profile" RLS policy (a cross-user write returns zero rows
   silently — the user cannot write another user's locale; this is
   covered by pgTAP test `(7)` at
   `supabase/tests/profiles_locale.test.sql:182-203`). Caller
   `src/store/useStore.ts:1947-1961` passes
   `get().currentUser?.id`, so even a tampered client cannot
   substitute another user's id — at the DB layer RLS would reject it
   anyway.

2. **CHECK constraint tightness** — pgTAP at
   `supabase/tests/profiles_locale.test.sql:101-124` covers both `'fr'`
   and `''` (empty string) and asserts SQLSTATE 23514. No way to
   inject via PostgREST encoding: PostgREST passes the literal string
   to the SQL parameter binder, which the CHECK then evaluates as a
   plain equality test against the enum. The constraint is
   `locale in ('en', 'es', 'zh-CN')` — a fixed allowlist, not a regex
   or LIKE — so encoding tricks (case, whitespace, NUL bytes, unicode
   normalization) all fail the comparison. The only way to bypass is
   to drop/redefine the constraint, which requires DDL privilege the
   `authenticated` role doesn't have.

3. **`coerceLocale` defense-in-depth** — `src/lib/auth.ts:48-50` is a
   strict allowlist: returns the input only if it is exactly `'es'`
   or `'zh-CN'`, otherwise `'en'`. Handles unknown values gracefully
   (a future fourth locale would be silently downgraded to `'en'` on
   an older client). Does NOT trust the input's shape — rejects
   objects, numbers, null, undefined, malformed strings. Strong
   defense-in-depth; matches the spec's focus area #3.

4. **i18n string substitution / XSS** —
   `src/i18n/index.ts:87-89` uses
   `value.replace(/\{(\w+)\}/g, (_m, name) => String(vars[name]))`.
   `\w+` only matches `[A-Za-z0-9_]+` so placeholder names are
   restricted to alphanumeric / underscore. The substitution output
   is a plain string fed to React Native `<Text>` (auto-escaped) or
   `accessibilityLabel` / `placeholder` props (string props, not HTML
   sinks). Grepped `src/` for `dangerouslySetInnerHTML`, `innerHTML`,
   and `WebView` — zero matches. Grepped for `eval`, `new Function`,
   `fromCharCode`, `createElement` with `T(...)` parameters — zero
   matches. There is no HTML rendering path for catalog strings on
   either platform.

5. **Catalog content** — `src/i18n/{en,es,zh-CN}.json` are pure data:
   nested objects with string leaves, no function values, no
   expression evaluation. Grepped all three files for `<script`,
   `javascript:`, `<iframe`, `<img`, `<svg`, `on*=`, `data:`,
   `vbscript:`, `<embed`, `<object` and for any `<`/`>` literal
   character — zero matches. The Spanish catalog's `"¿"` and the
   Chinese catalog's CJK characters render as ordinary UTF-8 strings.
   The catalog parity jest test
   (`src/i18n/i18n.test.ts:41-77`) additionally asserts every leaf is
   a `typeof === 'string'`, so a future PR introducing a non-string
   leaf (e.g. a stray `null` or array of fragments) fails CI before
   reaching `t()`.

6. **`AuthResult.locale` provenance** — `src/lib/auth.ts:80-127`
   `fetchProfile` reads `profile.locale` from
   `supabase.from('profiles').select('*').eq('id', userId).single()`,
   then runs it through `coerceLocale`. The query is gated by the
   "Users can read own profile" RLS policy
   (`supabase/migrations/20260502071736_remote_schema.sql:408-413`,
   `USING ((id = auth.uid()))`), so the row is fetched server-side
   under the caller's session — there is no cookie / header path
   that can inject a locale value. The login envelope's
   `result.locale` is therefore strictly server-derived.

7. **Logout reset** — see Low finding above. In-memory reset is
   correct; localStorage / AsyncStorage cache is not cleared. Spec
   explicitly accepted this as Low per focus area #7.

8. **Migration safety** —
   `supabase/migrations/20260516000000_profiles_locale.sql:34-45`
   does `add column if not exists locale text not null default 'en'`
   followed by drop-and-recreate of the CHECK constraint. In
   Postgres 11+ this is a metadata-only operation when the default
   is a non-volatile constant (which `'en'` is); the column gets a
   "fast default" stored once in `pg_attribute` and pre-existing
   tuples are not rewritten. PG 17 supports the same fast-default
   behavior. So no long lock on a busy `profiles` table is expected.
   The migration also explicitly does NOT add `profiles` to
   `supabase_realtime` (verified by grep on the migration file: only
   doc comments reference the publication), so the
   docker-restart-on-publication-change footgun from CLAUDE.md is
   not triggered.

9. **No new edge functions** — confirmed via
   `git status --porcelain | grep supabase/functions` (no matches).
   `supabase/config.toml` is unchanged. No new attack surface from
   edge functions in this spec. The `send-invite-email` HTML body
   escapeHtml convention is preserved as out-of-scope per spec body.

### Dependencies

No `package.json` changes — `npm audit` was not required by the
process. For information only: a pre-existing baseline run reports
11 vulnerabilities (5 low, 5 moderate, 1 high) across the existing
`expo` / `@expo/metro-config` / `postcss` / `dompurify` tree. None
are introduced by spec 038. None block this spec.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 2 Low (one a non-blocking localStorage cache cleanup on logout, one a pre-existing column-scope observation on the self-update RLS policy). Spec 038 ships clean from a security standpoint — the CHECK constraint, RLS policy reuse, coerceLocale defense, and the absence of HTML rendering surfaces for catalog strings are all sound. No edge functions, no new dependencies, no migration safety concerns.
payload_paths:
  - specs/038-multi-language-support-p1-chrome/reviews/security-auditor.md
