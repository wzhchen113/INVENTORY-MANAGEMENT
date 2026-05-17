# Backend-architect post-impl drift review — Spec 040 P3

Reviewer: backend-architect (post-implementation mode)
Spec: `specs/040-multi-language-support-p3-user-data.md` (Status: READY_FOR_REVIEW)
Scope of this review: architectural drift only. Compares the
implementation against the `## Backend / architecture design` section
and the resolved decisions OQ-A1 through OQ-A5. Quality / coverage /
security findings are out of scope for this lane and live in the
sibling reviewer files.

## Summary

The implementation is overwhelmingly faithful to the design. The
migration shape, RPC re-creation strategy, RLS posture, edge-function
contract, `callEdgeFunction` envelope binding, `db.ts` helper surface,
realtime-publication restraint, and OQ-A2/A3/A4/A5 decisions all
match what the architect specified.

One **Should-fix** is the `escapeHtml(out)` call wrapped around DeepL
output inside the edge function (translate-on-save/index.ts:206) —
this contradicts the design's explicit `§4 / "No HTML rendering"`
rationale that the rule is moot for JSON-only responses, and risks
silently corrupting translations that contain `&`, `<`, `>`, `"`, or
`'`. Two **Minor** drifts are cosmetic.

No Critical drift detected.

---

## Critical (0)

None.

---

## Should-fix (1)

### S1. `escapeHtml(out)` on DeepL output is a data-corruption hazard contradicting design §4

**File:** `supabase/functions/translate-on-save/index.ts:206`

```ts
const out = parsed?.translations?.[0]?.text;
if (typeof out !== "string" || out.length === 0) return null;
return escapeHtml(out);   // <-- escapes & < > " ' before returning JSON
```

The design's §4 ("Edge function — `translate-on-save`") is explicit:

> **No HTML rendering.** The function returns JSON only, so the
> CLAUDE.md `escapeHtml` rule is moot. The text we send TO DeepL is
> URL-form-encoded (no XSS risk on the wire). The text we receive
> back FROM DeepL is consumed as a JSON string and propagated to
> client form state — never rendered as raw HTML by the form.

The implementation deviates by applying `escapeHtml()` to the DeepL
output as "defense-in-depth" (per the spec's `## Files changed` note
and the in-file comment at line 84-89). Because the call sites that
consume the returned `translations.es` / `translations['zh-CN']`
strings are React Native `TextInput` controlled components (not
`dangerouslySetInnerHTML`), this is not defense-in-depth — it is data
corruption. Concretely:

- A canonical English name like `Mom's Pie` → DeepL Spanish returns
  `El pastel de mamá` → the apostrophe gets escaped (none here, but
  any name DeepL renders with `'`, `"`, `&` would now contain `&#39;`,
  `&quot;`, `&amp;` literally in the JSONB column and in the form's
  override input).
- A Chinese translation with a typographic apostrophe (DeepL does
  emit `"` / `'` in localized punctuation around proper nouns) would
  produce `&#39;` literally rendered to the user.

The CLAUDE.md rule "Edge function HTML email templates escape
interpolated values" applies to HTML bodies served over the wire
(spec 028 / `send-invite-email`). It is **not** a blanket rule for
all edge-function output strings; the rationale of spec 028 was the
Resend HTML email template, not JSON envelopes.

**Recommended fix:** drop the `escapeHtml(out)` call and return `out`
directly. Add a unit test fixture asserting a DeepL response
containing `& < > " '` round-trips byte-identically. Update the
inline comment at lines 83-89 to remove the defense-in-depth framing
that contradicts the architect's design.

If the implementer wants to keep a defensive null/type guard, the
`typeof out !== "string" || out.length === 0` check on line 205
already covers that. No HTML escape needed.

**Severity rationale:** Should-fix rather than Critical because (a)
DeepL output for short ingredient/recipe names rarely contains the
five escaped characters in practice, so the corruption is latent and
unlikely to surface until a name with an apostrophe lands; (b) the
form layer is forgiving — a user who sees `&#39;` in the override
field can edit it manually before save; (c) no security impact (the
output is consumed by `TextInput`, not innerHTML). But the implementation
silently disagrees with the design's stated rationale and will produce
incorrect translations in production once a user creates an ingredient
named e.g. `"Mom's Onion Rings"`.

---

## Minor (2)

### M1. Edge function inline comment at line 83-89 reverses the design's reasoning

**File:** `supabase/functions/translate-on-save/index.ts:83-89`

The comment claims:

> The DeepL upstream returns plaintext, not HTML, but a defense-in-depth
> escape on every returned translation prevents a hypothetical
> caller-controlled XSS vector if a downstream renderer ever inserts
> the translation as innerHTML.

This contradicts the architect's design section §4 ("the CLAUDE.md
`escapeHtml` rule is moot") and the spec's `## Files changed` line
that claims it's "byte-identical to `send-invite-email`'s helper" — the
helper *body* is identical, but the application context is opposite
(HTML body in send-invite-email vs JSON in translate-on-save). The
comment misleads a future maintainer about *when* the helper is
required.

**Recommended fix:** if S1 is accepted (drop the escape call), this
becomes moot — remove the `escapeHtml` function entirely from the
file. If S1 is rejected, rewrite the comment to make the
contrarian-vs-design choice explicit so the next reader doesn't
assume CLAUDE.md's HTML-body rule applies here.

### M2. `src/lib/translate.ts` is a one-line re-export of `db.ts`

**File:** `src/lib/translate.ts`

The architect's design §6 said:

> **Decision: put this in a NEW file `src/lib/translate.ts`, not
> `db.ts`.** Rationale: db.ts is already ~64 KB. The translate
> function is conceptually I/O-not-DB.

The implementation placed the actual `translateOnSave` body in
`db.ts:1406` and created `src/lib/translate.ts` as a one-line
`export { translateOnSave } from './db';` re-export. Both import
paths work, but this is "the worst of both worlds" — db.ts grows
by the function it was supposed to not own, AND `src/lib/translate.ts`
exists as a thin redirect that future authors may delete as
"obviously dead." The form drawers (`RecipeFormDrawer`,
`PrepRecipeFormDrawer`, `CategoriesSection`, `IngredientForm`)
import from `../../lib/translate`, so the redirect file is
load-bearing today.

The file's own header comment acknowledges this:

> the user's implementation prompt placed `translateOnSave` in db.ts
> (alongside `saveLocale` and the rest of the edge-function wrappers).
> The architect's design §6 preferred a separate `src/lib/translate.ts`.
> Both can coexist — this file is the import-path entry the
> architect's design implies, while db.ts owns the actual
> implementation per the user's directive.

**Severity rationale:** Minor because the import path the design
suggested *does* resolve, the form code does import from
`./translate`, and the only cost is one extra hop and ~64 bytes
in `db.ts`. But the design intent (move I/O-not-DB out of db.ts)
is unfulfilled. If a v2 spec adds a translation provider abstraction,
moving the body from `db.ts` to `translate.ts` will be a clean diff
and the redirect can vanish.

**Recommended fix (low priority):** in a follow-up housekeeping pass,
move the `translateOnSave` body to `src/lib/translate.ts` and either
delete the re-export in `db.ts` or invert the redirect direction.
Not blocking ship.

---

## Drift checks the implementation **passed** (worth recording)

These are the explicit flag-this-as-drift items called out by the
post-impl prompt. All cleared.

### Migration (`20260517000000_user_data_i18n_names.sql`) — clean

- Five tables get `i18n_names jsonb not null default '{}'`: confirmed
  on `catalog_ingredients` (line 76), `recipes` (line 82),
  `prep_recipes` (line 88), `recipe_categories` (line 94),
  `ingredient_categories` (line 100). Each has a descriptive column
  comment naming the canonical column.
- Idempotent via `add column if not exists`: yes, on every table.
- No RLS policy changes: yes — the migration body contains zero
  `create policy` / `alter policy` statements. The pre-amble comment
  (lines 40-48) explicitly enumerates the five tables' existing
  policies and confirms they cover the new column.
- DOES NOT add `recipe_categories` or `ingredient_categories` to
  `supabase_realtime`: confirmed — grep for `alter publication` /
  `supabase_realtime` in the migration returns only documentation
  comments. The pgTAP test (`(6a)` / `(6b)`) actively asserts the
  two category tables are NOT in the publication, locking in the
  decision.
- `create_inventory_item_with_catalog` drop-and-recreate with
  `p_i18n_names jsonb default '{}'`: confirmed at line 131-273.
  All 11 original parameters preserved in the same order, threaded
  through to the same internal logic (find-or-create catalog,
  conditional `on conflict do update` that intentionally does NOT
  overwrite i18n_names on existing rows — note: this is a slight
  design enrichment, called out in the migration comment lines
  124-129, and matches the architect's "translations belong to the
  row's edit lifecycle, not the inventory-create flow" intent in
  spec design §11). The `grant execute` at line 279-281 names the
  new 12-arg signature.

### Edge function (`translate-on-save/index.ts`) — clean except S1

- JWT-protected per CLAUDE.md default: confirmed. No
  `[functions.translate-on-save]` block in `supabase/config.toml`,
  so `verify_jwt = true` is implicit. The function additionally
  calls `requireAdminCaller()` server-side (line 215), mirroring
  `auth_is_privileged()` per CLAUDE.md.
- Input shape matches design: `{ text, sourceLocale, targetLocales }`
  with the 200-char `text` cap and `sourceLocale === 'en'` literal
  per spec §4 (validation function at lines 121-154).
- Output shape matches design: `{ translations: { es?, 'zh-CN'? } }`
  with partial-success allowed (lines 266-271, "fill the
  succeeded fields and leave the failed ones as
  manual-override-only").
- `LOCALE_TO_DEEPL = { 'es': 'ES', 'zh-CN': 'ZH-HANS' }` (OQ-A3):
  confirmed at line 78-81 with the exact mapping the design called
  for.
- `DEEPL_API_KEY` from env, error 503 if missing: confirmed at
  line 59 + line 227-232. Returns `503 { error: 'DEEPL_API_KEY not
  configured' }`.
- DeepL endpoint `https://api-free.deepl.com/v2/translate` (HTTPS):
  confirmed at line 60.
- Partial success allowed: confirmed at lines 266-281 (only collapses
  to 503 when **every** target locale failed).
- Error envelope compatible with `callEdgeFunction` tier-order:
  every error path returns `JSON.stringify({ error: '...' })` with
  matching HTTP status — tier 1 (`parsed.error`) will be reached.

### `src/lib/db.ts` helpers — clean

- `translateOnSave(text, targetLocales)` wrapper present: confirmed
  at line 1406-1418. Returns the exact `{ data: { translations } | null;
  error: string | null }` shape the design specified.
- All create+update helpers for the 5 entity types accept optional
  `i18nNames`:
  - `createInventoryItem` (line 142-185) threads to RPC's
    `p_i18n_names`.
  - `updateInventoryItem` (line 192) writes to
    `catalog_ingredients.i18n_names`.
  - `createRecipe` (line 297) / `updateRecipe` (line 1242) thread to
    `recipes.i18n_names`.
  - `createPrepRecipe` (line 1617) / `updatePrepRecipe` (line 1650).
  - `addRecipeCategory` (line 1728) / `updateRecipeCategory` (line
    1742). `addIngredientCategory` (line 1947) /
    `updateIngredientCategory` (line 1957).
- Five new `update*I18n` partial-update helpers: confirmed at lines
  1431-1497. Each gates on the correct PK column (`id` for
  catalog/recipes/preps; `name` for the two category tables).
- `mapItem` (line 3061) threads `i18n_names` through the join:
  confirmed — line 3103 hydrates `i18nNames: (cat.i18n_names ?? {})
  as Record<string, string>` from the joined `catalog` embed. The
  `fetchInventory` projection at line 104 explicitly lists
  `i18n_names` inside the `catalog_ingredients(...)` embed.

### `src/lib/auth.ts` — clean

- `callEdgeFunction` was previously file-private; now exported (line
  153). The export comment (lines 146-152) explains the spec 040
  reason. Existing call sites in `auth.ts` (`inviteUser`,
  `registerInvitedUser`, `deleteUser`) are unaffected.
- The tier-order behavior (parsed `error` → parsed `message` → `HTTP
  <status>`) is preserved exactly at lines 196-203.

### OQ-A1 through OQ-A5 — all confirmed

- **OQ-A1 (single spec, internal phasing).** Implementation lives
  in one PR, no `spec 040a/040b` split, file count matches the
  P3a+P3b superset.
- **OQ-A2 (client-initiated edge call).** Confirmed — no
  `pg_net` extension activation in the migration; no DB trigger
  invokes the edge function; the form drawers call
  `translateOnSave` directly via `callEdgeFunction`. The migration
  contains zero `create trigger` statements.
- **OQ-A3 (`ZH-HANS`).** Confirmed at edge function line 80.
- **OQ-A4 (hybrid blur OR 600ms idle).** Confirmed in all four form
  files: `IngredientForm.tsx:230-238` (`scheduleTranslate` 600ms
  setTimeout + `handleNameBlur` for blur),
  `RecipeFormDrawer.tsx:247-249`,
  `PrepRecipeFormDrawer.tsx:242-244`, `CategoriesSection.tsx:124+`
  (600ms both for ADD and EDIT flows). All four use
  `AbortController` to cancel in-flight fetches on subsequent
  keystrokes.
- **OQ-A5 (no SQL-side `localized_name` helper).** Confirmed —
  zero occurrences of `localized_name` in any migration file.

### Risk-list drift checks — clean

- No `public.localized_name()` SQL helper added (would contradict
  OQ-A5).
- No `pg_net` trigger added (would contradict OQ-A2).
- No `recipe_categories` or `ingredient_categories` membership added
  to `supabase_realtime` (would contradict §8). pgTAP `(6a)/(6b)`
  actively guards this.
- No per-field translation RPCs (e.g. `update_inventory_item_translation`)
  added — all writes flow through PostgREST table updates per design
  §3.
- No provider-abstraction layer (`TranslationProvider` interface, etc.)
  added — DeepL is hard-coded per the v1 §Out of scope.

---

## File references cited in this review

- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/specs/040-multi-language-support-p3-user-data.md` (design + scope)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260517000000_user_data_i18n_names.sql` (migration + RPC re-creation)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/translate-on-save/index.ts` (edge function; S1 + M1 land here)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/send-invite-email/index.ts` (escapeHtml reference shape)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions/delete-user/index.ts` (requireAdminCaller reference shape)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/tests/user_data_i18n_names.test.sql` (pgTAP — 15 assertions across shape, RLS, RPC round-trip, publication membership)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/db.ts` (helper surface, mapItem)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/auth.ts` (exported `callEdgeFunction`)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/lib/translate.ts` (M2)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/i18n/localizedName.ts` (pure helper)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/hooks/useLocalizedName.ts` (hook)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/src/components/cmd/IngredientForm.tsx`, `IngredientFormDrawer.tsx`, `RecipeFormDrawer.tsx`, `PrepRecipeFormDrawer.tsx`, `src/screens/cmd/sections/CategoriesSection.tsx` (OQ-A4 hybrid debounce verification)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260514140000_realtime_publication_tighten.sql` (publication-membership reference)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/config.toml` (verify_jwt defaults)
- `/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/migrations/20260504173843_create_inventory_item_with_catalog_rpc.sql` (original RPC signature comparison)

## Handoff

next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix, 2 Minor.
  Main Claude should wait for the other three reviewer files
  (code-reviewer, security-auditor, test-engineer) before
  dispatching release-coordinator.
payload_paths:
  - specs/040-multi-language-support-p3-user-data/reviews/backend-architect.md
