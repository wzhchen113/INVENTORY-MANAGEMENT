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

// ── Spec 153 install-guide boundaries ────────────────────────────────────
// The card is web-only, so the suite runs the Platform module at 'web' (same
// module-mock shape as AppReloadButton.test.tsx). The impure probes are the
// card's only other browser boundary; the pure model runs for real.
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

let mockInstallPlatform: 'ios' | 'android' | 'desktop' = 'ios';
let mockStandalone = false;
jest.mock('../../../lib/installGuide', () => {
  const actual = jest.requireActual('../../../lib/installGuide');
  return {
    ...actual,
    detectInstallPlatform: () => mockInstallPlatform,
    detectStandalone: () => mockStandalone,
    useInstallPrompt: () => ({ available: false, promptInstall: jest.fn() }),
  };
});

// Settings uses useNavigation().goBack; the gear (tested separately) uses
// navigate. Provide both (no NavigationContainer in these unit renders).
const mockGoBack = jest.fn();
// Spec 158 — the Guide row and the header HelpButton both call navigate();
// hoist the mock so AC-14 can assert on the exact call.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

import { Settings } from './Settings';
import { useStaffStore } from '../store/useStaffStore';

beforeEach(() => {
  mockSubmitStaffReport.mockReset();
  mockGoBack.mockReset();
  mockNavigate.mockReset();
  mockInstallPlatform = 'ios';
  mockStandalone = false;
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

// ── Spec 153 (AC-1, AC-7, AC-REG2) ───────────────────────────────────────
describe('Settings — Add to Home Screen card (Spec 153)', () => {
  it('AC-1: renders the card with the detected platform\'s numbered steps', () => {
    mockInstallPlatform = 'ios';
    const { getByTestId } = render(<Settings />);

    expect(getByTestId('staff-install-guide')).toBeTruthy();
    // iOS ships 4 steps (installSteps runs for real here).
    expect(getByTestId('staff-install-guide-step-ios.step1')).toBeTruthy();
    expect(getByTestId('staff-install-guide-step-ios.step4')).toBeTruthy();
  });

  it('AC-1 / AC-REG2: sits between the Text-size block and the Report-an-issue card', () => {
    const tree = JSON.stringify(render(<Settings />).toJSON());
    const scale = tree.indexOf('staff-scale-switcher');
    const install = tree.indexOf('staff-install-guide');
    const report = tree.indexOf('staff-report-form');
    const signOut = tree.indexOf('staff-settings-sign-out');

    expect(scale).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(scale);
    expect(report).toBeGreaterThan(install);
    expect(signOut).toBeGreaterThan(report);
  });

  it('follows the detected platform — an Android device sees the 3 Android steps', () => {
    mockInstallPlatform = 'android';
    const { getByTestId, queryByTestId } = render(<Settings />);
    expect(getByTestId('staff-install-guide-step-android.step3')).toBeTruthy();
    expect(queryByTestId('staff-install-guide-step-ios.step1')).toBeNull();
  });

  it('AC-7: already installed → the confirmation state instead of the steps', () => {
    mockStandalone = true;
    const { getByTestId, queryByTestId } = render(<Settings />);

    // The row stays (a disappearing settings section is the confusing outcome).
    expect(getByTestId('staff-install-guide')).toBeTruthy();
    expect(getByTestId('staff-install-guide-installed')).toBeTruthy();
    expect(queryByTestId('staff-install-guide-step-ios.step1')).toBeNull();
  });
});

// ── Spec 154 (AC-4) ──────────────────────────────────────────────────────
describe('Settings — Add to Home Screen illustrations (Spec 154)', () => {
  // The pictures are aria-hidden by design, so RNTL needs telling.
  const HIDDEN = { includeHiddenElements: true } as const;

  it('AC-4: every step of the detected platform carries its own picture', () => {
    mockInstallPlatform = 'ios';
    const { getByTestId, queryByTestId } = render(<Settings />);

    for (const key of ['ios.step1', 'ios.step2', 'ios.step3', 'ios.step4']) {
      expect(getByTestId(`staff-install-guide-art-${key}`, HIDDEN)).toBeTruthy();
    }
    // No tabs on staff — only the detected platform's pictures exist (spec 153).
    expect(queryByTestId('staff-install-guide-art-android.step1', HIDDEN)).toBeNull();
  });

  it('AC-4: follows the detected platform', () => {
    mockInstallPlatform = 'android';
    const { getByTestId, queryByTestId } = render(<Settings />);
    expect(getByTestId('staff-install-guide-art-android.step2', HIDDEN)).toBeTruthy();
    expect(queryByTestId('staff-install-guide-art-ios.step1', HIDDEN)).toBeNull();
  });

  it('AC-4: the "already added" state renders no pictures', () => {
    mockStandalone = true;
    const { queryByTestId } = render(<Settings />);
    expect(queryByTestId('staff-install-guide-art-ios.step1', HIDDEN)).toBeNull();
  });
});

// ── Spec 158 (AC-14, AC-13, AC-REG4) ─────────────────────────────────────
describe('Settings — Guide row (Spec 158)', () => {
  it('AC-14: renders a Guide row that opens the INDEX (no topicId)', () => {
    const { getByTestId } = render(<Settings />);
    fireEvent.press(getByTestId('staff-guide-entry'));
    expect(mockNavigate).toHaveBeenCalledWith('Guide');
  });

  it('AC-14 / AC-REG4: the row sits between Text size and the install-guide card', () => {
    // Section order pin: Notifications → Language → Text size → [Guide] →
    // install guide → Report an issue → Sign out.
    const tree = JSON.stringify(render(<Settings />).toJSON());
    const notif = tree.indexOf('staff-notification-switcher');
    const locale = tree.indexOf('staff-locale-switcher');
    const scale = tree.indexOf('staff-scale-switcher');
    const guide = tree.indexOf('staff-guide-entry');
    const install = tree.indexOf('staff-install-guide');
    const report = tree.indexOf('staff-report-form');
    const signOut = tree.indexOf('staff-settings-sign-out');

    expect(notif).toBeGreaterThan(-1);
    expect(locale).toBeGreaterThan(notif);
    expect(scale).toBeGreaterThan(locale);
    expect(guide).toBeGreaterThan(scale);
    expect(install).toBeGreaterThan(guide);
    expect(report).toBeGreaterThan(install);
    expect(signOut).toBeGreaterThan(report);
  });

  it("AC-13: the header ? navigates to this screen's own topic", () => {
    const { getByTestId } = render(<Settings />);
    fireEvent.press(getByTestId('staff-guide-help-button'));
    expect(mockNavigate).toHaveBeenCalledWith('Guide', { topicId: 'Settings' });
  });

  it('AC-13: the ? does not displace the back control or the title', () => {
    const { getByTestId } = render(<Settings />);
    expect(getByTestId('staff-settings-back')).toBeTruthy();
    expect(getByTestId('staff-guide-help-button')).toBeTruthy();
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
