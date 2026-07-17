// src/screens/staff/components/UpdatedBadge.test.tsx — spec 128.
//
// Component-project (jsdom) coverage for the staff "Updated" pill:
//   - renders the localized "Updated" label + the provided testID,
//   - carries an accessibility label so screen readers announce it.

import { render } from '@testing-library/react-native';
import { UpdatedBadge } from './UpdatedBadge';

describe('UpdatedBadge', () => {
  it('renders the "Updated" label', () => {
    const { getByText } = render(<UpdatedBadge />);
    expect(getByText('Updated')).toBeTruthy();
  });

  it('applies the provided testID', () => {
    const { getByTestId } = render(<UpdatedBadge testID="eod-updated-badge-item-1" />);
    expect(getByTestId('eod-updated-badge-item-1')).toBeTruthy();
  });

  it('exposes an accessibility label', () => {
    const { getByTestId } = render(<UpdatedBadge testID="b" />);
    expect(getByTestId('b').props.accessibilityLabel).toBe('Updated');
  });
});
