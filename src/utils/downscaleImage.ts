// src/utils/downscaleImage.ts — spec 127.
//
// WEB-ONLY client-side image downscale + JPEG transcode used by the admin
// ingredient-photo upload path (src/components/cmd/IngredientPhotoControl).
// The Cmd editor is desktop-web (spec 127 §0.6 — native admin upload is out
// of scope), so this leans on the browser platform built-ins `createImageBitmap`
// + `<canvas>.toBlob` and adds NO npm dependency.
//
// The store helper `db.uploadIngredientImage` sends the resulting JPEG blob to
// Supabase Storage; downscaling here keeps the stored object small (longest
// edge ≤ maxEdge, JPEG q≈0.8) so the staff thumbnail loads cheaply and the
// public bucket stays lean (spec 127 §4).

import { Platform } from 'react-native';

/**
 * Pure geometry: fit a `width × height` box within `maxEdge` on its longest
 * side, preserving aspect ratio and NEVER upscaling (scale is clamped to 1).
 * Exported for unit tests so the scaling contract is verified without a canvas.
 * Returns integer pixel dimensions ≥ 1.
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  // Don't upscale: a source already within the cap keeps its size.
  const scale = longest > maxEdge && longest > 0 ? maxEdge / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Downscale an image `File`/`Blob` and re-encode it as a JPEG blob whose
 * longest edge is capped at `maxEdge` (default 800px), at `quality` (default
 * 0.8). Preserves aspect ratio and never upscales.
 *
 * WEB-ONLY: throws off web (native admin upload is out of scope, spec 127
 * §0.6). Rejects if the browser cannot decode the file or the canvas fails to
 * produce a blob.
 */
export async function downscaleImage(
  file: File | Blob,
  maxEdge = 800,
  quality = 0.8,
): Promise<Blob> {
  if (Platform.OS !== 'web') {
    throw new Error('downscaleImage is web-only');
  }
  if (
    typeof createImageBitmap !== 'function' ||
    typeof document === 'undefined'
  ) {
    throw new Error('downscaleImage requires a browser environment');
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithinMaxEdge(
      bitmap.width,
      bitmap.height,
      maxEdge,
    );
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('downscaleImage: could not get 2d canvas context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    });
    if (!blob) throw new Error('downscaleImage: canvas.toBlob returned null');
    return blob;
  } finally {
    // Free the decoded bitmap (no-op if the polyfill omits close()).
    bitmap.close?.();
  }
}
