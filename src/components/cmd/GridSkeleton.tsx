// src/components/cmd/GridSkeleton.tsx — Spec 055 first-mount placeholder
// for grid-shaped sections (Dashboard cards, Reports cards). Renders a
// rows × cols grid of dimmed card-shaped placeholders that pulse on web
// (static dim on native).
//
// Shares the shimmer @keyframes rule with `ListSkeleton.tsx` via
// `./skeletonUtils.ts` — one DOM <style> tag covers both.

import React from 'react';
import { View, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { ensureSkeletonShimmer, SKELETON_KEYFRAME } from './skeletonUtils';

interface Props {
  /** Number of card rows. */
  rows?: number;
  /** Number of card columns. */
  cols?: number;
}

export const GridSkeleton: React.FC<Props> = ({ rows = 2, cols = 3 }) => {
  const C = useCmdColors();
  if (Platform.OS === 'web') ensureSkeletonShimmer();

  const cards = React.useMemo(() => {
    const out: Array<{ key: string }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({ key: `${r}-${c}` });
      }
    }
    return out;
  }, [rows, cols]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: C.bg,
        padding: 16,
      }}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        {cards.map((card) => {
          // animation* are web-only — react-native-web forwards as CSS.
          const cardStyle: any = {
            flexBasis: `${100 / cols - 2}%`,
            minWidth: 180,
            height: 96,
            backgroundColor: C.panel2,
            borderRadius: CmdRadius.md,
            borderWidth: 1,
            borderColor: C.border,
            ...(Platform.OS === 'web'
              ? {
                  animationName: SKELETON_KEYFRAME,
                  animationDuration: '1.4s',
                  animationIterationCount: 'infinite',
                  animationTimingFunction: 'ease-in-out',
                }
              : { opacity: 0.6 }),
          };
          return <View key={card.key} style={cardStyle} />;
        })}
      </View>
    </View>
  );
};
