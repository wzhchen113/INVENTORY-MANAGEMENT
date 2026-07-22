// src/lib/useNotificationToggle.test.tsx — spec 136.
//
// Cross-instance sync for the shared Web Push toggle hook. The whole spec-136
// fix is a module-scoped re-probe registry: when one mounted instance toggles
// notifications on/off, every OTHER mounted instance re-probes immediately so
// the staff banner / gear-dot don't sit stale until a background/reopen fires
// `visibilitychange`.
//
// Two cases:
//   A. Instance A enables → instance B's `view` flips to 'on' with NO
//      `visibilitychange` event dispatched (the registry is the only mechanism
//      under test — this file never dispatches a visibilitychange).
//   B. The acting instance's just-set transient failure message SURVIVES its
//      own broadcast (it is excluded from its own broadcast via the `reprobe`
//      token; it re-probes itself via the message-preserving `refresh(false)`
//      path — the spec-118 guard).
//
// This suite runs in BOTH the node-env `unit` project and the jsdom-env
// `component` project (jest.config.js). In node there is no `document`, so the
// visibilitychange path is structurally inert; in jsdom `document` exists but
// the listener is never dispatched. Either way the registry is the only
// cross-instance mechanism exercised. Platform is forced to 'web' so the
// branch matches what a browser user sees.
//
// Mock boundaries (hybrid mocking — mock the module-under-test's collaborators,
// tests/README.md):
//   • ./webPush          — stub requestPermissionAndSubscribe / unsubscribeFromPush.
//   • ./notificationState — keep the PURE deriveNotificationState +
//     subscribeCodeToMessageKey real (via requireActual), override ONLY the
//     impure probeNotificationState so the test drives the "off"/"on" snapshot.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

const mockRequestPermissionAndSubscribe = jest.fn();
const mockUnsubscribeFromPush = jest.fn();
jest.mock('./webPush', () => ({
  requestPermissionAndSubscribe: (...args: unknown[]) =>
    mockRequestPermissionAndSubscribe(...args),
  unsubscribeFromPush: (...args: unknown[]) => mockUnsubscribeFromPush(...args),
}));

// Partial mock: keep the pure reducer + code map real, stub only the impure
// browser probe.
const mockProbe = jest.fn();
jest.mock('./notificationState', () => {
  const actual = jest.requireActual('./notificationState');
  return {
    __esModule: true,
    ...actual,
    probeNotificationState: (...args: unknown[]) => mockProbe(...args),
  };
});

import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { DeriveInput } from './notificationState';
import { useNotificationToggle } from './useNotificationToggle';

// Identity translate stub → the returned copy equals the message KEY, so
// assertions read cleanly.
const t = (key: string) => key;

// Base browser snapshots the probe resolves to. `off` = capable but no
// permission/subscription → derives 'off'. `on` = granted + subscribed →
// derives 'on'.
const OFF: DeriveInput = {
  capable: true,
  permission: 'default',
  hasSubscription: false,
  isIos: false,
  isStandalone: true,
};
const ON: DeriveInput = {
  capable: true,
  permission: 'granted',
  hasSubscription: true,
  isIos: false,
  isStandalone: true,
};

beforeEach(() => {
  mockRequestPermissionAndSubscribe.mockReset();
  mockUnsubscribeFromPush.mockReset().mockResolvedValue(undefined);
  mockProbe.mockReset();
});

describe('useNotificationToggle cross-instance sync (spec 136)', () => {
  it('A enabling flips B.view to "on" via the registry, with no visibilitychange event', async () => {
    // Both instances mount seeing the "off" snapshot.
    mockProbe.mockResolvedValue(OFF);
    const A = renderHook(() => useNotificationToggle('u1', t));
    const B = renderHook(() => useNotificationToggle('u1', t));
    await waitFor(() => expect(A.result.current.view).toBe('off'));
    await waitFor(() => expect(B.result.current.view).toBe('off'));

    // The browser now reports "on"; A performs the enable.
    mockProbe.mockResolvedValue(ON);
    mockRequestPermissionAndSubscribe.mockResolvedValue({ ok: true });

    await act(async () => {
      A.result.current.onPress();
    });

    // A re-probes itself; A's broadcast re-probes B — no visibilitychange
    // dispatched anywhere in this test.
    await waitFor(() => expect(A.result.current.view).toBe('on'));
    await waitFor(() => expect(B.result.current.view).toBe('on'));

    A.unmount();
    B.unmount();
  });

  it('A disabling flips B.view back to "off" the same way', async () => {
    mockProbe.mockResolvedValue(ON);
    const A = renderHook(() => useNotificationToggle('u1', t));
    const B = renderHook(() => useNotificationToggle('u1', t));
    await waitFor(() => expect(A.result.current.view).toBe('on'));
    await waitFor(() => expect(B.result.current.view).toBe('on'));

    mockProbe.mockResolvedValue(OFF);

    await act(async () => {
      A.result.current.onPress(); // isOn → disable()
    });

    await waitFor(() => expect(A.result.current.view).toBe('off'));
    await waitFor(() => expect(B.result.current.view).toBe('off'));
    expect(mockUnsubscribeFromPush).toHaveBeenCalledTimes(1);

    A.unmount();
    B.unmount();
  });

  it('preserves the acting instance transient failure message through its own broadcast', async () => {
    // Probe stays "off" the whole time so the acting instance's body can ONLY
    // be the transient message (the 'off' view has no derived viewMessage) —
    // this isolates the message-preservation invariant from view derivation.
    mockProbe.mockResolvedValue(OFF);
    mockRequestPermissionAndSubscribe.mockResolvedValue({
      ok: false,
      code: 'permission-denied',
    });

    const A = renderHook(() => useNotificationToggle('u1', t));
    const B = renderHook(() => useNotificationToggle('u1', t));
    await waitFor(() => expect(A.result.current.view).toBe('off'));
    await waitFor(() => expect(B.result.current.view).toBe('off'));

    await act(async () => {
      A.result.current.onPress(); // enable() → {ok:false} → sets transient msg
    });

    // A set the denied message, then broadcast(reprobe) to OTHER instances —
    // A is excluded from its own broadcast, so its message survives.
    await waitFor(() =>
      expect(A.result.current.body).toBe('chrome.notifications.msg.denied'),
    );
    // B received the authoritative refresh(true): no transient message, and
    // the 'off' view has no derived message → null.
    expect(B.result.current.body).toBeNull();

    A.unmount();
    B.unmount();
  });
});
