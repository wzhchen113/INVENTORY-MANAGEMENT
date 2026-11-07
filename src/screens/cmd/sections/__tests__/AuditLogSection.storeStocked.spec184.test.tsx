// src/screens/cmd/sections/__tests__/AuditLogSection.storeStocked.spec184.test.tsx
//
// Spec 184 — the RPC's 'Store stocked' audit row is wired into both audit views.
// `ACTION_TONE` is a Partial record, so typecheck doesn't enforce an entry per action
// (same reasoning as the spec 167 file beside this one).

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
import { formatAuditAction } from '../../../../utils/formatAuditAction';
import type { AuditEvent } from '../../../../types';

const EVENT = { id: 'e1', action: 'Store stocked' } as AuditEvent;

describe("spec 184 — the 'Store stocked' audit action", () => {
  it('classifies as a stock event', () => {
    expect(inferKind(EVENT)).toBe('stock');
  });

  it('has the same ok tone on desktop and phone', () => {
    expect(DESKTOP_ACTION_TONE['Store stocked']).toBe('ok');
    expect(PHONE_ACTION_TONE['Store stocked']).toBe('ok');
  });

  it('formats through its catalog key', () => {
    expect(formatAuditAction(EVENT, (key) => key)).toBe('enum.auditAction.storeStocked');
  });
});
