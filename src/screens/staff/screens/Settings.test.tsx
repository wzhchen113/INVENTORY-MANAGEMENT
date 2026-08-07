// src/screens/staff/screens/Settings.test.tsx — spec 126.
//
// Covers the consolidated Settings screen: it renders the reused switchers +
// the report form + the sign-out action; the report form submits with the
// selected category + message + active store; an empty message blocks submit;
// a successful submit clears the form; a rejected submit surfaces the error and
// does NOT claim success.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

// Sign-out + notification-toggle boundaries (mirror StorePicker.test /
// Reorder.test — the test env has no SUPABASE_URL).
jest.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    auth: { signOut: jest.fn().mockResolvedValue({ error: null }) },
  },
}));

// The report write path — assert the exact args the form passes.
const mockSubmitStaffReport = jest.fn();
jest.mock('../lib/reports', () => ({
  submitStaffReport: (...a: unknown[]) => mockSubmitStaffReport(...a),
}));

// ── Spec 152 sign-out boundaries ─────────────────────────────────────────
// confirmAction is the cross-platform confirm; run its callback immediately so
// the sign-out body is exercised without a dialog.
jest.mock('../../../utils/confirmAction', () => ({
  confirmAction: (_t: string, _m: string, onConfirm: () => void) => onConfirm(),
}));

const mockMarkIntentionalSignOut = jest.fn();
const mockClearIntentionalSignOut = jest.fn();
jest.mock('../../../lib/sessionWatch', () => ({
  markIntentionalSignOut: () => mockMarkIntentionalSignOut(),
  clearIntentionalSignOut: () => mockClearIntentionalSignOut(),
}));

const mockUnsubscribeFromPush = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../lib/webPush', () => ({
  unsubscribeFromPush: () => mockUnsubscribeFromPush(),
  subscribeToPush: jest.fn(),
  getPushPermissionState: jest.fn(() => 'default'),
}));

// Settings uses useNavigation().goBack; the gear (tested separately) uses
// navigate. Provide both (no NavigationContainer in these unit renders).
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack }),
}));

import { Settings } from './Settings';
import { useStaffStore } from '../store/useStaffStore';

beforeEach(() => {
  mockSubmitStaffReport.mockReset();
  mockGoBack.mockReset();
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [{ storeId: 's-1', storeName: 'Frederick' }],
    },
    activeStore: { id: 's-1', name: 'Frederick' },
    eodQueue: [],
    draining: false,
  });
});

describe('Settings — layout', () => {
  it('renders the switchers, report form, and sign-out action', () => {
    const { getByTestId } = render(<Settings />);
    expect(getByTestId('staff-settings-root')).toBeTruthy();
    expect(getByTestId('staff-notification-switcher')).toBeTruthy();
    expect(getByTestId('staff-locale-switcher')).toBeTruthy();
    expect(getByTestId('staff-scale-switcher')).toBeTruthy();
    expect(getByTestId('staff-report-form')).toBeTruthy();
    expect(getByTestId('staff-report-submit')).toBeTruthy();
    expect(getByTestId('staff-settings-sign-out')).toBeTruthy();
  });
});

describe('Settings — report form', () => {
  it('submit is disabled with an empty message', () => {
    const { getByTestId } = render(<Settings />);
    fireEvent.press(getByTestId('staff-report-submit'));
    expect(mockSubmitStaffReport).not.toHaveBeenCalled();
  });

  it('submits with the active store, selected category, and message', async () => {
    mockSubmitStaffReport.mockResolvedValue('report-1');
    const { getByTestId } = render(<Settings />);

    // Pick a non-default category to prove the selection is threaded through.
    fireEvent.press(getByTestId('staff-report-category-inventory'));
    fireEvent.changeText(getByTestId('staff-report-message'), 'Walk-in freezer is warm');
    fireEvent.press(getByTestId('staff-report-submit'));

    await waitFor(() =>
      expect(mockSubmitStaffReport).toHaveBeenCalledWith(
        's-1',
        'inventory',
        'Walk-in freezer is warm',
      ),
    );
  });

  it('clears the message and shows success after a successful submit', async () => {
    mockSubmitStaffReport.mockResolvedValue('report-1');
    const { getByTestId } = render(<Settings />);

    fireEvent.changeText(getByTestId('staff-report-message'), 'Register jammed');
    fireEvent.press(getByTestId('staff-report-submit'));

    await waitFor(() => expect(getByTestId('staff-report-success')).toBeTruthy());
    expect(getByTestId('staff-report-message').props.value).toBe('');
  });

  it('surfaces an error and does NOT claim success on a rejected submit', async () => {
    mockSubmitStaffReport.mockRejectedValue(new Error('boom'));
    const { getByTestId, queryByTestId } = render(<Settings />);

    fireEvent.changeText(getByTestId('staff-report-message'), 'Something broke');
    fireEvent.press(getByTestId('staff-report-submit'));

    await waitFor(() => expect(getByTestId('staff-report-error')).toBeTruthy());
    expect(queryByTestId('staff-report-success')).toBeNull();
    // The message is preserved so the user can retry.
    expect(getByTestId('staff-report-message').props.value).toBe('Something broke');
  });
});

// ── Spec 152 (test-engineer coverage gap) ────────────────────────────────
// sessionWatch.test.ts pins the MECHANISM (an armed marker suppresses the
// "session expired" toast). What was missing is that this call site actually
// raises the marker BEFORE `signOut()` — the ordering the suppression depends
// on, because auth-js can emit SIGNED_OUT as soon as signOut() resolves. A
// refactor that moved the call after signOut() would have gone unnoticed.
describe('Settings — sign out marks the intentional path (Spec 152)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { supabase } = require('../../../lib/supabase') as {
    supabase: { auth: { signOut: jest.Mock } };
  };

  beforeEach(() => {
    mockMarkIntentionalSignOut.mockClear();
    mockClearIntentionalSignOut.mockClear();
    supabase.auth.signOut.mockReset().mockResolvedValue({ error: null });
  });

  it('calls markIntentionalSignOut() BEFORE supabase.auth.signOut()', async () => {
    const { getByTestId } = render(<Settings />);

    fireEvent.press(getByTestId('staff-settings-sign-out'));

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(1));
    expect(mockMarkIntentionalSignOut).toHaveBeenCalledTimes(1);
    expect(mockMarkIntentionalSignOut.mock.invocationCallOrder[0])
      .toBeLessThan(supabase.auth.signOut.mock.invocationCallOrder[0]);
    // A clean sign-out leaves the marker armed for the auth event to consume.
    expect(mockClearIntentionalSignOut).not.toHaveBeenCalled();
    expect(useStaffStore.getState().authState.kind).toBe('signed-out');
  });

  it('un-arms the marker when signOut() rejects', async () => {
    // auth-js skips the SIGNED_OUT emission on a network failure; a marker left
    // armed would silently eat the next GENUINE loss (staff has no banner).
    supabase.auth.signOut.mockRejectedValueOnce(new Error('network down'));
    const { getByTestId } = render(<Settings />);

    fireEvent.press(getByTestId('staff-settings-sign-out'));

    await waitFor(() => expect(mockClearIntentionalSignOut).toHaveBeenCalledTimes(1));
    expect(mockMarkIntentionalSignOut).toHaveBeenCalledTimes(1);
    // The local sign-out still completes — the session is unusable either way.
    expect(useStaffStore.getState().authState.kind).toBe('signed-out');
  });
});
