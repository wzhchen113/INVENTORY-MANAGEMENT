// src/screens/staff/components/IngredientThumb.tsx — spec 127.
//
// Small, fixed-size ingredient photo thumbnail shown as the leading element
// of each EOD / Weekly count row so counting staff can visually identify the
// physical item. View-only — staff have no upload/replace/remove (spec 127
// §Staff). Brand-level photo, hydrated onto the count item as `imagePath`
// via the catalog embed (spec 127 §5).
//
// When `path` is null/empty the component renders a graceful placeholder tile
// (a subtle icon glyph on the staff surface) at the SAME fixed box size, so a
// missing photo never shifts row layout or shows a broken image (spec 127 §11).

import { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { ingredientImageUrl } from '../../../lib/ingredientImage';
import { useStaffColors, useStaffTokens, type StaffTokens } from '../theme';

// ~40px per spec 127 §11 ("small ~40×40"), density-scaled with the staff UI
// scale so it stays proportional to the row text.
const BASE_SIZE = 40;

type Props = {
  /** Stored object path (`catalog_ingredients.image_path`) or null/undefined. */
  path?: string | null;
  testID?: string;
};

export function IngredientThumb({ path, testID }: Props) {
  const c = useStaffColors();
  const T = useStaffTokens();
  const styles = useMemo(() => makeStyles(T), [T]);
  const uri = ingredientImageUrl(path);

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={styles.thumb}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        testID={testID ?? 'ingredient-thumb-image'}
      />
    );
  }

  // No photo → neutral placeholder tile (same fixed box, no layout shift).
  return (
    <View
      style={[
        styles.thumb,
        styles.placeholder,
        { backgroundColor: c.surfaceAlt, borderColor: c.border },
      ]}
      accessibilityRole="image"
      accessibilityLabel="no photo"
      testID={testID ?? 'ingredient-thumb-placeholder'}
    >
      <Text style={[styles.glyph, { color: c.textTertiary }]}>▤</Text>
    </View>
  );
}

const makeStyles = (T: StaffTokens) => {
  // Scale the box with the active UI scale relative to the x1 body size so the
  // thumb tracks the row text. Falls back to BASE_SIZE at x1.
  const size = Math.round((BASE_SIZE / 9) * T.typography.bodyLarge);
  return StyleSheet.create({
    thumb: {
      width: size,
      height: size,
      borderRadius: T.radius.md,
    },
    placeholder: {
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    glyph: {
      fontSize: Math.round(size * 0.5),
      lineHeight: Math.round(size * 0.5),
    },
  });
};
