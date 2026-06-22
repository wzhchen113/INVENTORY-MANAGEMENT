// src/screens/staff/components/WeeklyDueBanner.tsx — persistent in-app
// weekly-count reminder (spec 098).
//
// The "reliable floor" of the Q3-C reminder: it shows whenever the store's
// weekly count is open/overdue for the current week, REGARDLESS of web-push
// availability, on both web and native. It reads the staff store's
// `weeklyStatus` (refreshed on screen focus — staff v1 has no realtime),
// so it is the source of truth for "due/overdue this week". It renders
// nothing for `completed`, `not_scheduled`, or a null status.

import { Banner } from './Banner';
import { useStaffStore } from '../store/useStaffStore';
import { t } from '../i18n';

export function WeeklyDueBanner() {
  const status = useStaffStore((s) => s.weeklyStatus);
  if (!status) return null;
  if (status.status !== 'open' && status.status !== 'overdue') return null;
  const overdue = status.status === 'overdue';
  return (
    <Banner
      tone={overdue ? 'error' : 'warning'}
      text={overdue ? t('weekly.banner.overdue') : t('weekly.banner.due')}
      testID="weekly-due-banner"
    />
  );
}
