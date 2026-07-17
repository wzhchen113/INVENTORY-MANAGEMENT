// src/screens/staff/components/IngredientThumb.test.tsx — spec 127.
//
// Component-project (jsdom) coverage for the staff count-row thumbnail:
//   - renders an <Image> at the resolved public URL when a photo path exists,
//   - renders the placeholder tile (no <Image>) when the path is null,
//   - both at a fixed box (no layout shift between states).
//
// The path→URL resolver is mocked (it is backend-owned, spec 127 §6) so the
// test does not depend on Supabase Storage.

jest.mock('../../../lib/ingredientImage', () => ({
  ingredientImageUrl: (p?: string | null) => (p ? `https://cdn.test/${p}` : null),
}));

import { Image } from 'react-native';
import { render } from '@testing-library/react-native';
import { IngredientThumb } from './IngredientThumb';

describe('IngredientThumb', () => {
  it('renders an Image at the resolved URL when a path is present', () => {
    const { getByTestId, queryByTestId, UNSAFE_getByType } = render(
      <IngredientThumb path="brand-1/cat-1/photo.jpg" />,
    );
    const img = getByTestId('ingredient-thumb-image');
    expect(img).toBeTruthy();
    expect(queryByTestId('ingredient-thumb-placeholder')).toBeNull();
    // Source resolves through ingredientImageUrl.
    expect(UNSAFE_getByType(Image).props.source).toEqual({
      uri: 'https://cdn.test/brand-1/cat-1/photo.jpg',
    });
  });

  it('renders the placeholder (no Image) when the path is null', () => {
    const { getByTestId, queryByTestId, UNSAFE_queryByType } = render(
      <IngredientThumb path={null} />,
    );
    expect(getByTestId('ingredient-thumb-placeholder')).toBeTruthy();
    expect(queryByTestId('ingredient-thumb-image')).toBeNull();
    expect(UNSAFE_queryByType(Image)).toBeNull();
  });

  it('renders the placeholder when the path is undefined', () => {
    const { getByTestId } = render(<IngredientThumb />);
    expect(getByTestId('ingredient-thumb-placeholder')).toBeTruthy();
  });

  it('uses the same fixed box size in both states (no layout shift)', () => {
    const withPhoto = render(<IngredientThumb path="b/c/p.jpg" />);
    const photoStyle = flatten(withPhoto.getByTestId('ingredient-thumb-image').props.style);

    const withoutPhoto = render(<IngredientThumb path={null} />);
    const placeholderStyle = flatten(
      withoutPhoto.getByTestId('ingredient-thumb-placeholder').props.style,
    );

    expect(photoStyle.width).toBe(placeholderStyle.width);
    expect(photoStyle.height).toBe(placeholderStyle.height);
    expect(photoStyle.width).toBeGreaterThan(0);
  });
});

function flatten(style: unknown): Record<string, any> {
  if (Array.isArray(style)) {
    return style.reduce((acc, s) => ({ ...acc, ...flatten(s) }), {} as Record<string, any>);
  }
  return (style ?? {}) as Record<string, any>;
}
