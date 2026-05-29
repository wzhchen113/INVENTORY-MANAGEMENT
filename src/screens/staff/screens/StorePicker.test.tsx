// src/screens/staff/screens/StorePicker.test.tsx — renders + selects store.
//
// Spec 071 added the safe-area root regression guards at the bottom of the
// file. The original spec 063 (imr-staff merge) tests above continue to
// cover row rendering, row tap → setActiveStore, and the count subtitle.
//
// The jest-expo setup at `tests/jest.setup.ts` mocks
// `react-native-safe-area-context` such that:
//   - `SafeAreaView` renders as a host element with the string tag
//     `'SafeAreaView'` and forwards every prop (including `edges`).
//   - `SafeAreaProvider` renders as a Fragment passthrough.
// That lets us assert root identity via `el.type === 'SafeAreaView'`
// and `el.props.edges === ['top', 'bottom']` without standing up a real
// provider in the test tree.

import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StorePicker } from './StorePicker';
import { useStaffStore } from '../store/useStaffStore';

beforeEach(() => {
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [
        { storeId: 's-1', storeName: 'Frederick' },
        { storeId: 's-2', storeName: 'Charles' },
      ],
    },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

describe('StorePicker', () => {
  it('renders one row per store', () => {
    const { getByText } = render(<StorePicker />);
    expect(getByText('Frederick')).toBeTruthy();
    expect(getByText('Charles')).toBeTruthy();
  });

  it('tapping a row sets the active store', () => {
    const { getByTestId } = render(<StorePicker />);
    fireEvent.press(getByTestId('store-row-s-2'));
    expect(useStaffStore.getState().activeStore).toEqual({
      id: 's-2',
      name: 'Charles',
    });
  });

  it('shows the count subtitle', () => {
    const { getByText } = render(<StorePicker />);
    expect(getByText('You have access to 2 stores')).toBeTruthy();
  });
});

describe('StorePicker — spec 071 safe-area root', () => {
  it('renders without throwing when no SafeAreaProvider is mounted', () => {
    // AC §"Jest snapshot or render test for StorePicker (if added)
    // renders without throwing when no SafeAreaProvider is mounted in
    // the test tree." Confirms the library's default-insets fallback
    // covers us — the component must not assume insets are non-null at
    // mount.
    expect(() => render(<StorePicker />)).not.toThrow();
  });

  it('root element is SafeAreaView (not a bare View)', () => {
    // Primary regression guard for the spec 071 swap. If a future agent
    // reverts the root back to `<View>`, this assertion fails because
    // the mocked SafeAreaView renders with the string tag 'SafeAreaView'
    // rather than 'View'.
    const { getByTestId } = render(
      <SafeAreaProvider>
        <StorePicker />
      </SafeAreaProvider>,
    );
    const root = getByTestId('store-picker-root');
    expect(root.type).toBe('SafeAreaView');
  });

  it('root SafeAreaView carries edges={["top", "bottom"]}', () => {
    // Pins the convention shared with EODCount.tsx:390-393 so a future
    // edit that drops the prop, switches to all-four-edges, or moves to
    // top-only is caught by the test rather than by an end-user noticing
    // overlap with the home indicator.
    const { getByTestId } = render(
      <SafeAreaProvider>
        <StorePicker />
      </SafeAreaProvider>,
    );
    const root = getByTestId('store-picker-root');
    expect(root.props.edges).toEqual(['top', 'bottom']);
  });

  it('renders the "Select your store" title above the inset', () => {
    // Regression guard for the title rendering inside the new
    // SafeAreaView root. Confirms the swap didn't accidentally drop the
    // existing `accessibilityRole="header"` markup or its text content.
    const { getByText, getByRole } = render(
      <SafeAreaProvider>
        <StorePicker />
      </SafeAreaProvider>,
    );
    // The title text comes from src/screens/staff/i18n/en.json →
    // store.picker.title. Asserting the literal pins the i18n contract
    // alongside the structural one.
    expect(getByText('Select your store')).toBeTruthy();
    // And confirm the accessibilityRole="header" markup survived the
    // root swap — a screen-reader user navigating by heading must still
    // land on this title.
    expect(getByRole('header')).toBeTruthy();
  });
});
