// Spec 149 (AC-7): TS mirror of the push title/body derivation that ships
// inside supabase/functions/submission-push-fanout/index.ts (`TYPE_LABEL`,
// `ISSUE_CATEGORY_LABEL`, `derivePushCopy`). This module is NOT imported by
// that edge function (different bundle — Deno, deployed one function at a
// time); it exists exclusively as the jest-testable mirror, exactly like
// src/utils/escapeHtml.ts mirrors the send-*-email functions' inline
// escapeHtml() (CLAUDE.md, spec 028).
//
// Identity with the Deno copy is enforced at code-review time. If you change
// one, change the other in the same commit.
//
// Nothing in the app imports this file at runtime.

// Human-facing type labels for the push title.
export const TYPE_LABEL: Record<string, string> = {
  eod: 'EOD count',
  weekly: 'Weekly count',
  waste: 'Waste log',
  receiving: 'Delivery received',
  po: 'Purchase order',
  missed_eod: 'Missed EOD count',
  issue: 'Issue reported',
  // Spec 149 (AC-7) — the review ASK, not a "… submitted" FYI. The default
  // branch below renders `${label} submitted`, which is exactly the copy AC-7
  // forbids for this type, so order_ready gets its own branch too.
  order_ready: 'Order ready to approve',
};

// Spec 126 — short human labels for the issue category badge in the push body.
export const ISSUE_CATEGORY_LABEL: Record<string, string> = {
  equipment: 'Equipment',
  inventory: 'Inventory',
  app_tech: 'App/Tech',
  other: 'Other',
};

export type PushCopyNotification = {
  type?: string | null;
  actor_name?: string | null;
  store_name?: string | null;
  category?: string | null;
  body?: string | null;
};

export function derivePushCopy(
  notif: PushCopyNotification,
): { title: string; body: string } {
  const label = TYPE_LABEL[notif.type as string] ?? 'Submission';
  if (notif.type === 'issue') {
    const categoryLabel = ISSUE_CATEGORY_LABEL[notif.category as string] ?? (notif.category ?? '');
    const rawMsg = (notif.body ?? '') as string;
    const preview = rawMsg.length > 100 ? `${rawMsg.slice(0, 100)}…` : rawMsg;
    return {
      title: 'Issue reported',
      body: [notif.store_name ?? '', categoryLabel, preview].filter(Boolean).join(' · '),
    };
  }
  if (notif.type === 'missed_eod') {
    return {
      title: 'Missed EOD count',
      body: `${notif.store_name ?? ''} · ${notif.actor_name ?? ''}`.trim(),
    };
  }
  if (notif.type === 'order_ready') {
    return {
      title: 'Order ready to approve',
      body: [notif.store_name ?? '', notif.body ?? ''].filter(Boolean).join(' · '),
    };
  }
  return {
    title: `${label} submitted`,
    body: `${notif.actor_name ?? 'A user'} · ${notif.store_name ?? ''}`.trim(),
  };
}
