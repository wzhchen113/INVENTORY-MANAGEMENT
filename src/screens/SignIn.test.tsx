// src/screens/SignIn.test.tsx — auth gate flow.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

// Mock supabase BEFORE importing the screen so the module-level
// import inside SignIn reaches the mock.
const mockSignIn = jest.fn();
const mockSignOut = jest.fn().mockResolvedValue({ error: null });
const mockFrom = jest.fn();

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignIn(...args),
      signOut: () => mockSignOut(),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

import { SignIn } from './SignIn';
import { useStore } from '../store/useStore';

function makeFromResponse(table: string, data: unknown, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: () => Promise.resolve({ data, error }),
    // for user_stores (no maybeSingle):
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data, error }),
    _table: table,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    authState: { kind: 'idle' },
    activeStore: null,
    eodQueue: [],
    draining: false,
  });
});

describe('SignIn', () => {
  it('shows an error toast on bad credentials', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid' },
    });
    const { getByTestId } = render(<SignIn />);
    fireEvent.changeText(getByTestId('sign-in-email'), 'bad@example.com');
    fireEvent.changeText(getByTestId('sign-in-password'), 'wrong');
    fireEvent.press(getByTestId('sign-in-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    const calls = (Toast.show as jest.Mock).mock.calls;
    expect(calls[0][0]).toMatchObject({ text1: expect.stringContaining('Invalid') });
    expect(useStore.getState().authState.kind).toBe('signed-out');
  });

  it('signs out and toasts when profile.role !== "user"', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mockFrom.mockImplementationOnce((table) => {
      // First call: profiles
      expect(table).toBe('profiles');
      return makeFromResponse('profiles', { role: 'admin' });
    });
    const { getByTestId } = render(<SignIn />);
    fireEvent.changeText(getByTestId('sign-in-email'), 'admin@example.com');
    fireEvent.changeText(getByTestId('sign-in-password'), 'ok');
    fireEvent.press(getByTestId('sign-in-submit'));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(useStore.getState().authState.kind).toBe('signed-out');
    const calls = (Toast.show as jest.Mock).mock.calls;
    expect(calls[calls.length - 1][0].text1).toMatch(/staff only/i);
  });

  it('signs out and toasts when user_stores is empty', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() =>
        makeFromResponse('profiles', { role: 'user' }),
      )
      .mockImplementationOnce(() => makeFromResponse('user_stores', []));
    const { getByTestId } = render(<SignIn />);
    fireEvent.changeText(getByTestId('sign-in-email'), 'u@example.com');
    fireEvent.changeText(getByTestId('sign-in-password'), 'ok');
    fireEvent.press(getByTestId('sign-in-submit'));
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(useStore.getState().authState.kind).toBe('signed-out');
  });

  it('transitions to signed-in on happy path with single store', async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mockFrom
      .mockImplementationOnce(() =>
        makeFromResponse('profiles', { role: 'user' }),
      )
      .mockImplementationOnce(() =>
        makeFromResponse('user_stores', [
          { store_id: 's-1', store: { id: 's-1', name: 'Frederick' } },
        ]),
      );
    const { getByTestId } = render(<SignIn />);
    fireEvent.changeText(getByTestId('sign-in-email'), 'u@example.com');
    fireEvent.changeText(getByTestId('sign-in-password'), 'ok');
    fireEvent.press(getByTestId('sign-in-submit'));
    await waitFor(() =>
      expect(useStore.getState().authState.kind).toBe('signed-in'),
    );
    expect(useStore.getState().activeStore).toEqual({
      id: 's-1',
      name: 'Frederick',
    });
  });
});
