// src/components/cmd/ListSkeleton.tsx — Spec 055 first-mount placeholder.
//
// Rendered by Pattern B sections (Inventory, Recipes, Vendors, etc.) when
// the global `storeLoading` is true AND the section's slice is empty —
// i.e. the first fetch hasn't returned yet. Subsequent re-mounts with
// cached data skip the skeleton; the top progress bar covers those.
//
// Shape: `rows` dim rectangles stacked vertically, sized to roughly match
// a Cmd list row (column heights are intentional placeholders — they tile
// the panel so the layout doesn't visibly jump when real content lands).
//
// Web shimmer uses the shared helper at `./skeletonUtils.ts` — injected once,
// idempotent, identical to GridSkeleton so a single <style> tag covers both.
// Native (no animation, per A2) renders a static dimmed block.

import React from 'react';
import { View, Platform } from 'react-native';
import { useCmdColors } from '../../theme/colors';
import { ensureSkeletonShimmer, SKELETON_KEYFRAME } from './skeletonUtils';

interface Props {
  /** Number of skeleton rows. Tune per section to roughly match the
   *  visible row count so the panel fills naturally. */
  rows?: number;
}

const SkeletonRow: React.FC<{ widthPct: number; height: number; bg: string; border: string }> = ({
  widthPct,
  height,
  bg,
  border,
}) => {
  // animation* are web-only style keys — react-native-web forwards them
  // to the DOM as CSS. Cast through `any` so native (which gets the
  // static-opacity branch instead) doesn't have to satisfy the union.
  const blockStyle: any = {
    width: `${widthPct}%`,
    height,
    backgroundColor: bg,
    borderRadius: 4,
    ...(Platform.OS === 'web'
      ? {
          animationName: SKELETON_KEYFRAME,
          animationDuration: '1.4s',
          animationIterationCount: 'infinite',
          animationTimingFunction: 'ease-in-out',
        }
      : { opacity: 0.6 }),
  };
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: border,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View style={blockStyle} />
    </View>
  );
};

export const ListSkeleton: React.FC<Props> = ({ rows = 8 }) => {
  const C = useCmdColors();
  if (Platform.OS === 'web') ensureSkeletonShimmer();

  // Bias the widths so the layout reads as varied content. The same
  // pseudo-random pattern is deterministic on every render so React can
  // reuse keys.
  const widths = React.useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < rows; i++) {
      out.push(45 + ((i * 17) % 40));
    }
    return out;
  }, [rows]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: C.panel,
      }}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
    >
      {widths.map((w, i) => (
        <SkeletonRow
          key={i}
          widthPct={w}
          height={12}
          bg={C.panel2}
          border={C.border}
        />
      ))}
    </View>
  );
};
