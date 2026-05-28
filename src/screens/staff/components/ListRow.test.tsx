// src/screens/staff/components/ListRow.test.tsx
//
// Spec 070 coverage gap: the ListRow Pressable-vs-View branch fix.
//
// The bug that originally shipped flat item cards: when `onPress` is
// absent, ListRow renders a plain <View>. Before the fix, a style
// *function* was passed to that View — which View silently drops —
// collapsing the card (no flex layout, no fill, no radius). The fix
// branches explicitly: Pressable receives the function, View receives
// a resolved array.
//
// These tests assert the structural output of BOTH branches so the
// regression would be caught:
//   - Pressable branch (StorePicker rows): rendered node is pressable.
//   - View branch (EODCount item rows): rendered node has a resolved
//     background color (not undefined/transparent), proving the card
//     style was NOT dropped.
//
// This is the component project (jsdom), matching src/screens/**/*.test.tsx.

import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { ListRow } from './ListRow';

const LEADING = <Text>Test item</Text>;

describe('ListRow — Pressable branch (onPress provided)', () => {
  it('is pressable when onPress is given', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <ListRow testID="row-pressable" leading={LEADING} onPress={onPress} />,
    );
    // The pressable element should exist and be fire-able.
    const el = getByTestId('row-pressable');
    expect(el).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <ListRow testID="row-tappable" leading={LEADING} onPress={onPress} />,
    );
    const { fireEvent } = require('@testing-library/react-native');
    fireEvent.press(getByTestId('row-tappable'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('ListRow — View branch (no onPress)', () => {
  it('renders without error when onPress is absent', () => {
    const { getByTestId } = render(
      <ListRow testID="row-static" leading={LEADING} />,
    );
    expect(getByTestId('row-static')).toBeTruthy();
  });

  it('has a resolved backgroundColor (card style not silently dropped)', () => {
    // This is the regression guard: before the fix, View received a style
    // *function* which it silently drops — the card had no background,
    // no flexDirection, no borderRadius. After the fix it receives a
    // resolved style array, so backgroundColor is defined.
    //
    // Under jest-expo `useColorScheme()` returns null → light palette →
    // c.surface = '#FFFFFF'. We assert the value is a non-empty string,
    // not a specific hex, so palette tweaks don't break this test.
    const { getByTestId } = render(
      <ListRow testID="row-static-bg" leading={LEADING} />,
    );
    const el = getByTestId('row-static-bg');
    // React Testing Library exposes flattened style on the rendered element.
    const flatStyle = el.props.style;
    // Collect all style objects (could be an array of arrays)
    const styles: Record<string, unknown>[] = Array.isArray(flatStyle)
      ? flatStyle.flat(Infinity)
      : [flatStyle];
    const bg = styles
      .filter(Boolean)
      .map((s) => (s as Record<string, unknown>).backgroundColor)
      .find((v) => v !== undefined);
    // backgroundColor must be a non-empty string — not undefined/null —
    // confirming the resolved style was applied rather than dropped.
    expect(typeof bg).toBe('string');
    expect(bg).toBeTruthy();
  });

  it('renders leading content', () => {
    const { getByText } = render(
      <ListRow testID="row-leading" leading={<Text>Item Name</Text>} />,
    );
    expect(getByText('Item Name')).toBeTruthy();
  });

  it('renders trailing content when provided', () => {
    const { getByText } = render(
      <ListRow
        testID="row-trailing"
        leading={<Text>Name</Text>}
        trailing={<Text>Trailing</Text>}
      />,
    );
    expect(getByText('Trailing')).toBeTruthy();
  });
});
