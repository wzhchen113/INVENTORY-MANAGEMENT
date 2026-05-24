// src/screens/StorePicker.test.tsx — renders + selects store.

import { fireEvent, render } from '@testing-library/react-native';
import { StorePicker } from './StorePicker';
import { useStore } from '../store/useStore';

beforeEach(() => {
  useStore.setState({
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
    expect(useStore.getState().activeStore).toEqual({
      id: 's-2',
      name: 'Charles',
    });
  });

  it('shows the count subtitle', () => {
    const { getByText } = render(<StorePicker />);
    expect(getByText('You have access to 2 stores')).toBeTruthy();
  });
});
