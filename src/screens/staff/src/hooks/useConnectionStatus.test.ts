// src/hooks/useConnectionStatus.test.ts — web + native branch coverage.
//
// Native branch is exercised by mocking @react-native-community/netinfo's
// `addEventListener` and verifying the hook subscribes + reacts to flips.
// Web branch sets Platform.OS = 'web' for the duration of the test and
// stubs window.addEventListener; renderHook drives the subscription.

import { renderHook, act } from '@testing-library/react-native';
import { Platform } from 'react-native';

// Override the NetInfo mock so we can drive its listener.
let mockNetListener:
  | ((s: { isConnected: boolean | null; isInternetReachable: boolean | null }) => void)
  | undefined;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((cb) => {
      mockNetListener = cb;
      return () => {
        mockNetListener = undefined;
      };
    }),
    fetch: jest.fn(() =>
      Promise.resolve({ isConnected: true, isInternetReachable: true }),
    ),
  },
}));

// Import AFTER mocks so the hook captures them.
import { useConnectionStatus } from './useConnectionStatus';

function setPlatform(os: 'web' | 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('useConnectionStatus', () => {
  const ORIGINAL_OS = Platform.OS;
  const originalNavigator = (global as { navigator?: unknown }).navigator;
  const originalWindow = (global as { window?: unknown }).window;

  afterEach(() => {
    setPlatform(ORIGINAL_OS as 'web' | 'ios' | 'android');
    if (originalNavigator !== undefined) {
      Object.defineProperty(global, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
    if (originalWindow !== undefined) {
      Object.defineProperty(global, 'window', {
        value: originalWindow,
        configurable: true,
      });
    }
    mockNetListener = undefined;
    jest.clearAllMocks();
  });

  describe('web', () => {
    it('seeds from navigator.onLine and flips on online/offline events', () => {
      setPlatform('web');
      const handlers: Record<string, EventListener> = {};
      Object.defineProperty(global, 'navigator', {
        value: { onLine: true },
        configurable: true,
      });
      Object.defineProperty(global, 'window', {
        value: {
          addEventListener: (event: string, h: EventListener) => {
            handlers[event] = h;
          },
          removeEventListener: jest.fn(),
        },
        configurable: true,
      });

      const { result, unmount } = renderHook(() => useConnectionStatus());

      expect(result.current).toBe(true);
      expect(handlers.online).toBeDefined();
      expect(handlers.offline).toBeDefined();

      act(() => handlers.offline(new Event('offline')));
      expect(result.current).toBe(false);

      act(() => handlers.online(new Event('online')));
      expect(result.current).toBe(true);

      unmount();
    });

    it('seeds false when navigator.onLine is false', () => {
      setPlatform('web');
      Object.defineProperty(global, 'navigator', {
        value: { onLine: false },
        configurable: true,
      });
      Object.defineProperty(global, 'window', {
        value: {
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
        configurable: true,
      });

      const { result, unmount } = renderHook(() => useConnectionStatus());
      expect(result.current).toBe(false);
      // Unmount BEFORE the afterEach window-restore so the cleanup
      // call hits the test's stub, not the restored production window.
      unmount();
    });
  });

  describe('native', () => {
    it('subscribes via NetInfo and flips when state changes', () => {
      setPlatform('ios');
      const { result, unmount } = renderHook(() => useConnectionStatus());

      // Initial seed is optimistic-true.
      expect(result.current).toBe(true);
      expect(mockNetListener).toBeDefined();

      // Flip to offline
      act(() =>
        mockNetListener!({ isConnected: false, isInternetReachable: false }),
      );
      expect(result.current).toBe(false);

      // isConnected true + isInternetReachable null is still online
      act(() =>
        mockNetListener!({ isConnected: true, isInternetReachable: null }),
      );
      expect(result.current).toBe(true);

      // isConnected true + isInternetReachable false is offline
      act(() =>
        mockNetListener!({ isConnected: true, isInternetReachable: false }),
      );
      expect(result.current).toBe(false);

      unmount();
    });
  });
});
