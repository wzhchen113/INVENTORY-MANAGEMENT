// src/screens/staff/lib/notificationLevel.test.ts — spec 126 follow-up.
//
// Pins the 3-level derivation for all six NotificationView values so the
// GREEN / RED / neutral signal stays consistent across the SettingsGear
// dot, the reminder banner, and the Settings pill.

import type { NotificationView } from '../../../lib/notificationState';
import { notificationLevel } from './notificationLevel';

describe('notificationLevel', () => {
  const cases: Array<[NotificationView, 'on' | 'off' | 'na']> = [
    ['on', 'on'],
    ['off', 'off'],
    ['needs-install', 'off'],
    ['denied', 'off'],
    ['unsupported', 'na'],
    ['error', 'na'],
  ];

  it.each(cases)('maps view "%s" to level "%s"', (view, level) => {
    expect(notificationLevel(view)).toBe(level);
  });
});
