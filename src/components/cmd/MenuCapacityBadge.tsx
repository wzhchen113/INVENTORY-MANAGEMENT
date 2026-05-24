// src/components/cmd/MenuCapacityBadge.tsx — Spec 060 frontend slice.
//
// Inline per-recipe capacity pill, mounted in RecipesSection's list row
// after the existing cost/margin row. Reads server-computed capacity
// from useStore().menuCapacity[recipeId]; the slice is populated by
// loadFromSupabase via fetchMenuCapacity (db.ts) and refreshed by the
// existing useRealtimeSync onSync path (no new realtime channel — see
// spec §5 / "Realtime impact").
//
// Visual states (architect's design lines 710-718):
//   - !hasRecipe                                       → "no recipe defined" (italic small mono, fg3)
//   - makeableQty === 0                                → red pill (C.danger bg)
//   - makeableQty > 0 && lowIngredientCount > 0        → amber pill (C.warn bg) — per-recipe insufficient
//   - makeableQty > 0 && lowIngredientCount === 0      → neutral mono text (C.fg2) — just the integer
//   - hasUnitMismatch                                  → prefix the number with "~" + tooltip
//   - truncated                                        → suffix the number with "?" + tooltip
//   - slice missing (RPC not loaded yet)               → render nothing (no flicker, per design)
//
// The component does NOT replace the existing global low-stock indicator
// (StatusPill against getItemStatus). The two coexist because they
// answer different questions: global low = "this store has items below
// par"; per-recipe insufficient = "this recipe touches one of those
// items." See spec §A and architect's component contract A.

import React from 'react';
import { View, Text, Platform } from 'react-native';
import { useCmdColors, CmdRadius } from '../../theme/colors';
import { mono } from '../../theme/typography';
import { useStore } from '../../store/useStore';
import { useT } from '../../hooks/useT';

interface Props {
  recipeId: string;
}

export const MenuCapacityBadge: React.FC<Props> = ({ recipeId }) => {
  const C = useCmdColors();
  const T = useT();
  const row = useStore((s) => s.menuCapacity[recipeId]);

  // Slice not loaded yet — render nothing, no flicker. Once the RPC
  // resolves and onSync fires, the selector wakes us up.
  if (!row) return null;

  // No BOM at all — print the literal label per AC §A and §E.
  if (!row.hasRecipe) {
    return (
      <Text
        accessibilityLabel={T('component.menuCapacityBadge.noRecipeAria')}
        style={{
          fontFamily: mono(400),
          fontSize: 10,
          fontStyle: 'italic',
          color: C.fg3,
        }}
      >
        {T('component.menuCapacityBadge.noRecipe')}
      </Text>
    );
  }

  // makeableQty is non-null in the hasRecipe branch (per RPC contract:
  // NULL only when !hasRecipe). Belt-and-braces: if it ever lands null
  // for some reason, render "?" rather than crash to "0".
  const qty = row.makeableQty;
  if (qty === null || qty === undefined) {
    return (
      <Text
        accessibilityLabel={T('component.menuCapacityBadge.unknownAria')}
        style={{
          fontFamily: mono(500),
          fontSize: 10.5,
          color: C.fg3,
          fontVariant: ['tabular-nums'],
        }}
      >
        {T('component.menuCapacityBadge.unknown')}
      </Text>
    );
  }

  const isZero = qty === 0;
  const isLow = qty > 0 && row.lowIngredientCount > 0;

  // Tone + colors per the visual table in the design.
  let bg = 'transparent';
  let fg = C.fg2;
  let borderColor: string | undefined;
  if (isZero) {
    bg = C.dangerBg;
    fg = C.danger;
  } else if (isLow) {
    bg = C.warnBg;
    fg = C.warn;
  }

  // Build the displayed number: "~" prefix for unit mismatch, "?" suffix
  // for truncated. Integer-floor — capacity is a count of menu items.
  const displayQty = String(Math.floor(qty));
  const prefix = row.hasUnitMismatch ? '~' : '';
  const suffix = row.truncated ? '?' : '';
  const numberLabel = `${prefix}${displayQty}${suffix}`;

  // Accessibility label assembles the human-readable shape:
  //   "can make 3", "can make 0 — insufficient stock", "can make 3 (approx, unit mismatch)", etc.
  const baseAria = T('component.menuCapacityBadge.canMake', { count: displayQty });
  const stateBits: string[] = [];
  if (isZero) stateBits.push(T('component.menuCapacityBadge.insufficientAria'));
  else if (isLow) stateBits.push(T('component.menuCapacityBadge.lowAria'));
  if (row.hasUnitMismatch) stateBits.push(T('component.menuCapacityBadge.unitMismatchAria'));
  if (row.truncated) stateBits.push(T('component.menuCapacityBadge.truncatedAria'));
  const ariaLabel = stateBits.length ? `${baseAria} — ${stateBits.join(', ')}` : baseAria;

  // Web-only `title` attribute for the unit-mismatch / truncated tooltip.
  // Matches the pattern used by DisabledCreatePoButton in ReorderSection.
  const tooltipBits: string[] = [];
  if (row.hasUnitMismatch) tooltipBits.push(T('component.menuCapacityBadge.unitMismatchTooltip'));
  if (row.truncated) tooltipBits.push(T('component.menuCapacityBadge.truncatedTooltip'));
  const tooltip = tooltipBits.join(' · ');
  const tooltipProps =
    Platform.OS === 'web' && tooltip
      ? ({ title: tooltip } as any)
      : {};

  // Pill shape when zero/low, plain text when neutral — matches the
  // design's "neutral text" row for makeableQty > 0 && lowIngredientCount === 0.
  if (isZero || isLow) {
    return (
      <View
        accessibilityRole="text"
        accessibilityLabel={ariaLabel}
        {...tooltipProps}
        style={{
          paddingHorizontal: 7,
          paddingVertical: 2,
          borderRadius: CmdRadius.xs,
          backgroundColor: bg,
          borderWidth: borderColor ? 1 : 0,
          borderColor,
          alignSelf: 'flex-start',
        }}
      >
        <Text
          style={{
            fontFamily: mono(700),
            fontSize: 10,
            letterSpacing: 0.5,
            color: fg,
            fontVariant: ['tabular-nums'],
          }}
        >
          {numberLabel}
        </Text>
      </View>
    );
  }

  // Neutral state — no pill, just the number in fg2 mono.
  return (
    <Text
      accessibilityRole="text"
      accessibilityLabel={ariaLabel}
      {...tooltipProps}
      style={{
        fontFamily: mono(500),
        fontSize: 10.5,
        color: C.fg2,
        fontVariant: ['tabular-nums'],
      }}
    >
      {numberLabel}
    </Text>
  );
};
