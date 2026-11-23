// src/hooks/useRealtimeReloadScheduler.test.ts — Spec 206, AC-11.
//
// Pins the `handleSync` wiring at hook level (CmdNavigator's `AuthedRoot`
// calls this hook and hands the result to `useRealtimeSync`):
//   (a) the returned callback's identity is stable across re-renders;
//   (b) it feeds the write-aware scheduler, so the old inline 400 ms
//       `setTimeout` debounce is gone (a held event does NOT fire at 400 ms);
//   (c) unmount disposes the scheduler (subscription released, no timers);
//   (d) `reloadCurrentStore` reads the current store at FIRE time;
//   (e) the inflight adapter only calls back on `hasWriteInflight` edges.
//
// Uses the REAL `useInflight` store and a mocked `useStore`.

interface MockStoreState {
  currentStore: { id: string };
  loadFromSupabase: jest.Mock<Promise<void>, [string?]>;
}

const mockStoreState: MockStoreState = {
  currentStore: { id: 's1' },
  loadFromSupabase: jest.fn((_sid?: string) => Promise.resolve()),
};

jest.mock('../store/useStore', () => ({
  __esModule: true,
  useStore: { getState: () => mockStoreState },
}));

import { act, renderHook } from '@testing-library/react-native';
import { useInflight } from '../lib/inflight';
import { REALTIME_RELOAD_DEBOUNCE_MS } from '../lib/realtimeReloadScheduler';
import {
  inflightWriteSource,
  reloadCurrentStore,
  useRealtimeReloadScheduler,
} from './useRealtimeReloadScheduler';

const D = REALTIME_RELOAD_DEBOUNCE_MS;

function resetInflight() {
  useInflight.setState({
    hasInflight: false,
    hasSlow: false,
    _activeCount: 0,
    _slowCount: 0,
    _writeCount: 0,
    hasWriteInflight: false,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  resetInflight();
  mockStoreState.currentStore = { id: 's1' };
  mockStoreState.loadFromSupabase = jest.fn((_sid?: string) => Promise.resolve());
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useRealtimeReloadScheduler (AC-11)', () => {
  test('(a) handleSync identity is stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useRealtimeReloadScheduler());
    const first = result.current;
    rerender({});
    rerender({});
    expect(result.current).toBe(first);
  });

  test('(b) feeds the write-aware scheduler: held while writing, one load 400 ms after drain', () => {
    const { result } = renderHook(() => useRealtimeReloadScheduler());
    act(() => {
      useInflight.setState({ _writeCount: 1, hasWriteInflight: true });
    });
    act(() => {
      result.current();
    });
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    // The pre-spec-206 inline setTimeout would have fired at 400 ms.
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();

    act(() => {
      useInflight.setState({ _writeCount: 0, hasWriteInflight: false });
    });
    act(() => {
      jest.advanceTimersByTime(D - 1);
    });
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledTimes(1);
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledWith('s1');
  });

  test('(b, no writes) an event with no writes in flight loads once after 400 ms', () => {
    const { result } = renderHook(() => useRealtimeReloadScheduler());
    act(() => {
      result.current();
    });
    act(() => {
      jest.advanceTimersByTime(D - 1);
    });
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledTimes(1);
  });

  test('(c) unmount disposes the scheduler', () => {
    const unsubSpies: jest.Mock[] = [];
    const realSubscribe = useInflight.subscribe;
    jest.spyOn(useInflight, 'subscribe').mockImplementation((listener) => {
      const unsub = realSubscribe(listener);
      const spy = jest.fn(() => unsub());
      unsubSpies.push(spy);
      return spy;
    });

    const { result, unmount } = renderHook(() => useRealtimeReloadScheduler());
    expect(unsubSpies).toHaveLength(1);
    const handleSync = result.current;
    act(() => {
      handleSync();
    });
    expect(jest.getTimerCount()).toBe(1);

    unmount();
    expect(unsubSpies[0]).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();

    // The captured callback after unmount is a no-op.
    handleSync();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();
  });

  test('(d) the reload reads the current store at fire time', () => {
    const { result } = renderHook(() => useRealtimeReloadScheduler());
    act(() => {
      result.current();
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    mockStoreState.currentStore = { id: 's2' };
    act(() => {
      jest.advanceTimersByTime(D - 200);
    });
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledTimes(1);
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledWith('s2');
  });

  test('(d) reloadCurrentStore resolves without loading when no store is set', async () => {
    mockStoreState.currentStore = { id: '' };
    await expect(reloadCurrentStore()).resolves.toBeUndefined();
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();
  });

  test('(e) the inflight adapter calls back only on hasWriteInflight edges', () => {
    const cb = jest.fn();
    const unsub = inflightWriteSource.subscribe(cb);
    try {
      // Read-track churn: no callback.
      useInflight.setState({ _activeCount: 3, hasInflight: true });
      useInflight.setState({ _activeCount: 0, hasInflight: false });
      expect(cb).not.toHaveBeenCalled();

      // 0 → 1 write: edge.
      useInflight.setState({ _writeCount: 1, hasWriteInflight: true });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(inflightWriteSource.isWriting()).toBe(true);

      // 1 → 2 → 1 writes: no edge.
      useInflight.setState({ _writeCount: 2, hasWriteInflight: true });
      useInflight.setState({ _writeCount: 1, hasWriteInflight: true });
      expect(cb).toHaveBeenCalledTimes(1);

      // 1 → 0: edge.
      useInflight.setState({ _writeCount: 0, hasWriteInflight: false });
      expect(cb).toHaveBeenCalledTimes(2);
      expect(inflightWriteSource.isWriting()).toBe(false);
    } finally {
      unsub();
    }
  });

  test('(e) real tracked writes drive the hold end to end', async () => {
    const { result } = renderHook(() => useRealtimeReloadScheduler());
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    let tracked!: Promise<void>;
    act(() => {
      tracked = useInflight.getState().track(() => pending, { kind: 'write', label: 'w' });
    });
    act(() => {
      result.current();
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockStoreState.loadFromSupabase).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await tracked;
    });
    act(() => {
      jest.advanceTimersByTime(D);
    });
    expect(mockStoreState.loadFromSupabase).toHaveBeenCalledTimes(1);
  });
});
