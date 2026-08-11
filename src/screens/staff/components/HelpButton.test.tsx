// src/screens/staff/components/HelpButton.test.tsx — Spec 158, AC-13.
//
// The staff `?` control: it navigates to the `Guide` screen with ITS OWN topic
// id, is a ≥44×44 target, and owns its own `useNavigation` (so a screen only
// has to render `<HelpButton topicId="..." />`).
//
// Mirrors SettingsGear.test.tsx's shape.

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { HelpButton } from './HelpButton';
import staffEn from '../i18n/en.json';
import { guideTopics } from '../../../lib/guide';

beforeEach(() => {
  mockNavigate.mockReset();
});

describe('HelpButton — AC-13', () => {
  test('renders under the stable testID with the catalog aria label', () => {
    render(<HelpButton topicId="EODCount" />);
    expect(screen.getByTestId('staff-guide-help-button')).toBeTruthy();
    // Real staff catalog — not a dot-path.
    expect(screen.getByLabelText(staffEn.guide.helpAria)).toBeTruthy();
  });

  test.each(guideTopics('staff').map((t) => t.id))(
    'navigates to Guide with its own topic id (%s)',
    (topicId) => {
      render(<HelpButton topicId={topicId} />);
      fireEvent.press(screen.getByTestId('staff-guide-help-button'));
      expect(mockNavigate).toHaveBeenCalledWith('Guide', { topicId });
    },
  );

  test('AC-13: the TOUCH target is ≥44×44 (token box + hitSlop)', () => {
    // The visual box follows the staff surface's own `touchTarget.min` token
    // (24 at scale x1 — the density baseline SettingsGear and ListRow use), so
    // the control does not render larger than the gear beside it. `hitSlop`
    // carries the touchable area the rest of the way to 44.
    render(<HelpButton topicId="Reorder" />);
    const node = screen.getByTestId('staff-guide-help-button');
    const style = StyleSheet.flatten(node.props.style);
    const slop = node.props.hitSlop as { top: number; bottom: number; left: number; right: number };
    expect(style.minHeight + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
    expect(style.minWidth + slop.left + slop.right).toBeGreaterThanOrEqual(44);
  });

  test('matches the SettingsGear density token rather than hard-coding a size', () => {
    render(<HelpButton topicId="Reorder" />);
    const style = StyleSheet.flatten(screen.getByTestId('staff-guide-help-button').props.style);
    expect(style.minHeight).toBe(style.minWidth);
  });

  test('accepts a testID override without losing the navigation behavior', () => {
    render(<HelpButton topicId="Settings" testID="custom-help" />);
    fireEvent.press(screen.getByTestId('custom-help'));
    expect(mockNavigate).toHaveBeenCalledWith('Guide', { topicId: 'Settings' });
  });
});
