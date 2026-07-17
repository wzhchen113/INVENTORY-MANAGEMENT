// src/lib/ingredientImage.ts — Spec 127.
//
// Pure path→URL resolver for ingredient photos. Given a stored
// `catalog_ingredients.image_path` (an object path in the public
// `ingredient-images` bucket, e.g. `<brand>/<catalog>/<uuid>.jpg`), returns the
// public CDN URL, or null for a null/empty path so callers render a placeholder.
//
// `getPublicUrl` is synchronous and does NO network I/O — it string-builds the
// CDN URL — so this module is safe to import from BOTH the admin surface and the
// staff subtree (same posture as the shared `getLocalizedName` resolver, spec
// 040). It is NOT a `supabase.from/rpc` data path, so it does not violate the
// staff-subtree carve-out (spec 063).
import { supabase } from './supabase';

const BUCKET = 'ingredient-images';

/** Resolve a stored ingredient-images object path to its public CDN URL.
 *  Returns null for a null/empty path so callers render the placeholder. */
export function ingredientImageUrl(
  imagePath: string | null | undefined,
): string | null {
  if (!imagePath) return null;
  return supabase.storage.from(BUCKET).getPublicUrl(imagePath).data.publicUrl;
}
