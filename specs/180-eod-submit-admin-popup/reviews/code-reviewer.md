## Code review for spec 180

Scope: the spec 180 hunks only. That covers the migration, `eodPopup.ts`, `useEodSubmitPopup.ts`, the `useSubmissionNotifications.ts` wiring, the db.ts `mapNotificationRow` / `markNotificationsRead` hunks, the `markSubmissionNotificationsRead` store action, the bell and phone update-marker rendering, the i18n keys, and the push-copy mirror.

Checked against the project-specific list:
- All Supabase access in the new code goes through `db.ts`.
- The store mutation is optimistic-then-revert with `notifyBackendError`.
- No inline colours, no `window` / `Alert` use, and no web-only APIs.
- No legacy files touched, and `app.json` is untouched.
- No new realtime channel: the pop-up rides the existing `notifications-{brandId}` channels.
- No custom `jwt` SQL.
- The tests follow the three-track pattern: jest, pgTAP, and the Deno / jest push-copy mirror.
- `derivePushCopy` in `pushNotificationCopy.ts` matches the Deno copy for the `eod_update` branch.

I read the `react-native-toast-message` source to check the replace-in-place and `onHide` behaviour. The hook's assumptions hold (see Nits).

### Critical
- None.

### Should-fix
- `src/i18n/en.json:148` (and the matching `es.json:148` / `zh-CN.json:148`), `src/hooks/useEodSubmitPopup.ts:113-122` — **Toast truncation (the frontend developer's open item).**
  - **Verdict: not a blocker for the feature, but it should be fixed before merge.**
  - What stays visible on the default 340x60, one-line `info` toast: the store, the count, and the verb. Those are the facts a grouped pop-up exists to give. A group of all new submits ("Towson: 4 vendor counts submitted") fits.
  - What gets clipped: the part that matters most for the "mixed" group, `(1 updated)`. AC-4 explicitly requires the copy to still say the group contains updates. In the browser run it clipped to "(1 updat…".
  - It is worse in other locales:
    - es "Frederick: 3 conteos por proveedor enviados (1 actualizados)" is about 60 characters. The marker is lost entirely on a narrow phone.
    - The `text2` line has the same risk, e.g. "by Tara Manager and 2 more · 3 ready to approve". The `readySuffix` is the part that gets clipped.
  - So AC-4's "still says it contains updates" is only partly met in the shipped state.
  - **Preferred fix (small, contained):** register a custom type in `App.tsx`'s `<Toast config={...}>`, e.g. `eodPopup`. Render `BaseToast` with `text1NumberOfLines={2}`, `text2NumberOfLines={2}`, and `style={{ height: 'auto', minHeight: 60, paddingVertical: 8 }}`. Then call `Toast.show({ type: 'eodPopup', ... })` from the hook. `BaseToast` takes these props, but `Toast.show` options cannot set them, which is why the default type cannot be tuned per call.
  - **Cheaper interim fix:** put the marker first so truncation clips the tail, not the signal. For example "{store}: {u} updated, {n} counts" or "{store}: {n} counts ({u} updated)". Drop "vendor" and "submitted" from the group titles. Do this in all three locales.
  - Either way, add one jest assertion on the longest en and es mixed title length, or on the config, so the marker cannot regress silently.

### Nits
- `src/i18n/es.json:148` — "({u} actualizados)" reads wrongly for u=1 ("1 actualizados"). The catalog has no plural support, so reword to something number-neutral, e.g. "({u} con actualizaciones)" or "(incl. actualizaciones: {u})".
- `src/hooks/useEodSubmitPopup.ts:30` — the hook imports `sectionForNotification` from a screen module (`PhoneNotifications.tsx`). That drags the phone sheet's component graph (ResponsiveSheet, the bell helpers) into a hook. The design prescribed it, and `PhoneNotifications` is already mounted by the shell, so there is no cycle today. If the map ever needs a second consumer, move it to `src/lib/` next to `eodPopup.ts`. (Optional; no action needed for this spec.)
- `src/hooks/useEodSubmitPopup.ts:126-129` — the `brandKey` reset effect clears `groupsRef` / `queueRef` but not `visibleKeyRef` or the fallback timer. If a toast is up during a brand switch, tapping it finds no group and only hides the toast (no mark-read). Harmless, since the bell is the durable record. Either reset `visibleKeyRef` too, or add a short comment saying the leftover toast is intentionally inert.
- `src/hooks/useEodSubmitPopup.ts:134-135` — `if (!n || !n.id)` suggests `mapNotificationRow` can return a falsy value, but it throws on `undefined` (`row.id`) and never returns null. Realtime INSERT payloads always carry `new`, so this is theoretical. The guard should be on `raw` (`if (!raw) return;`) before mapping, or the `!n` half dropped.
- `src/hooks/useSubmissionNotifications.ts:74-77` — `loadSubmissionNotifications()` fires before `onPopupInsert`. A click inside the 8 s window while that fetch is still in flight can resolve after `markSubmissionNotificationsRead`'s optimistic flip and briefly show the row unread again. The success-path reload only covers absent ids. Very rare; fixing it would mean sequencing the pop-up before the refetch or comparing `reads` on reload. Mention only.
- `supabase/migrations/20261027000000_eod_update_notifications.sql:253-261` — `emit_eod_update` repeats the store→brand and actor-name resolution that `emit_order_ready` already has. The migration header says this is deliberate and mirrors that emitter. Acknowledged. A shared resolver would be the cleanup if a third emitter appears. (out-of-scope)
- `supabase/migrations/20261027000000_eod_update_notifications.sql:163-172` — `tg_notify_eod_submission` no longer has its own `begin ... exception` envelope. This is fine, because `emit_eod_submit_notification` owns the envelope and the wrapper only passes `new.*` fields through. Someone later adding logic to the wrapper could assume the envelope still protects it. A one-line comment ("envelope lives in the callee; keep this body argument-passing only") would prevent that.

### What I checked and found correct
- `eodPopup.ts` is pure and does not mutate its inputs. The rule order matches §7.2: duplicate, type, self, role, then group.
- The sliding 60 s window is anchored on client receipt time, as designed.
- `markSubmissionNotificationsRead` restores exactly the flipped rows on failure. The two-arg `then` correctly keeps a reload failure from triggering the revert.
- `markNotificationsRead([])` makes no network call.
- The toast library's `show()` on an already-visible toast only swaps data and options and does not call the old `onHide`. So replace-in-place cannot prematurely run `showNext()` and drain the queue. The `onHide` / fallback-timer design is sound.
- `Toast.hide()` inside `onPress` fires `onHide` for the current options. That correctly advances the queue.
- The migration:
  - The `(R)` re-promotion branch closes the cross-type exactly-once gap (AC-11).
  - Guard `(G)` keeps maintenance writes silent.
  - `emit_eod_submit_notification` preserves `new.submitted_by` as the actor on the INSERT path, so the fresh path is behaviour-identical.
  - Every new function revokes EXECUTE from `public, anon, authenticated`.
  - No policy or publication change.
- The i18n key sets are identical across en, es and zh-CN. The `order_ready` single title reuses each locale's existing "Order ready to approve" wording.
- `NotificationBell` and `PhoneNotifications` share the `updateSecondaryLine` helper, so the desktop and phone update markers cannot drift.
