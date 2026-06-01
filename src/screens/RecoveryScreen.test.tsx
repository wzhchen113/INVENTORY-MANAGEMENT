// src/screens/RecoveryScreen.test.tsx — Spec 085 Track 1 (jest, component project).
//
// Covers the set-new-password screen's 4-state machine (criteria test #2):
//   - parse.kind === 'error' on mount → friendly error state, updateUser NOT called
//   - successful exchange → form; short password / mismatch → validation error,
//     updateUser NOT called
//   - valid + matching → updateUser({ password }) called once → success state
//   - updateUser rejects (returns { error }) → stays on form, shows the message

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// Mock the recovery session exchange so the screen reaches `form` without a
// live supabase client. Per-test override of the resolved value.
jest.mock('../lib/recoveryRedirect', () => ({
  __esModule: true,
  establishRecoverySession: jest.fn(),
  resolveRecoveryRedirectUrl: jest.fn(() => 'http://localhost:8081/reset-password'),
}));

// Mock supabase auth — updateUser + signOut are the only methods the screen calls.
jest.mock('../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      updateUser: jest.fn(),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
  },
}));

import RecoveryScreen from './RecoveryScreen';
import { establishRecoverySession } from '../lib/recoveryRedirect';
import { supabase } from '../lib/supabase';
import type { RecoveryParse } from '../lib/recoveryUrl';

const establishMock = establishRecoverySession as jest.Mock;
const updateUserMock = supabase.auth.updateUser as jest.Mock;

// The chosen flow is token_hash; the screen calls establishRecoverySession
// (mocked here) regardless of kind, so this fixture exercises the primary path.
const RECOVERY_PARSE: RecoveryParse = { kind: 'recovery-token-hash', tokenHash: 'hash-xyz' };
const ERROR_PARSE: RecoveryParse = {
  kind: 'error',
  code: 'otp_expired',
  description: 'Email link is invalid or has expired',
};

beforeEach(() => {
  jest.clearAllMocks();
  establishMock.mockResolvedValue({ ok: true });
  updateUserMock.mockResolvedValue({ data: {}, error: null });
});

describe('RecoveryScreen — error parse', () => {
  it('renders the friendly expired state and never establishes a session or calls updateUser', () => {
    const { getByTestId, queryByTestId } = render(
      <RecoveryScreen parse={ERROR_PARSE} onExit={jest.fn()} />,
    );
    expect(getByTestId('recovery-error')).toBeTruthy();
    expect(queryByTestId('recovery-form')).toBeNull();
    expect(establishMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('error CTA calls onExit', () => {
    const onExit = jest.fn();
    const { getByTestId } = render(<RecoveryScreen parse={ERROR_PARSE} onExit={onExit} />);
    fireEvent.press(getByTestId('recovery-error-back'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('RecoveryScreen — recovery parse → form', () => {
  it('establishes the session on mount and shows the form', async () => {
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />);
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());
    expect(establishMock).toHaveBeenCalledWith(RECOVERY_PARSE);
  });

  it('shows the error state when the exchange fails', async () => {
    establishMock.mockResolvedValue({ ok: false, error: 'invalid or expired link' });
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />);
    await waitFor(() => expect(getByTestId('recovery-error')).toBeTruthy());
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('rejects a too-short password and does NOT call updateUser', async () => {
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />);
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());

    fireEvent.changeText(getByTestId('recovery-password'), 'short');
    fireEvent.changeText(getByTestId('recovery-confirm'), 'short');
    fireEvent.press(getByTestId('recovery-submit'));

    await waitFor(() => expect(getByTestId('recovery-field-error')).toBeTruthy());
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords and does NOT call updateUser', async () => {
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />);
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());

    fireEvent.changeText(getByTestId('recovery-password'), 'longenough1');
    fireEvent.changeText(getByTestId('recovery-confirm'), 'different123');
    fireEvent.press(getByTestId('recovery-submit'));

    await waitFor(() => expect(getByTestId('recovery-field-error')).toBeTruthy());
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it('calls updateUser once with a valid matching password and shows success', async () => {
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />);
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());

    fireEvent.changeText(getByTestId('recovery-password'), 'longenough1');
    fireEvent.changeText(getByTestId('recovery-confirm'), 'longenough1');
    fireEvent.press(getByTestId('recovery-submit'));

    await waitFor(() => expect(getByTestId('recovery-success')).toBeTruthy());
    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith({ password: 'longenough1' });
  });

  it('stays on the form and shows the message when updateUser returns an error', async () => {
    updateUserMock.mockResolvedValue({
      data: {},
      error: { message: 'New password should be different from the old password.' },
    });
    const { getByTestId, queryByTestId } = render(
      <RecoveryScreen parse={RECOVERY_PARSE} onExit={jest.fn()} />,
    );
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());

    fireEvent.changeText(getByTestId('recovery-password'), 'longenough1');
    fireEvent.changeText(getByTestId('recovery-confirm'), 'longenough1');
    fireEvent.press(getByTestId('recovery-submit'));

    await waitFor(() => expect(getByTestId('recovery-field-error')).toBeTruthy());
    expect(queryByTestId('recovery-success')).toBeNull();
    expect(updateUserMock).toHaveBeenCalledTimes(1);
  });

  it('success CTA signs out and calls onExit', async () => {
    const onExit = jest.fn();
    const { getByTestId } = render(<RecoveryScreen parse={RECOVERY_PARSE} onExit={onExit} />);
    await waitFor(() => expect(getByTestId('recovery-form')).toBeTruthy());

    fireEvent.changeText(getByTestId('recovery-password'), 'longenough1');
    fireEvent.changeText(getByTestId('recovery-confirm'), 'longenough1');
    fireEvent.press(getByTestId('recovery-submit'));
    await waitFor(() => expect(getByTestId('recovery-success')).toBeTruthy());

    fireEvent.press(getByTestId('recovery-success-continue'));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
