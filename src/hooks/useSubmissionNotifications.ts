// src/hooks/useSubmissionNotifications.ts
//
// Spec 120 — drives the Cmd UI submission-notification bell.
//
// Two responsibilities, both kept OUT of the bell component so the
// component never imports `lib/supabase` (spec 057 convention):
//   1. Initial load of the feed head + unread count on mount / brand change.
//   2. A dedicated `notifications-{brandId}` realtime channel that refetches
//      the feed head + unread count on INSERT — a lightweight callback that
//      does NOT route through the heavy `onSync` full-reload (spec 120 §7).
//
// Wired from the Cmd shell (AuthedRoot in CmdNavigator) alongside
// `useRealtimeSync`. The store owns the state; the bell just renders it.
//
// super_admin / master span brands. When they're in "All brands" mode (no
// single brand selected — the default) we open one `notifications-{brandId}`
// channel PER visible brand so EVERY brand's submissions live-bump the bell,
// not just the currently-selected one. A brand admin has exactly one brand and
// gets a single channel. All channels are torn down on unmount / scope change
// so there are no leaks. The listen stays off the heavy `onSync` full-reload —
// an INSERT just refetches the feed head + unread count (spec 120 §7).
import { useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useStore } from '../store/useStore';

export function useSubmissionNotifications(brandId?: string) {
  const loadSubmissionNotifications = useStore((s) => s.loadSubmissionNotifications);
  const role = useStore((s) => s.currentUser?.role);
  const brandsList = useStore((s) => s.brandsList);

  // The set of brand channels to open. A super_admin/master with a populated
  // brandsList (which they always have — it's loaded at login) subscribes to
  // every visible brand, covering "All brands" mode. `brandId` (the selected
  // brand, if any) is always included so a brand admin — whose brandsList is
  // empty — still gets their single channel. Sorted + joined into a stable key
  // so the effect only re-subscribes when the actual set changes.
  const brandIds = useMemo(() => {
    const ids = new Set<string>();
    const isSuper = role === 'super_admin' || role === 'master';
    if (isSuper) for (const b of brandsList) ids.add(b.id);
    if (brandId) ids.add(brandId);
    return [...ids].sort();
  }, [role, brandsList, brandId]);
  const brandKey = brandIds.join(',');

  // Initial load + reload when the brand scope changes (super_admin brand
  // switch / brandsList arriving). Fire-and-forget; the store toasts its own
  // errors.
  useEffect(() => {
    loadSubmissionNotifications();
  }, [brandKey, loadSubmissionNotifications]);

  // Dedicated live channels — one per visible brand. Refetch head + count on
  // any new notification for that brand. RLS still clips the fetched feed
  // regardless of the channel filters. Derive the id list from brandKey so the
  // effect's only dependency is the stable key.
  useEffect(() => {
    const ids = brandKey ? brandKey.split(',') : [];
    if (ids.length === 0) return;
    const channels = ids.map((id) =>
      supabase
        .channel(`notifications-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `brand_id=eq.${id}` },
          () => { useStore.getState().loadSubmissionNotifications(); },
        )
        .subscribe(),
    );
    return () => { for (const ch of channels) supabase.removeChannel(ch); };
  }, [brandKey]);
}
