// src/screens/cmd/sections/__tests__/AuditLogSection.storeUser.spec167.test.tsx
//
// Spec 167 AC-11 — the two store-user audit actions are wired into both
// audit views. `ACTION_TONE` is `Partial<Record<AuditAction, ...>>`, so
// typecheck does NOT enforce an entry per action; these assertions are the
// only guard against a tone (or the desktop kind filter) silently falling
// back to 'muted' / 'other'.

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { ACTION_TONE as DESKTOP_ACTION_TONE, inferKind } from '../AuditLogSection';
import { ACTION_TONE as PHONE_ACTION_TONE } from '../phone/PhoneAuditLog';
import type { AuditAction, AuditEvent } from '../../../../types';

const STORE_USER_ACTIONS: AuditAction[] = ['Store user created', 'Store user password set'];

function event(action: AuditAction): AuditEvent {
  return {
    id: 'e1',
    timestamp: new Date().toISOString(),
    userId: 'u-admin',
    userName: 'Admin',
    userRole: 'admin',
    storeId: 'store-1',
    storeName: 'Store',
    action,
    detail: '',
    itemRef: 'frontdesk',
    value: '',
  };
}

describe('spec 167 AC-11 — store-user audit actions', () => {
  it.each(STORE_USER_ACTIONS)('desktop inferKind classifies %p as a user event', (action) => {
    expect(inferKind(event(action))).toBe('user');
  });

  it('desktop tones: created is ok, password set is warn', () => {
    expect(DESKTOP_ACTION_TONE['Store user created']).toBe('ok');
    expect(DESKTOP_ACTION_TONE['Store user password set']).toBe('warn');
  });

  it.each(STORE_USER_ACTIONS)('phone tone for %p matches desktop', (action) => {
    expect(PHONE_ACTION_TONE[action]).toBeDefined();
    expect(PHONE_ACTION_TONE[action]).toBe(DESKTOP_ACTION_TONE[action]);
  });
});
