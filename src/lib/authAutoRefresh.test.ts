// src/lib/authAutoRefresh.test.ts — Spec 181 (B3 / AC-14).
//
// Native: an AppState 'change' listener starts supabase auto-refresh on
// 'active' and stops it on any other state; the remover unsubscribes. Web: no
// listener at all.

import { AppState, Platform } from 'react-native';

const mockStart = jest.fn(() => Promise.resolve());
const mockStop = jest.fn(() => Promise.resolve());
jest.mock('./supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      startAutoRefresh: () => mockStart(),
      stopAutoRefresh: () => mockStop(),
    },
  },
}));

import { installAuthAutoRefresh } from './authAutoRefresh';

type Listener = (state: string) => void;

const ORIGINAL_OS = Platform.OS;
function setPlatform(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

let listeners: Set<Listener>;
let addSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  listeners = new Set();
  addSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    fn: Listener,
  ) => {
    listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  addSpy.mockRestore();
  setPlatform(ORIGINAL_OS);
});

function emit(state: string) {
  listeners.forEach((fn) => fn(state));
}

describe('installAuthAutoRefresh — native', () => {
  beforeEach(() => setPlatform('ios'));

  it('calls nothing at install time', () => {
    const remove = installAuthAutoRefresh();
    expect(addSpy).toHaveBeenCalledWith('change', expect.any(Function));
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    remove();
  });

  it("'active' → startAutoRefresh; 'background' / 'inactive' → stopAutoRefresh", () => {
    const remove = installAuthAutoRefresh();
    emit('background');
    expect(mockStop).toHaveBeenCalledTimes(1);
    emit('inactive');
    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(mockStart).not.toHaveBeenCalled();
    emit('active');
    expect(mockStart).toHaveBeenCalledTimes(1);
    remove();
  });

  it('the remover unsubscribes (no calls after removal)', () => {
    const remove = installAuthAutoRefresh();
    expect(listeners.size).toBe(1);
    remove();
    expect(listeners.size).toBe(0);
    emit('active');
    emit('background');
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('install twice + remove twice leaves zero listeners (no duplicates across re-mounts)', () => {
    const r1 = installAuthAutoRefresh();
    r1();
    const r2 = installAuthAutoRefresh();
    expect(listeners.size).toBe(1);
    emit('active');
    expect(mockStart).toHaveBeenCalledTimes(1);
    r2();
    expect(listeners.size).toBe(0);
  });

  it('a rejected start/stop is swallowed (no unhandled rejection)', async () => {
    mockStart.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    mockStop.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    const remove = installAuthAutoRefresh();
    expect(() => emit('active')).not.toThrow();
    expect(() => emit('background')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    remove();
  });

  it('android behaves the same', () => {
    setPlatform('android');
    const remove = installAuthAutoRefresh();
    emit('active');
    expect(mockStart).toHaveBeenCalledTimes(1);
    remove();
  });
});

describe('installAuthAutoRefresh — web', () => {
  beforeEach(() => setPlatform('web'));

  it('adds no listener and never starts/stops; the remover is a safe no-op', () => {
    const remove = installAuthAutoRefresh();
    expect(addSpy).not.toHaveBeenCalled();
    emit('active');
    emit('background');
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    expect(() => remove()).not.toThrow();
  });
});
