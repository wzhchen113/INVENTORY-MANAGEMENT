// src/components/cmd/LoadingBar.tsx — Spec 055 global top-bar progress.
//
// A thin animated indeterminate stripe that mounts at the top edge of the
// Cmd TitleBar. Two Zustand selectors keep the re-render budget tight:
//   - `hasInflight` — bar visibility (flips false → true and back).
//   - `hasSlow`     — color shift to the "taking longer than usual" warn
//                     shade after 5s.
//
// Why both selectors instead of a composite: Zustand's reference-equality
// check fires the component only when each boolean flips, not on every
// `_activeCount` tick. Pulling a derived expression would render on every
// integer change.
//
// Web-only animation: a CSS @keyframes sweep injected once at module
// load. Native bails on `Platform.OS !== 'web'` per spec §4 / A2 — see
// the "Native does not render the bar in v1" callout in the spec.
//
// The bar height is intentionally 2px so it doesn't add visible chrome
// height to the 32px title bar; positioned absolute over the bar's top
// edge with `pointerEvents: 'none'` so it never intercepts clicks on the
// store-picker or traffic lights below.

import React from 'react';
import { View, Platform } from 'react-native';
import {
  useInflight,
  selectHasInflight,
  selectHasSlow,
} from '../../lib/inflight';
import { useCmdColors } from '../../theme/colors';

interface Props {
  /** Visual height in px. Default 2. */
  height?: number;
}

// One-time keyframes injection so we don't ship a `react-native-reanimated`
// dependency for a single chrome stripe. Inserted into <head> the first
// time the component renders on web. Idempotent — guarded by a module-
// scoped flag.
let keyframesInjected = false;
const KEYFRAME_NAME = 'imrInflightSweep';
function ensureKeyframes() {
  if (keyframesInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById('imr-inflight-keyframes')) {
    keyframesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'imr-inflight-keyframes';
  // Two-stop sweep: a translucent gradient block walks across the rail
  // from left to right, then resets. 1.4s feels lively without being
  // distracting; matches the "thin top progress bar" UX of YouTube /
  // Linear.
  style.textContent = `
@keyframes ${KEYFRAME_NAME} {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
`;
  document.head.appendChild(style);
  keyframesInjected = true;
}

export const LoadingBar: React.FC<Props> = ({ height = 2 }) => {
  const C = useCmdColors();
  // Two tight selectors so the component re-renders only on boolean flips.
  const visible = useInflight(selectHasInflight);
  const slow = useInflight(selectHasSlow);

  if (Platform.OS !== 'web') return null;
  if (!visible) return null;

  ensureKeyframes();

  const stripeColor = slow ? C.loadingBarSlow : C.loadingBar;

  // The outer View is the rail (full width, sits at the very top edge).
  // The inner block is the moving sweep. `pointerEvents: 'none'` so
  // clicks on the traffic lights / store-picker pass through.
  // `animation*` style keys are web-only — react-native-web forwards them
  // to the DOM as CSS. Native bails out above so the cast is safe.
  const innerStyle: any = {
    width: '50%',
    height: '100%',
    backgroundColor: stripeColor,
    animationName: KEYFRAME_NAME,
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  };

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height,
        overflow: 'hidden',
        zIndex: 50,
      }}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      <View style={innerStyle} />
    </View>
  );
};
