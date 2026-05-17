# Security audit for spec 040

## Scope reviewed

- `supabase/migrations/20260517000000_user_data_i18n_names.sql` (new — adds `i18n_names jsonb` to five tables; drops/recreates `create_inventory_item_with_catalog`)
- `supabase/functions/translate-on-save/index.ts` (new edge function — DeepL passthrough)
- `supabase/config.toml` (no entry added for new function; verified default `verify_jwt = true` is in force)
- `supabase/tests/user_data_i18n_names.test.sql` (new pgTAP)
- `src/lib/translate.ts` (new — re-exports `translateOnSave`)
- `src/lib/db.ts` (modified — `translateOnSave` helper at `:1406`, partial-update writers)
- `src/lib/auth.ts` (modified — `callEdgeFunction` export expanded)
- `src/i18n/localizedName.ts` (new helper)
- `src/components/cmd/IngredientForm.tsx`, `IngredientFormDrawer.tsx`, `RecipeFormDrawer.tsx`, `PrepRecipeFormDrawer.tsx`, `src/screens/cmd/sections/CategoriesSection.tsx` (write sites that consume `translateOnSave` and write `i18n_names`)
- `src/utils/filterParser.ts` (modified — `matchesQuery` integration on the bare-token search path)

## Threat-model focus areas (per dispatch prompt)

| Focus area | Finding | Verdict |
|---|---|---|
| 1. `DEEPL_API_KEY` handling | Read via `Deno.env.get('DEEPL_API_KEY')` at `translate-on-save/index.ts:59`. Never logged. Never echoed in any response body. URL-encoded into the DeepL POST body via `URLSearchParams.set('auth_key', DEEPL_API_KEY)` at `:168`. The three `console.warn` lines (`:181`, `:191`, `:199`) log only locale and HTTP status — no token contents. | Clean |
| 2. Edge function input validation | 200-char text cap (`:134`), type guards on `text`/`sourceLocale`/`targetLocales` (`:131-:151`), allowlist enforced via `loc in LOCALE_TO_DEEPL` (`:148`) — only `'es'` and `'zh-CN'` pass. `sourceLocale` pinned literal to `'en'`. JSON body parse wrapped in `try/catch` (`:236-:243`). | Clean |
| 3. ADMIN_ROLES parity (`super_admin`) | `ADMIN_ROLES = new Set(["admin", "master", "super_admin"])` at `:72`. `requireAdminCaller()` shape byte-identical to `delete-user/index.ts:19` reference. Gates the entire request flow at `:215`. | Clean |
| 4. HTML escape on response body | `escapeHtml` applied to every DeepL output at `:206` before insertion into `translations` object. JSON response is not HTML, so the rule is technically moot — but architect chose defense-in-depth. See Low finding below regarding the side effect on user-visible text. | See Low #1 |
| 5. `i18n_names` JSONB injection | JSONB is type-safe at the Postgres boundary. All writes go through PostgREST (`.update({ i18n_names: ... })`) or the parameterized RPC (`p_i18n_names jsonb`). No `EXECUTE` / dynamic SQL anywhere. No injection vector. | Clean |
| 6. RPC `create_inventory_item_with_catalog` re-creation | `security invoker` + `set search_path = public` (locked, single schema). `grant execute ... to authenticated`. RLS still gates writes via `privileged_*_catalog_ingredients` policies. The new `p_i18n_names jsonb default '{}'::jsonb` param flows into `insert into catalog_ingredients` and into the returned JSONB shape. No privilege escalation introduced. | Clean |
| 7. Realtime broadcast of `i18n_names` | `catalog_ingredients`, `recipes`, `prep_recipes` are in `supabase_realtime` per `20260514140000_realtime_publication_tighten.sql`. Realtime delivery is RLS-gated identically to the existing `name` / `menu_item` column — a brand-A user does not receive brand-B's row updates. `recipe_categories` / `ingredient_categories` are deliberately NOT in the publication (pgTAP `(6a)` and `(6b)` lock this in). No cross-tenant leak. | Clean |
| 8. DeepL outbound call | HTTPS pinned (`const DEEPL_API_URL = "https://api-free.deepl.com/v2/translate"` at `:60`, hard-coded). No user-controlled URL. Response parse wrapped in `try/catch`. No `eval` / `Function` / `new RegExp(userInput)`. Non-2xx and network errors collapse to `null` without leaking DeepL-specific status. | Clean |
| 9. `npm audit` | No `package.json` changes vs commit `b96a90c` (verified via `git diff HEAD -- package.json`). Audit findings are pre-existing baseline, not introduced by spec 040. See Dependencies section. | Skipped (no spec-introduced change) |
| 10. Migration safety | `add column if not exists ... not null default '{}'::jsonb` is metadata-only in PG17 (no row rewrite, brief `AccessExclusive`). `drop function if exists` + `create or replace function` is idempotent. Single transaction. No long lock surface. | Clean |

---

### Critical (BLOCKS merge)

_None._

### High (must fix before deploy)

_None._

### Medium

_None._

### Low

- **`supabase/functions/translate-on-save/index.ts:206`** — `escapeHtml(out)` is applied to DeepL responses before they are placed in the JSON envelope. This is documented as "defense-in-depth" against a hypothetical future renderer that uses `innerHTML`. The side effect: every translation that contains `&`, `<`, `>`, `"`, or `'` will be **HTML-entity-encoded on the wire**, stored verbatim in `i18n_names` JSONB, and shown to users that way in `<Text>` / `TextInput` components (React Native's `<Text>` does NOT decode HTML entities — it renders the literal string). For example a DeepL Spanish translation containing an apostrophe like `niño's` will surface as `niño&#39;s` in the override input, get saved into the JSONB, and render forever as `niño&#39;s` in the inventory list. **Impact:** functional rather than security — it is not a privilege/data-exposure issue. **Fix recommendation (optional):** either (a) remove the `escapeHtml` wrap at `:206` and rely on the React Native renderer's automatic escaping (the canonical fix — `<Text>` and `<TextInput>` never interpret HTML, and the JSONB is never the source for an `innerHTML` call anywhere in the codebase), or (b) keep `escapeHtml` and document the limitation in the spec's §Risks ("DeepL outputs containing `&<>"'` will surface as HTML entities in the form preview"). Either is acceptable from a security standpoint. This is **Low** because the security-hardening intent is harmless on the wire and the user-visible rendering glitch does not create an exposure surface.

- **`supabase/functions/translate-on-save/index.ts:62-66`** — `Access-Control-Allow-Origin: *`. The function is JWT-protected (`verify_jwt = true` by default) and `requireAdminCaller` validates the bearer server-side, so a wildcard CORS does not weaken authorization in practice — the browser will still attach the bearer only on same-origin or explicitly-CORS'd requests, and the bearer carries the admin role. However the wildcard is broader than necessary; the project's other admin-only functions (`delete-user`, `send-invite-email`) carry the same `*` so this is consistent with existing pattern, not a regression. **Impact:** none in practice given the bearer gate. **Fix recommendation (optional, project-wide):** tighten to the deployed admin origin (`https://hopeful-lewin.vercel.app`) in a follow-up cleanup spec that hits all 10 functions at once. Not a spec-040 blocker.

### Dependencies

`npm audit --audit-level=high` was run; findings reflect the pre-existing baseline since `package.json` was not modified by spec 040 (verified via `git diff HEAD -- package.json`). Summary from the audit:

```
11 vulnerabilities (5 low, 5 moderate, 1 high)

high     — @xmldom/xmldom <=0.8.12 (devDep — XML serialization DoS / injection)
moderate — dompurify <=3.3.3 (devDep, transitive via jsdom)
moderate — postcss <8.5.10 (devDep, transitive via @expo/metro-config / @expo/cli)
low      — @tootallnate/once (devDep, transitive via jsdom → jest-expo)
```

None of these are runtime dependencies of the admin app surface; all sit under devDeps (`jsdom`, `jest-expo`, `@expo/metro-config`, `@expo/cli`). Spec 040 does not change `package.json` or `package-lock.json`. The baseline is unchanged — these findings are pre-existing and out of spec 040's scope.

Recommend a follow-up cleanup spec to run `npm audit fix` (non-breaking) for the low/moderate items and to consider the `expo` major upgrade window for the postcss / @tootallnate/once transitives. Not a spec-040 blocker.

### Spec-specific corroboration notes

- **`verify_jwt = true` posture** — Confirmed by inspection of `supabase/config.toml`. The only `verify_jwt = false` entries (lines 384, 391, 394, 397) are `pwa-catalog` and the three `staff-*` functions, all of which use a service-token bearer. `translate-on-save` is correctly absent from the override list and inherits the project default of `verify_jwt = true`. The gateway JWT check + the `requireAdminCaller()` defense-in-depth gate provide layered authorization.

- **No service-role-key escape** — `translate-on-save` does NOT construct a service-role client; it uses `SUPABASE_ANON_KEY` + bearer-forwarding (`:105-:107`), same pattern as `delete-user`'s `requireAdminCaller`. The service-role key is referenced only in `delete-user` and `send-invite-email` for `auth.admin.deleteUser` / `auth.admin.inviteUserByEmail`. No new client-side path to `SUPABASE_SERVICE_ROLE_KEY` exists.

- **No `EXPO_PUBLIC_*` for DEEPL** — Verified by grep across `src/` and `.env`. The DEEPL key is server-side only.

- **PII / data-exposure** — `i18n_names` contains translated label text (e.g. "Cebolla Amarilla"). Not PII; not subject to cross-tenant RLS escape (rides on existing `brand_member_*` and `auth_is_privileged()` policies which already pass the `name` / `menu_item` columns across the same wire).

- **Validation rejects DeepL-fingerprinting** — The function deliberately collapses every upstream DeepL failure mode (auth, quota, rate-limit, 5xx, network) to a single `503 { error: 'translation_unavailable' }` envelope (`:185-:201`, `:276-:281`). A caller cannot enumerate DeepL state via the function. Good posture.

- **pgTAP coverage of the load-bearing footnote** — Asserts (4a) and (4b) at `user_data_i18n_names.test.sql:266-:281` verify the RPC threads `p_i18n_names` into `catalog_ingredients.i18n_names` AND surfaces it on the returned JSONB. The architect's §11 "load-bearing RPC-parameter-threading risk" is covered by automated test.

- **Migration is single-transaction** — `begin; ... commit;` wraps the column adds, function drop, and function create. A partial-apply mid-migration cannot leave the RPC and the column out of sync.

### Summary

Spec 040 lands a substantial new attack surface — schema change on five tables, a new edge function calling a third-party API, and a re-created RPC. None of those changes introduce a Critical, High, or Medium finding. The design correctly:

- Gates the edge function on JWT verification + a server-side `requireAdminCaller` mirror of `auth_is_privileged()`.
- Includes `super_admin` in `ADMIN_ROLES` (closes the spec 026 / spec 027 pattern).
- Holds `DEEPL_API_KEY` server-side and never logs or echoes it.
- Caps input text at 200 chars and allowlists target locales.
- Pins the DeepL URL to HTTPS, parses defensively, and collapses upstream failures to a single opaque envelope.
- Re-creates the inventory RPC with `security invoker` + locked `search_path`, preserving existing RLS gating.
- Does not widen the realtime publication.
- Does not modify `package.json`, so the npm-audit baseline is unchanged.

Two Low items are noted (the `escapeHtml`-on-DeepL-output side effect, and the project-wide wildcard CORS posture) — neither blocks merge.
