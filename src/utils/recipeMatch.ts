// src/utils/recipeMatch.ts
// Shared waterfall matcher for POS-name → recipe lookups. Used by the in-app
// import flow (POSImportScreen) and (verbatim-duplicated) by the Deno-side
// breadbot-nightly-sync edge function. Pure — no React or Deno imports.
//
// Match order:
//   1. Alias  — explicit (pos_name, store_id) row in pos_recipe_aliases
//   2. Exact  — case-insensitive equality of POS name vs recipe.menuItem
//   3. Token  — every significant recipe token appears in the POS tokens
//              (drops leading counts like "6", folds trailing plurals)
//   4. Contains — substring fallback when both sides ≥4 chars
//   5. None   — caller must surface for manual mapping

export type RecipeLike = { id: string; menuItem: string };
export type AliasLike = { pos_name: string; recipe_id: string };

export type MatchResult =
  | { recipeId: string; matchType: 'alias' | 'fuzzy' }
  | { recipeId: null; matchType: 'none' };

const STOP_TOKENS = new Set(['and']);
const COUNT_TOKEN_RE = /^\d+(pc|pcs|ct|cts)?$/;
const SKIP_RE = /^(no |add utensils|extra |add )/;

export function significantTokens(s: string): string[] {
  const raw = s.toLowerCase().split(/[\s\-_\/(),.&]+/).filter(Boolean);
  let i = 0;
  while (i < raw.length && COUNT_TOKEN_RE.test(raw[i])) i++;
  return raw.slice(i)
    .map((t) => (t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t))
    .filter((t) => t && !STOP_TOKENS.has(t));
}

function tokensSubsetOf(a: string[], b: string[]): boolean {
  if (a.length === 0) return false;
  const set = new Set(b);
  return a.every((t) => set.has(t));
}

export function matchRecipe(
  posName: string,
  recipes: RecipeLike[],
  aliases: AliasLike[],
): MatchResult {
  const lower = posName.toLowerCase().trim();
  if (!lower || SKIP_RE.test(lower)) return { recipeId: null, matchType: 'none' };

  // 1. Alias — case-insensitive on pos_name (we lowercase both sides on save).
  const alias = aliases.find((a) => a.pos_name.toLowerCase().trim() === lower);
  if (alias) {
    const recipe = recipes.find((r) => r.id === alias.recipe_id);
    if (recipe) return { recipeId: recipe.id, matchType: 'alias' };
    // alias points to a deleted recipe — fall through to fuzzy
  }

  // 2. Exact case-insensitive
  const exact = recipes.find((r) => r.menuItem.toLowerCase() === lower);
  if (exact) return { recipeId: exact.id, matchType: 'fuzzy' };

  // 3. Token-set: every significant recipe token must appear in the POS tokens.
  // Rank by recipe token count so more specific recipes ("BBQ Wings") beat
  // generic ones ("Wings") when both qualify.
  const posTokens = significantTokens(posName);
  if (posTokens.length > 0) {
    const ranked = recipes
      .map((r) => ({ recipe: r, rTokens: significantTokens(r.menuItem) }))
      .filter(({ rTokens }) => tokensSubsetOf(rTokens, posTokens))
      .sort((a, b) => b.rTokens.length - a.rTokens.length);
    if (ranked[0]) return { recipeId: ranked[0].recipe.id, matchType: 'fuzzy' };
  }

  // 4. Containment fallback (preserves existing behavior).
  const contained = recipes.find((r) => {
    const rLower = r.menuItem.toLowerCase();
    if (lower.length < 4 || rLower.length < 4) return false;
    return lower.includes(rLower) || rLower.includes(lower);
  });
  if (contained) return { recipeId: contained.id, matchType: 'fuzzy' };

  return { recipeId: null, matchType: 'none' };
}
