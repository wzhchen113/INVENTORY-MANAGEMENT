# Security audit for spec 039

Scope: P2 curated enum / category labels. Frontend-only, additive.
Catalog JSON, two new pure-function modules (`matchesQuery`,
`enumLabels`), and ~20 call-site rewires. No DB / RLS / edge function
/ migration / `package.json` changes. Attack surface is effectively
zero; this audit verifies that surface stayed zero.

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None.

### Medium

None.

### Low

None.

### Notes (informational only, not findings)

The following items were specifically checked per the focus areas and
came back clean — recorded so the release-coordinator can see what was
exercised:

1. **Catalog content (focus #1)** — `src/i18n/{en,es,zh-CN}.json`. The
   three catalogs were scanned end-to-end for `<script>`, `javascript:`,
   `on[a-z]+=`, HTML tags, template-injection markers, and embedded
   URLs in the new `enum.*` namespace. Pure plain-text labels only
   (Latin / Spanish accented Latin / CJK ideographs / Hanzi). Three
   placeholder-style strings exist in the catalog (`{itemCount}`,
   `{totalItems}`, `{count}`, etc.) but they live in the pre-existing
   `section.*` / `toast.*` / `chrome.*` blocks, not in the new
   `enum.*` additions. The `enum.*` namespace contains zero `{var}`
   placeholders — all values are constant strings. Even if a hostile
   translator landed `<script>` in a future catalog edit, React
   Native's `<Text>` does not interpret HTML; the string would render
   verbatim. No XSS surface from catalog data on RN, and the web build
   (`react-native-web`) also escapes by default through React's text
   children handling.

2. **`matchesQuery` ReDoS resistance (focus #2)** —
   `src/i18n/matchesQuery.ts:36`. The single regex `/\p{Diacritic}/gu`
   is a Unicode-property *character class*. There is no alternation,
   no capturing group, no nested quantifier, no backreference — a
   character-class-only pattern is linear in input length by
   construction (no backtracking is possible). Empirically verified
   with five pathological inputs (10,000 chars each — all bare letters,
   all combining marks, all precomposed accented chars, alternating
   marks, deep stacking) — each completes in <1ms. The query string
   is not used as a regex pattern anywhere (`includes()` is a substring
   call, not a `RegExp` constructor). No DoS surface.

3. **`matchesQuery` empty-query semantics (focus #2)** — line 29 returns
   `true` for an empty / whitespace-only query (matches everything).
   This is the intended UX shape and is not a security issue — it
   does not over-disclose data because the underlying row set is
   already RLS-filtered server-side and the caller already had access
   to render the unfiltered list.

4. **`matchesQuery` null/undefined candidate handling (focus #2)** —
   line 34 (`(s ?? '')`) coerces null/undefined to empty string before
   `.normalize()`, preventing a `TypeError` on a malformed candidate
   array. Tested in `src/utils/enumLabels.test.ts:257`.

5. **`formatAuditAction` graceful fallback (focus #3)** —
   `src/utils/formatAuditAction.ts:36`. The `KEY_BY_ACTION` lookup
   returns `undefined` for any unknown action; the fallback path
   `event.action.toLowerCase()` renders the raw English canonical
   *lowercased* — not the localized form, but no `undefined` dump, no
   dot-path leak. Data-flow check: `audit_log.action` is server-derived
   (inserts in `src/store/useStore.ts:998+` use literal strings from
   the closed TS union `AuditAction` defined in
   `src/types/index.ts:381`). The audit log is not a free-text user-
   input column. Even if a hostile insert path were discovered
   server-side (out of scope of this spec), the fallback renders
   through React Native `<Text>` which does not interpret HTML — no
   XSS regression. Same fallback shape applies to `wasteReasonLabel`
   (`enumLabels.ts:46`), `wasteReasonShortLabel` (line 51), `roleLabel`
   (line 64), `inventoryCountKindLabel` / sub (lines 77/82),
   `dayOfWeekShortLabel` / long (lines 106/111), `unitLabel`
   (line 138). All return either the lookup result or the raw input
   coerced to a safe string, never `undefined` or a JSON path.

6. **Test mock fidelity (focus #4)** —
   `src/components/cmd/StatusPill.test.tsx:41-51`. The mocked `useT`
   returns the exact strings the real English catalog returns for the
   four `enum.itemStatus.*` keys (`OK / LOW / OUT / INFO`); for any
   other key it returns the key string back. This mirrors the real
   `t()` missing-key behavior in `src/i18n/index.ts:74` (returns key
   path). The mock cannot mask a production bug because (a) the only
   keys StatusPill ever looks up are the four status enums, all
   present in the real catalog (verified — `en.json:405-410`,
   `es.json:405-410`, `zh-CN.json:405-410`), and (b) the parity test
   in `src/i18n/i18n.test.ts:41` guarantees those keys exist in all
   three locales. Bypass risk: none.

7. **Old key call-sites (focus #5)** — Grep over `src/` for
   `T('role.…)` and `T('status.…)` patterns (the deleted top-level
   keys) returns ZERO matches. Verified via
   `grep -rEn "['\"]role\.(user|admin|master|superAdmin)['\"]|['\"]status\.(good|low|out|expired)['\"]" src/`
   — empty. The collapse from `status.*` / `role.*` (spec 038) into
   `enum.itemStatus.*` / `enum.role.*` (spec 039) is clean; no silent
   English-via-fallback regression on the locale switcher. The two
   `"status"` keys still in the catalogs (`common.status`,
   `section.eod.submitted`) and the `"role"` key inside the new
   `enum.role` block are unrelated.

8. **No new dependencies (focus #6)** — `git status` confirms
   `package.json` and `package-lock.json` are not modified in this
   spec's working tree. Neither file appears in the `## Files changed`
   manifest. No new imports of any package outside the existing
   dependency set in the new files (`enumLabels.ts` imports only from
   `../types`; `matchesQuery.ts` imports nothing). No new attack
   surface from dependency-tree changes.

9. **Data-flow / DB unchanged** — No table touched, no migration, no
   RLS policy, no edge function, no `src/lib/db.ts` mapper change.
   Per-store RLS hardening (spec 026) and per-store `auth_can_see_store`
   model continue to apply unchanged. The translation is purely a
   display-side transform applied AFTER PostgREST returns rows — it
   does not affect what rows the caller sees or what columns are
   readable. The spec's "DB column stays English canonical" rule is
   honored in every modified file.

10. **No PII / secret leakage surface** — The new code paths handle
    enum strings (status / reason / role / kind / unit / day-of-week)
    only. No user names, no email addresses, no profile data, no token
    material flows through `enumLabels` or `matchesQuery`. The
    `console.warn` machinery in `src/i18n/index.ts` logs only catalog
    key paths (the second arg of `t()`), never the values, never user
    input, never row data — safe.

11. **JSON deserialization** — The three catalog files are imported as
    static JSON modules at build time via Metro's JSON support
    (`import en from './en.json'`). No runtime `JSON.parse` of
    untrusted input. The dot-path walk in `src/i18n/index.ts:39`
    iterates over a finite key splitting the literal key argument; no
    prototype-pollution surface because the walk uses bracket access
    `(cur as Record<string, unknown>)[seg]` without copying or
    merging, and returns only on `typeof cur === 'string'` leaves.

### Dependencies

`npm audit --audit-level=high` — **11 vulnerabilities (5 low, 5
moderate, 1 high).** Identical baseline to spec 038's audit run
(verified against
`specs/038-multi-language-support-p1-chrome/reviews/security-auditor.md`).
No new vulnerabilities introduced by this spec.

| Severity | Package | Path |
|----------|---------|------|
| high | `@xmldom/xmldom` | (transitive) |
| moderate | `dompurify` | (transitive) |
| moderate | `postcss` → `@expo/metro-config` → `@expo/cli` → `expo` | dev-time |
| moderate | `jsdom` → `jest-environment-jsdom` → `jest-expo` | dev-time |
| low | `@tootallnate/once` | (transitive via http-proxy-agent) |

All inherited from `expo` 54.x and `jest-expo` 51.x dependency trees.
Fixes require breaking-change `--force` upgrades (`jest-expo@47` /
`expo@49` — both *downgrades* per npm's resolution graph, suggesting
the current expo SDK 54 has fixed these elsewhere). Not actionable in
this spec; tracked across earlier specs (027/028/032/038). Not a
blocker.

## Handoff
next_agent: NONE
prompt: Security audit complete. 0 Critical, 0 High, 0 Medium, 0 Low. Spec 039 ships clean from a security standpoint — catalog content is pure plain-text labels (no HTML / script / template-injection vectors); `matchesQuery`'s `/\p{Diacritic}/gu` regex is a character class and is ReDoS-immune by construction (verified empirically, <1ms on 10K-char pathological inputs); `formatAuditAction` and all 9 sibling `enumLabels` resolvers fall through gracefully on unmapped inputs (raw string, never `undefined`, never dot-path leak); the StatusPill test mock returns the exact strings the real catalog returns for the 4 status keys, no bypass risk; zero grep hits for the deleted spec-038 top-level `role.*` / `status.*` keys (clean migration into `enum.*`); `package.json` untouched; `npm audit` baseline matches spec 038 — 11 vulns (5 low, 5 moderate, 1 high), zero new.
payload_paths:
  - specs/039-multi-language-support-p2-enums/reviews/security-auditor.md
