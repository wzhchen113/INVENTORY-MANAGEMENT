// src/components/cmd/skeletonUtils.ts — Spec 055 shared shimmer helper.
//
// Both ListSkeleton and GridSkeleton inject the same CSS @keyframes rule
// (identical 0%/50%/100% opacity pulse, 1.4s ease-in-out). Before this
// helper they each owned a copy with different keyframe/DOM-element names,
// producing two redundant <style> tags on first render. Extracting into
// a single helper removes the duplication and avoids drift if the animation
// is ever tuned.
//
// Web-only: native callers (Platform.OS !== 'web') should skip this and
// render a static-opacity block instead.

export const SKELETON_KEYFRAME = 'imrSkeletonPulse';

let injected = false;

/**
 * Ensure the shared skeleton shimmer @keyframes rule is in the DOM. Idempotent
 * — safe to call on every render; the module-scoped flag plus a defensive
 * `getElementById` check make duplicate injection impossible.
 */
export function ensureSkeletonShimmer(): void {
  if (injected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById('imr-skeleton-keyframes')) {
    injected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'imr-skeleton-keyframes';
  // Gentle opacity pulse — quieter than a full shimmer sweep so multiple
  // sections rendering at once don't compete for attention.
  style.textContent = `
@keyframes ${SKELETON_KEYFRAME} {
  0%   { opacity: 0.55; }
  50%  { opacity: 0.9; }
  100% { opacity: 0.55; }
}
`;
  document.head.appendChild(style);
  injected = true;
}
