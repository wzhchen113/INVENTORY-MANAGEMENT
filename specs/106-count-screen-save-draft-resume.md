# Spec 106: Save (draft) an unfinished count and resume later

Status: READY_FOR_REVIEW

## User story
As a store manager (admin Inventory count) or a staff counter (Weekly count), I
want a **Save** button that persists the values I have already entered mid-count,
so that when I get interrupted or run out of time I can reopen the screen later,
see my entries restored, and continue counting from where I left off instead of
starting over.

## Problem (grounded)
Both count screens hold their in-progress entries in plain, component-local React
state that is discarded the moment the counter navigates away or the tab/app is
refreshed:

- **Admin Inventory count** — `src/screens/cmd/sections/InventoryCountSection.tsx`:
  `caseCounts` + `unitCounts` (`Record<itemId, string>`, lines 132-133),
  `itemNotes` (134), and the header trio `kind` / `countedAtLocal` / `notes`
  (129-131). No persistence; submit is via `useStore.submitInventoryCount`.
- **Staff Weekly count** — `src/screens/staff/screens/WeeklyCount.tsx`:
  `caseCounts` + `unitCounts` (212-213); submit is via
  `useStaffStore.submitWeeklyCount` with a client-minted `client_uuid` for
  idempotency. No persistence.

Both screens already have the **count-everything gate** (every row must be filled
before submit) and a `firstUncounted` jump helper (`src/lib/countOrder.ts:105`) —
that jump is the natural "resume where I left off" affordance once values are
restored. This feature adds the missing durable-save half.

## Acceptance criteria

- [ ] **AC-1.** On the admin Inventory count screen, a visible **Save** button
  (label from the active locale via the existing i18n catalog) is present
  alongside the existing Submit affordance and is NOT gated by the
  count-everything rule — it persists a partial count with any subset (including
  zero) of rows filled.
- [ ] **AC-2.** On the staff Weekly count screen, the same **Save** button is
  present and likewise ungated by the count-everything rule.
- [ ] **AC-3.** Pressing **Save** persists everything needed to fully resume the
  count for the active `(user, screen, store)` draft slot: for admin Inventory —
  `caseCounts`, `unitCounts`, `itemNotes`, and the header `kind` /
  `countedAtLocal` / `notes`; for staff Weekly — `caseCounts`, `unitCounts`.
  Every draft (server or device-local) carries a **client-stamped `saved_at`**
  timestamp recorded at Save time. On success the counter sees a confirmation
  toast (online: "Draft saved"; offline: see AC-13).
- [ ] **AC-4.** Re-saving overwrites the existing draft for that
  `(user, screen, store)` slot rather than creating a second row — **single slot
  per `(user, screen, store)`**, enforced server-side by a single-slot uniqueness
  contract and client-side by overwrite-on-save (see Project-specific notes for
  the NULL-vendor partial-index gotcha if EOD screens are added in a follow-up).
- [ ] **AC-5.** On opening a count screen for which a draft exists for the current
  `(user, screen, store)`, the previously-entered values are restored into the
  form inputs verbatim (the value the counter typed, e.g. `"0"` stays `"0"`,
  `""` stays empty). The restore is **silent auto-restore** — no up-front
  Resume/Start-fresh prompt.
- [ ] **AC-6.** When a draft is restored, a non-blocking banner reads "Draft
  restored (saved <relative time>)" using the existing relative-time helper
  (`src/utils/relativeTime.ts` on admin; the staff `Banner` component +
  staff i18n on staff), and the screen jumps to the first uncounted row via the
  existing `firstUncounted` helper.
- [ ] **AC-7.** A **Discard draft** affordance is present when a draft is
  restored; confirming it (via the cross-platform confirm util on admin /
  staff-local confirm on staff) deletes the draft — **both the server row and any
  device-local copy** — and clears the restored values back to a fresh form.
- [ ] **AC-8.** On a **successful Submit**, the draft for that
  `(user, screen, store)` slot is deleted — **both the server row and any
  device-local copy** — so reopening the screen after a completed count shows a
  fresh form with no stale banner. Submit itself is unchanged in shape (admin
  `submitInventoryCount`; staff `submitWeeklyCount` with its existing
  `client_uuid` idempotency — the draft path does NOT reuse or interfere with that
  uuid).
- [ ] **AC-9.** Saving a draft does NOT write `current_stock` / `inventory_items`
  and does NOT create an `inventory_counts` / weekly-count history row — a draft
  is purely resumable in-progress state, never an advisory snapshot. Only Submit
  mutates `current_stock` and produces the historical count row (unchanged from
  today).
- [ ] **AC-10.** The draft row is PRIVATE to its author: RLS is owner-scoped
  (`auth.uid() = user_id`) with no admin / super_admin bypass — one user cannot
  read, resume, overwrite, or delete another user's draft (matches spec 103
  `user_count_orders`).
- [ ] **AC-11.** A stale item id in a restored draft (an inventory item deleted
  since the draft was saved) is ignored on restore and never crashes the screen —
  same "ignore deleted ids" tolerance `applyCountOrder` already has for
  `user_count_orders`.
- [ ] **AC-12.** The **count-everything gate is unaffected**: a draft may be
  partial by definition (that is its purpose), but a restored partial draft does
  NOT let Submit proceed with unfilled rows — the existing gate still requires
  every row filled before Submit, exactly as today. Save and Submit remain
  independent affordances.

### Offline / sync criteria (OQ-1 = SERVER + OFFLINE FALLBACK)

- [ ] **AC-13 (online write).** When the client is **online**, Save writes the
  **server** draft row (the source of truth) and updates/clears the device-local
  copy so the two do not diverge. Confirmation toast: "Draft saved".
- [ ] **AC-14 (offline write).** When the client is **offline**, Save writes a
  **device-local** copy (localStorage on admin web-primary; AsyncStorage on staff
  native), marks it **unsynced**, and surfaces "Saved on this device — will sync
  when online" instead of the plain "Draft saved" toast. No error is shown; the
  save succeeds locally.
- [ ] **AC-15 (reconnect sync — whole-draft last-write-wins).** On reconnect (or
  on the next screen open while online), the client reconciles the local and
  server drafts by comparing `saved_at`: the **newer `saved_at` wins**. An
  unsynced local draft **newer** than the server's is **pushed up** to the server
  (and its unsynced flag cleared); a local draft **older** than the server's is
  **discarded** in favor of the server draft. Reconciliation is **whole-draft
  last-write-wins** — there is **no field-level merge** in v1.
- [ ] **AC-16 (restore source selection).** On screen open, the restored values
  come from whichever source is newer by `saved_at`: the server draft when online
  (after AC-15 reconciliation), or the device-local draft when offline or when the
  local copy's `saved_at` is newer than the server's.
- [ ] **AC-17 (cross-device visibility).** An offline-saved draft that syncs to the
  server on reconnect is subsequently visible when the **same user** opens the
  screen from a **different device** (server is the source of truth once synced) —
  subject to AC-10 (still private to that one user; another user never sees it).
- [ ] **AC-18 (test track named).** DB access-control (owner-scoped RLS: author
  can CRUD own draft, a second user cannot see/overwrite/delete it, no privileged
  bypass) is covered by a **pgTAP** DB test. The whole-draft last-write-wins
  reconciliation (newer-`saved_at`-wins, push-vs-discard) and the stale-id
  restore tolerance, if they land as pure helpers alongside `countOrder.ts`, are
  covered by **jest** unit tests. (Track assignment per spec 022; the
  test-engineer routes to the matching track.)

## In scope
- A **Save** button on the admin Inventory count screen
  (`InventoryCountSection.tsx`, count.tsx tab) and the staff Weekly count screen
  (`WeeklyCount.tsx`) — the two screens the owner named (OQ-2).
- Persisting the full in-progress entry state needed to resume (admin Inventory:
  case/unit counts, item notes, header kind/countedAt/notes; staff Weekly:
  case/unit counts) for the current `(user, screen, store)` slot.
- **Server-side primary storage with a device-local offline fallback** (OQ-1):
  a server-side per-user drafts table (spec 103 `user_count_orders` shape, richer
  `payload jsonb`) PLUS a device-local copy written when offline that syncs on
  reconnect. Single slot per `(user, screen, store)`; every draft carries a
  client-stamped `saved_at`; reconciliation is **whole-draft last-write-wins**
  (newer `saved_at` wins), no field-level merge in v1.
- Restoring that state on screen open (silent auto-restore), with a "draft
  restored (saved <time>)" banner, the first-uncounted jump, and a Discard
  affordance (OQ-4).
- Deleting the draft (server row + local copy) on successful Submit and on
  explicit Discard (OQ-5). Single slot, overwrite-on-save, no expiry in v1 — the
  banner's saved-at time is the staleness signal.
- Owner-scoped storage so drafts are private to the author (OQ-6).
- i18n strings for the new Save button (online + offline toast variants), the
  restored-draft banner, and the Discard confirm — routed through the existing
  admin (`useT`) and staff (`useI18n` / staff catalog) i18n paths the count
  screens already use.

## Out of scope (explicitly)
- **Auto-save** (debounced save-on-type). The owner chose an explicit button
  (OQ-3); auto-save is a plausible v2 but adds write-frequency and conflict
  concerns not in this ask. Not doing it in v1.
- **The two EOD count surfaces** (staff EOD daily `EODCount.tsx`; admin EOD
  `EODCountSection.tsx`). The owner scoped v1 to the two named screens (OQ-2);
  the EOD surfaces have the identical lose-your-work problem and are an explicit
  **follow-up spec** that reuses this table. The draft-table `screen` key
  vocabulary MUST NOT preclude them — carry the stable screen keys already
  defined in `countOrder.ts` + `user_count_orders`. Because the EOD surfaces are
  per-vendor, the follow-up's slot key gains a nullable `vendor_id` (the
  `user_count_orders` NULL-vendor partial-index pattern already solves this — see
  Project-specific notes).
- **Multiple named drafts per screen.** Single slot per `(user, screen, store)`,
  overwrite-on-save (OQ-5). A "save as / draft library" is a bigger design.
- **Shared / hand-off drafts** where a coworker continues another user's draft.
  Private v1 (OQ-6); shared drafts are a real op-need but a larger RLS + UX
  design.
- **Draft expiry / TTL sweep.** No background purge in v1; the saved-at time is
  shown so the counter can judge staleness themselves (OQ-5).
- **Field-level merge / conflict UI.** Reconciliation is whole-draft
  last-write-wins by `saved_at` (OQ-1). No per-field merge and no
  "your version vs their version" resolution UI in v1.
- **Reusing the staff `eodQueue` for drafts.** The staff `eodQueue`
  (`src/screens/staff/lib/eodQueue.ts`) is a queue for finished SUBMITS. Drafts
  are a **single-slot overwrite**, not a queue — this spec does NOT enqueue
  drafts through `eodQueue`. It reuses only the **connectivity signal**
  (`useConnectionStatus`) and the offline-then-sync **pattern** as reuse
  candidates, not the queue mechanism (OQ-1).
- **Realtime replay of drafts.** A draft is a private, single-author, in-progress
  scratch; it is NOT added to the `supabase_realtime` publication and no channel
  replays it (matches `user_count_orders`).
- **The `eod_submissions.status = 'draft'` enum value** (init_schema:125). It
  exists but appears unused for this purpose; this spec does NOT repurpose or
  wire it — the path is a dedicated `user_count_drafts` table, not overloading the
  EOD submissions table. Flagged so the architect confirms rather than
  rediscovers.

## Open questions resolved
- **Q (OQ-1): Server-side drafts table vs device-local storage?**
  → **A: SERVER + OFFLINE FALLBACK.** A server-side per-user drafts table
  (spec 103 `user_count_orders` shape, richer `payload jsonb`) is the source of
  truth, PLUS a device-local copy written when offline that syncs on reconnect.
  Single slot per `(user, screen, store)`; every draft carries a client-stamped
  `saved_at`. Online Save → write server (update/clear local); offline Save →
  write device-local, mark unsynced, surface "saved on this device — will sync
  when online". On reconnect / next online open, the **newer `saved_at` wins**
  (unsynced-newer local is pushed up; older local is discarded for the server
  draft) — **whole-draft last-write-wins, no field-level merge** in v1. Restore
  from whichever source is newer. The architect picks the mechanism; the AC pins
  the semantic (AC-13..AC-17). Reuse candidates for the connectivity signal /
  pattern: the staff subtree's `useConnectionStatus` and the offline-submit
  pattern in `src/screens/staff/lib/eodQueue.ts` — the **signal and pattern, NOT
  the queue itself** (drafts are single-slot overwrite). Admin Cmd is
  web-primary → localStorage there.
- **Q (OQ-2): Which screens exactly?**
  → **A: THE 2 NAMED SCREENS** — admin Inventory count
  (`InventoryCountSection.tsx`, count.tsx tab) + staff Weekly count
  (`WeeklyCount.tsx`). Both EOD screens (staff EOD daily, admin EOD) are
  explicitly **Out-of-scope v1** (follow-up spec), but the draft-table `screen`
  key vocabulary must NOT preclude them.
- **Q (OQ-3): Explicit Save button vs auto-save?**
  → **A: Explicit SAVE BUTTON**, no auto-save in v1. Auto-save noted as a future
  enhancement in Out-of-scope.
- **Q (OQ-4): Resume UX — silent restore + banner, or an up-front prompt?**
  → **A: Silent auto-restore on open + "draft restored (saved <time>)" banner + a
  Discard affordance + the first-uncounted jump** (reuse `firstUncounted`). No
  up-front Resume/Start-fresh prompt.
- **Q (OQ-5): Draft lifecycle — single slot, overwrite, delete-on-submit,
  expiry?**
  → **A: Single slot per `(user, screen, store)`; re-save overwrites; DELETED on
  successful submit (server + local); no expiry in v1** — the banner's saved-at
  time is the staleness signal.
- **Q (OQ-6): Per-user privacy vs shared drafts?**
  → **A: PRIVATE to the author** — owner-scoped RLS (`auth.uid() = user_id`), no
  privileged bypass, matching spec 103.

## Dependencies
- **New migration:** a `user_count_drafts` table with owner-scoped RLS, explicit
  grants, and single-slot uniqueness on `(user_id, screen, store_id)` — modeled on
  `supabase/migrations/20260630000500_user_count_orders.sql` (spec 103) but with a
  richer `payload jsonb` (per-item case/unit strings + item notes + admin-Inventory
  header state) and a `saved_at timestamptz` column for last-write-wins
  reconciliation. NOT a literal copy of `user_count_orders` and NOT a new column on
  it. The `screen` CHECK vocabulary must carry the stable screen keys already used
  by `countOrder.ts` + `user_count_orders` so the EOD follow-up is additive.
  Prod-apply is via the Supabase MCP (project memory "Prod migration via Supabase
  MCP"); the developer flags the prod-apply in the handoff so
  `db-migrations-applied.yml` (spec 064) stays green.
- **Device-local store (offline fallback):** localStorage (admin web-primary) /
  AsyncStorage (staff native) holding at most one unsynced draft per
  `(user, screen, store)` slot, each stamped with `saved_at` and an unsynced flag.
- **Connectivity signal:** reuse the staff subtree's `useConnectionStatus`
  (spec 057-059) for the online/offline determination and the offline-then-sync
  **pattern** demonstrated by `src/screens/staff/lib/eodQueue.ts` — signal +
  pattern only, not the queue mechanism.
- **DB access layer.** Admin path goes through `src/lib/db.ts` (save / load /
  delete draft helpers, snake↔camel mapping). Staff path uses the documented
  staff-subtree carve-out (direct `supabase.from/rpc`, spec 063) the way
  `WeeklyCount.tsx` already calls `report_weekly_lowstock` and the countOrder
  helpers — a future spec may migrate these into `db.ts` but this one follows the
  carve-out.
- **Shared pure helper (optional):** if a whole-draft last-write-wins
  reconciliation (`saved_at` compare → push/discard) and/or a stale-id-tolerant
  restore-apply are factored out, they belong alongside `src/lib/countOrder.ts` as
  dependency-free modules both the admin and staff paths import (same pattern that
  keeps the two count-order I/O paths byte-aligned), so one jest unit covers both.
- **i18n catalogs.** New Save / online-toast / offline-toast / banner / discard
  strings in the admin (`useT`) and staff (`useI18n`) catalogs the two screens
  already consume.
- **Existing helpers reused (no change):** `firstUncounted` + `applyCountOrder`
  (`src/lib/countOrder.ts`); `relativeTime` (`src/utils/relativeTime.ts`);
  `confirmAction` (`src/utils/confirmAction.ts`); staff `Banner` + `Button`
  components; staff `useConnectionStatus`.

## Project-specific notes
- **Cmd UI section / legacy:** admin side lands in the existing
  `src/screens/cmd/sections/InventoryCountSection.tsx` (count.tsx tab) — a Cmd UI
  section, not legacy (no legacy admin surface exists; spec 025 deleted it).
- **Which app:** this repo only — admin Cmd UI (`InventoryCountSection`) and the
  folded-in staff surface (`src/screens/staff/screens/WeeklyCount.tsx`, spec 063).
  No sibling-app (customer PWA) work.
- **Per-store or admin-global:** per-store. The draft slot is keyed by
  `(user, screen, store_id)` — `store_id` is part of the identity so a manager's
  Store A draft is distinct from their Store B draft. RLS on the draft table is
  **owner-scoped** (`auth.uid() = user_id`), NOT store-scoped
  (`auth_can_see_store()`), matching `user_count_orders` — the row belongs to the
  authoring user, and the store is a key field, not the access axis. `auth.uid()`
  works on the staff app too (per-user JWT, spec 097-era).
- **Offline / last-write-wins is the key design surface (OQ-1):** the server row
  is the source of truth; a device-local copy is written only when offline and
  reconciled on reconnect by comparing the client-stamped `saved_at` — newer wins,
  whole-draft, no field-level merge in v1. The architect chooses the mechanism
  (where the local copy lives, when the reconcile fires, how `saved_at` is minted
  and compared) but must honor the semantic pinned in AC-13..AC-17. Clock note for
  the architect: `saved_at` is client-stamped, so wall-clock skew between two
  devices is a known limitation of last-write-wins v1 — acceptable for a
  single-author private scratch, flagged so it is a decision and not a surprise.
- **Realtime channels touched:** none. The draft table is deliberately NOT added
  to the `supabase_realtime` publication (private single-author scratch). The
  realtime-publication `docker restart` gotcha does NOT apply here — flagged as an
  ABSENCE so the deploy checklist isn't padded.
- **Migrations needed:** yes — one additive `user_count_drafts` table (server
  primary). The offline fallback is device-local storage and needs no migration.
- **NULL-vendor uniqueness gotcha (deferred to the EOD follow-up, NOT this spec):**
  the two EOD surfaces are per-vendor, so a future slot key gains a nullable
  `vendor_id`. Postgres treats NULL as DISTINCT in unique constraints, so — exactly
  as `user_count_orders` documents (lines 70-90) — a single composite unique on
  `(user_id, screen, store_id, vendor_id)` would NOT enforce one row per no-vendor
  slot; the fix there is TWO partial unique indexes (vendor branch + no-vendor
  branch). For THIS spec the two named screens are non-vendor, so a single unique
  on `(user_id, screen, store_id)` suffices and `vendor_id` is absent — but the
  `screen` CHECK vocabulary and table shape should not block the EOD follow-up
  from adding a nullable `vendor_id` + the partial-index pattern additively.
- **Edge functions touched:** none expected — this is a Postgres-table +
  PostgREST/RPC feature (the `db.ts` path and the staff carve-out), not an edge
  function. No `staff-*` / service-token bearer surface involved.
- **Web/native scope:** both. Admin ships web (Vercel) + native (EAS); the staff
  Weekly screen runs on native and web. The offline-fallback storage is
  platform-split (localStorage on admin web-primary; AsyncStorage on staff
  native), but no affordance is web-only or native-only — Save button, banner, and
  offline toast render on both.
- **`app.json` slug:** untouched — this feature has no bearing on build
  identifiers, and the slug remains `towson-inventory` pending explicit approval.
- **Test tracks (spec 022):** pgTAP for the owner-scoped RLS on the new table
  (author CRUD; second-user denied read/overwrite/delete; no privileged bypass);
  jest for any extracted pure last-write-wins reconciliation helper and stale-id
  restore tolerance. No shell smoke expected.

---

## Backend design

Author: backend-architect. This section is the build contract for spec 106. It
honors the AC-13..AC-17 semantic verbatim (whole-draft last-write-wins by a
client-stamped `saved_at`, single slot per `(user, screen, store)`, no
field-level merge) and picks the mechanism the PM deferred to the architect. It
reuses the spec-103 `user_count_orders` table shape, the spec-103
`fetchCountOrder`/`saveCountOrder` db.ts + staff-carve-out I/O shape, the
spec-097 explicit-grants posture, the staff `useConnectionStatus` +
`useEodSubmit` offline-then-sync **pattern** (not the `eodQueue` mechanism), and
the admin `persistDarkModeLocal` localStorage/AsyncStorage split.

### 0. Design decisions the PM left to the architect (summary, then detail below)

1. **Where the device-local copy lives.** A **single-slot, versioned
   local-storage record per `(user, screen, store)`**, platform-split exactly
   like the existing dark-mode / active-brand / locale caches: `localStorage` on
   admin web-primary, `AsyncStorage` on staff native. NOT the `eodQueue` (that
   is a FIFO of finished submits; a draft is a single-slot overwrite — the spec
   OoS'd reusing it). §6.
2. **When reconcile fires.** On **screen open** (both surfaces) AND on a
   **connectivity false→true flip** (staff, reusing the `wasOnlineRef`
   flip-detector shape from `useEodSubmit` Effect 1; admin web via the admin
   top-level `useConnectionStatus`). §9.

   **CORRECTION (post-impl, spec 106 fix pass):** an earlier draft of this
   decision and of §9 claimed the admin web reconnect uses "the same
   `window 'online'` event `useConnectionStatus` already listens to." That is
   **factually wrong about the admin hook.** The admin
   `src/hooks/useConnectionStatus.ts` (spec 059) subscribes to the Supabase
   **Phoenix realtime SOCKET** (`onOpen`/`onClose`/`onError`), NOT the browser
   `window 'online'`/`'offline'` event. The window-online mechanism is the
   **staff** copy (`src/screens/staff/hooks/useConnectionStatus.ts`, spec 062).
   Because the admin socket flips on heartbeat timeouts / tab-background transport
   drops / slow reconnects (not just genuine connectivity change), it is the wrong
   signal to gate a WRITE — so the admin **Save path is now server-first with
   local-fallback-on-error** (attempt the server write unconditionally; on a
   network-type failure write the device-local unsynced copy + the offline toast,
   which is the AC-13/14 observable — no connectivity oracle on the save path).
   The socket hook remains ONLY the admin reconnect-sync TRIGGER, gated behind a
   restore-once guard so a socket blip cannot re-restore over in-progress typing
   (SF-1). Staff keeps its genuine window-online/NetInfo hook for its
   offline-gated Save, as designed.
3. **How `saved_at` is minted and compared (the clock-skew caveat).**
   `saved_at` is minted client-side as `new Date().toISOString()` at Save time
   and stored on BOTH the server row and the local record. Reconciliation
   compares **`saved_at` string-vs-string only** (ISO-8601 UTC sorts
   lexicographically = chronologically), **local candidate vs server candidate**
   — it **never** compares `saved_at` against the server's wall clock. The table
   also carries a **server-defaulted `updated_at`** for audit/debugging that the
   reconcile logic **must not read**. Tie-break (`saved_at` equal to the byte):
   **server wins** (prefer the already-synced copy; avoids a pointless re-push).
   §4, §11.
4. **Upsert mechanism.** Because the uniqueness contract here is a **single FULL
   `UNIQUE (user_id, screen, store_id)` constraint** (store_id NOT NULL for both
   v1 screens — no NULL-vendor branch), PostgREST `.upsert({ onConflict:
   'user_id,screen,store_id' })` **works** and is the persist path — this is the
   deliberate divergence from spec 103, whose two PARTIAL unique indexes forced a
   delete-then-insert (a partial index can't be an `ON CONFLICT` target). Pinned
   in §4 and §5. Verified against the spec-103 carve-out comment that documents
   the 42P10 it was avoiding.

### 1. Screen-key vocabulary (reuse spec 103's, extend additively)

The draft `screen` CHECK reuses the two v1 non-vendor keys **already defined**
by `CountOrderScreen` in `src/lib/countOrder.ts` and the `user_count_orders`
CHECK: `'admin-inventory'` and `'staff-weekly'`. The EOD follow-up (OoS here)
will add `'admin-eod'` / `'staff-eod'` + a nullable `vendor_id` **additively** —
this migration's CHECK lists only the two live keys so an EOD draft can't be
written before that table shape exists, but the key STRINGS are the same stable
vocabulary, so the follow-up is a CHECK-widen + column-add, never a rename.

**Contract:** the FE MUST pass these exact strings. Do NOT introduce a
`CountDraftScreen` type — reuse `CountOrderScreen` from `src/lib/countOrder.ts`
(the draft screen keys are a subset). This keeps the two features' screen keys
single-sourced.

### 2. Data model changes

**New table — `public.user_count_drafts`.** Migration filename:
`supabase/migrations/20260703000000_user_count_drafts.sql` (next free version;
`20260702000000_report_reorder_for_counted_onhand.sql` is the latest on disk and
`20260702000000` is taken — `20260703000000` sorts cleanly after it and
references only pre-existing `public.profiles` + `public.stores`, so ordering is
safe).

Proposed shape (developer authors the SQL; this is the contract, not committed
DDL):

```
create table if not exists public.user_count_drafts (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  screen     text not null
             check (screen in ('admin-inventory','staff-weekly')),
  store_id   uuid not null references public.stores(id) on delete cascade,
  -- Full resumable in-progress state. Shape is screen-specific (see §3); the
  -- DB stores it opaquely as jsonb and never introspects it. NOT NULL, default
  -- '{}' so a row always round-trips to a valid (if empty) form.
  payload    jsonb not null default '{}'::jsonb
             check (jsonb_typeof(payload) = 'object'),
  -- CLIENT-stamped at Save time (new Date().toISOString()). The
  -- last-write-wins comparison key (AC-15/16). Compared local-vs-server only,
  -- NEVER against now(). See §11 clock-skew caveat.
  saved_at   timestamptz not null,
  -- SERVER-defaulted audit column. NOT the reconcile key — reconcile must not
  -- read it. Present for debugging / future TTL sweep (OoS in v1).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Single slot per (user, screen, store): a FULL unique constraint (all three
  -- cols NOT NULL → no NULL-distinctness gotcha, unlike spec 103's partial
  -- indexes). This IS a valid ON CONFLICT target, so the persist is a plain
  -- upsert (§4).
  constraint user_count_drafts_slot_uq unique (user_id, screen, store_id)
);
```

- **Additive + non-destructive.** Fresh table, no change to any existing table,
  no backfill (drafts are user-created at runtime; the 286 KB seed adds zero
  rows). Instant in PG 17. Reversible-by-design (repo has no down-migration
  convention): `drop table public.user_count_drafts cascade;`.
- **Indexes.** The unique constraint's backing index
  `(user_id, screen, store_id)` fully covers the only read pattern
  (`where user_id = auth.uid() and screen = $1 and store_id = $2`). No separate
  index needed. Do NOT add a `saved_at` index — no query orders by it (reconcile
  compares two single rows in the client).
- **`payload jsonb` vs typed columns.** Deliberately opaque jsonb (not per-field
  columns) because the two screens' payload shapes differ (admin carries the
  header trio + itemNotes; staff carries only case/unit maps) and the EOD
  follow-up adds a third shape. A typed-column table would need a migration per
  new screen; jsonb keeps the table stable and pushes shape-validation into the
  jest-covered pure serializers (§8). This mirrors the spec-103 rationale for a
  jsonb `item_ids` array over a row-per-item table.

**Prod-apply.** This repo applies prod migrations via the Supabase MCP (project
memory "Prod migration via Supabase MCP"; do not drift via dashboard SQL
editor). The developer does NOT `supabase db push` (no prod password); flag the
prod-apply to the user in the handoff so `db-migrations-applied.yml` (spec 064)
stays green — a repo migration missing from prod's `schema_migrations`
hard-fails that gate. Verify functions/tables post-apply per the memory's
normalized-md5 note.

### 3. Payload shapes (the jsonb contract, per screen)

The pure serializers in `src/lib/countDrafts.ts` (§8) own these shapes. Stored
under the jsonb `payload` column. Values are the **verbatim typed strings** the
counter entered (AC-5: `"0"` stays `"0"`, `""` stays `""`), never coerced to
numbers — a draft is resumable form state, not a computed submission.

**`admin-inventory` payload:**
```
{
  "v": 1,
  "kind": "spot" | "open" | "mid_shift" | "close",
  "countedAtLocal": string,          // the datetime-local input value verbatim
  "notes": string,                   // header notes
  "caseCounts":  { [itemId: string]: string },
  "unitCounts":  { [itemId: string]: string },
  "itemNotes":   { [itemId: string]: string }
}
```

**`staff-weekly` payload:**
```
{
  "v": 1,
  "caseCounts": { [itemId: string]: string },
  "unitCounts": { [itemId: string]: string }
}
```

- `"v": 1` is a payload schema version so a future shape change (e.g. the EOD
  follow-up, or adding a field) is detectable; the deserializer treats an
  unknown/missing `v` defensively (return an empty-but-valid draft rather than
  throw — same tolerant posture as `hydrateQueue`).
- **Stale-item-id filtering (AC-11).** The deserializer does NOT filter; the
  APPLY step does. `applyDraftToForm(payload, liveItemIds)` drops any
  `caseCounts`/`unitCounts`/`itemNotes` key whose id is not in the current
  store's live item-id set, silently (mirrors `applyCountOrder`'s "ignore
  deleted ids"). Covered by jest. This runs on restore for both surfaces.
- The admin header `kind` is validated against the four-value enum on
  deserialize; an out-of-enum value falls back to `'spot'` (the screen default)
  rather than crashing the segmented control.

### 4. API contract (PostgREST, not RPC)

**Decision: PostgREST table access, no RPC.** Rationale: the operation is a
straight owner-scoped single-row read / upsert / delete with RLS doing the
authorization — identical to how spec 103 chose PostgREST for
`user_count_orders`. An RPC would add a SECURITY DEFINER surface for zero
benefit (no cross-row invariant, no privileged escalation, no server-side
computation). The `saved_at` last-write-wins reconciliation is **client-side**
(the client holds both candidates); the server is a dumb single-slot store.

Three operations, all owner-scoped and all pinning `.eq('user_id', userId)` as
defense-in-depth on top of RLS:

- **READ** `GET user_count_drafts?user_id=eq.<uid>&screen=eq.<screen>&store_id=eq.<storeId>`
  → `.maybeSingle()`. Response: the row (`{ payload, saved_at, ... }`) or `null`
  when no row exists (the no-draft state; NOT an error). On genuine error the
  caller degrades to "no draft" and the form renders fresh (AC-5 restore is
  best-effort; a failed fetch must not block the count).
- **SAVE (upsert)** `POST user_count_drafts` with
  `Prefer: resolution=merge-duplicates`, i.e. supabase-js
  `.upsert({ user_id, screen, store_id, payload, saved_at, updated_at: now-iso },
  { onConflict: 'user_id,screen,store_id' })`. **This is the pinned
  divergence from spec 103:** the FULL unique constraint is a legal `ON CONFLICT`
  target, so a single `.upsert` replaces the whole row (whole-draft overwrite,
  AC-4). No delete-then-insert, no 42P10. The developer MUST use
  `onConflict: 'user_id,screen,store_id'` (matching the constraint columns) — a
  mismatched or omitted `onConflict` would 42P10 or duplicate.
- **DISCARD / delete-on-submit** `DELETE user_count_drafts?user_id=eq.<uid>&screen=eq.<screen>&store_id=eq.<storeId>`.
  Deletes the one slot. Used by both Discard (AC-7) and successful-Submit
  cleanup (AC-8).

**Error cases:**
- Cross-user read/write/delete → RLS returns 0 rows (read/delete) or 42501
  (insert/upsert WITH CHECK) — the pgTAP suite pins this (§13). The FE never
  relies on a cross-user path succeeding.
- Missing store (`__all__` / no active store on admin) → the FE does not call
  save/fetch/delete at all (guarded, same as the spec-103 count-order effect
  guards on `storeId === '__all__'`).
- Malformed payload jsonb → the CHECK (`jsonb_typeof = 'object'`) rejects a
  non-object; the FE serializer always emits an object, so this is
  defense-in-depth.

### 5. `src/lib/db.ts` surface (admin path — tracked)

Three new helpers alongside the spec-103 `fetchCountOrder`/`saveCountOrder`/
`resetCountOrder` block (§ "COUNT-SCREEN CUSTOM ORDER"), each wrapped in
`useInflight.getState().track(...)` with an `abortSignal(signal)` on every query
(matching the spec-103 helpers exactly). snake_case→camelCase mapping is minimal
— the row maps to a small typed object, not a `mapItem`-scale entity.

```ts
// The camelCase shape the admin screen consumes. `payload` stays as the raw
// jsonb object (the pure serializer in countDrafts.ts owns its shape); only
// the row envelope is camelCased.
export type CountDraftRow = {
  payload: Record<string, unknown>;   // CountDraftPayload (see countDrafts.ts)
  savedAt: string;                    // ISO-8601, client-stamped (saved_at)
};

// READ on screen open. Returns the row or null (no draft). kind:'read'.
export async function fetchCountDraft(
  userId: string,
  screen: CountOrderScreen,           // 'admin-inventory' | 'staff-weekly'
  storeId: string,
): Promise<CountDraftRow | null>;

// SAVE (upsert whole-draft). savedAt is minted by the CALLER at Save time
// (so the same value lands on the local copy and the server row — §6/§11).
// kind:'write'. Uses .upsert({ onConflict:'user_id,screen,store_id' }).
export async function saveCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
  payload: Record<string, unknown>,   // CountDraftPayload, already serialized
  savedAt: string,                    // ISO-8601 the caller stamped
): Promise<void>;

// DELETE the slot (Discard + delete-on-submit). kind:'write'.
export async function deleteCountDraft(
  userId: string,
  screen: CountOrderScreen,
  storeId: string,
): Promise<void>;
```

- The `screen`/`store_id` `.eq(...)` filters + `user_id` pin exactly mirror the
  spec-103 helpers. `fetchCountDraft` selects `payload, saved_at` and camelCases
  `saved_at`→`savedAt` inline (no `mapItem`).
- `saveCountDraft` sets `updated_at: new Date().toISOString()` on the upsert
  (server audit column) but the AUTHORITATIVE ordering value is the caller's
  `savedAt` — the helper does not mint `saved_at` itself, because the local copy
  must carry the identical stamp for reconcile to be a true whole-draft compare.
- All three throw on PostgREST error so the store slice can revert + toast via
  `notifyBackendError` (admin) / `notifyBackendError` (staff).

**Local-storage helpers (admin, in db.ts or a small `src/lib/countDraftLocal.ts`
— developer's call, but keep the platform split identical to
`persistDarkModeLocal`).** These are NOT `track()`ed (they're synchronous
localStorage on web / best-effort AsyncStorage on native, not PostgREST):

```ts
// Local single-slot record. One per (user, screen, store) key.
export type LocalCountDraft = {
  payload: Record<string, unknown>;
  savedAt: string;      // ISO, same stamp as the server copy when synced
  unsynced: boolean;    // true = written offline, not yet pushed to server
};

export function readLocalCountDraft(
  userId: string, screen: CountOrderScreen, storeId: string,
): LocalCountDraft | null;                    // web: sync; native: see note

export function writeLocalCountDraft(
  userId: string, screen: CountOrderScreen, storeId: string,
  rec: LocalCountDraft,
): void;                                       // best-effort, never throws

export function clearLocalCountDraft(
  userId: string, screen: CountOrderScreen, storeId: string,
): void;
```

Storage key: `imr.countDraft.<screen>.<storeId>.<userId>` on admin (namespaced
under `imr.*` like `LOCALE_KEY` / `ACTIVE_BRAND_KEY`). The `userId` is in the
key so a shared web browser (two managers, same device) never cross-reads —
belt-and-suspenders on top of the fact that offline drafts are private scratch.
Native `AsyncStorage` is async; the admin surface is web-primary so the
common-path read is synchronous localStorage — on native the helper returns
`null` synchronously and a best-effort async hydrate is acceptable (admin native
is a minority surface; the server copy is the source of truth when online). The
developer may make the admin local read async-aware if cleaner; the SEMANTIC that
matters is single-slot + `unsynced` flag + `savedAt` stamp.

### 6. Staff path (carve-out — direct supabase, no track)

A parallel `src/screens/staff/lib/countDrafts.ts`, mirroring the spec-103
`src/screens/staff/lib/countOrder.ts` carve-out: the SAME three server
operations authored a second time against `supabase.from('user_count_drafts')`
directly (no `useInflight.track`, plain `await`), re-exporting the pure helpers
+ types from `src/lib/countDrafts.ts` so the only testable logic stays
single-sourced. This is the documented spec-063 staff-subtree carve-out (I/O
call sites, not pure logic).

Local storage on staff uses **AsyncStorage** with a versioned key, modeled on
`eodQueue`'s `LOCALE_KEY` / `ACTIVE_STORE_KEY` constants (NOT the `eodQueue`
array itself):

```
export const COUNT_DRAFT_KEY_PREFIX = 'imr-staff:count-draft:v1';
// full key: `imr-staff:count-draft:v1:<screen>:<storeId>:<userId>`
```

- Single record per slot (overwrite, not append) — the OoS'd `eodQueue` is a
  FIFO of finished submits; drafts are single-slot. A `readLocalStaffDraft` /
  `writeLocalStaffDraft` / `clearLocalStaffDraft` trio wraps `AsyncStorage`
  get/set/remove with a shape-validator (reject a malformed record → treat as no
  draft, back up corrupt bytes the way `eodQueue.backupCorrupt` does — optional
  but consistent). Never throws; a write failure logs + is surfaced by the
  staff `notifyBackendError`, matching `eodQueue`'s best-effort-durability
  posture.
- The `:v1` suffix follows the `eodQueue` migration-contract convention: bump it
  if the local record shape changes; document the transform.

### 7. Edge function changes

**None.** This is a Postgres-table + PostgREST feature (the db.ts path + the
staff carve-out). No `staff-*` / service-token bearer surface. No `verify_jwt`
decision. Confirmed against the spec's "Edge functions touched: none expected."

### 8. Shared pure helpers — `src/lib/countDrafts.ts` (dependency-free, jest-covered)

New module alongside `src/lib/countOrder.ts`, same posture: no `supabase`, no
React, no store — so BOTH the admin path (db.ts) and the staff carve-out import
it without violating the carve-out (which is about `supabase.from/rpc` call
sites, not pure helpers). This is the AC-18 jest surface.

```ts
import type { CountOrderScreen } from './countOrder';   // reuse the screen type

// The reconcile candidate: a draft plus its client-stamped saved_at and an
// origin tag. `unsynced` only meaningful for the local candidate.
export type DraftCandidate = {
  payload: Record<string, unknown>;
  savedAt: string;                 // ISO-8601, client-stamped
} | null;

// WHOLE-DRAFT LAST-WRITE-WINS (AC-15/16). Pure. Compares saved_at
// string-vs-string (ISO UTC sorts chronologically). NEVER reads server now().
//   - both null            → { winner: null, action: 'none' }
//   - only one present     → that one wins; action 'push' if the local is the
//                            lone unsynced one, else 'adopt'/'none'
//   - local.savedAt  >  server.savedAt → local wins, action 'push'  (sync up)
//   - local.savedAt  <  server.savedAt → server wins, action 'adopt-clear-local'
//   - equal (byte-for-byte)            → SERVER wins, action 'clear-local-flag'
// Returns which source to RESTORE from and what sync action the caller runs
// (push local → server, or drop local in favor of server). Field merge is
// explicitly NOT done (v1). Signature is the unit-test seam for AC-15/16.
export function reconcileDrafts(
  local: (DraftCandidate & { unsynced: boolean }) | null,
  server: DraftCandidate,
): {
  winner: DraftCandidate;
  restoreFrom: 'local' | 'server' | 'none';
  action: 'none' | 'push' | 'adopt-clear-local' | 'clear-local-flag';
};

// STALE-ID-TOLERANT APPLY (AC-11). Pure. Given a deserialized payload and the
// set of live item ids for the current store, returns a payload with every
// per-item map (caseCounts/unitCounts/itemNotes) filtered to live ids only.
// Deleted-since ids are dropped silently. Header fields (kind/countedAtLocal/
// notes) pass through untouched. Jest-covered.
export function applyDraftStaleFilter(
  payload: Record<string, unknown>,
  liveItemIds: ReadonlySet<string>,
): Record<string, unknown>;

// (DE)SERIALIZERS per screen (AC-3). Pure + total; tolerant on malformed input
// (return an empty-but-valid payload rather than throw — hydrateQueue posture).
export function serializeAdminInventoryDraft(form: {
  kind: string; countedAtLocal: string; notes: string;
  caseCounts: Record<string,string>; unitCounts: Record<string,string>;
  itemNotes: Record<string,string>;
}): Record<string, unknown>;
export function deserializeAdminInventoryDraft(
  payload: Record<string, unknown>,
): { kind: 'spot'|'open'|'mid_shift'|'close'; countedAtLocal: string;
     notes: string; caseCounts: Record<string,string>;
     unitCounts: Record<string,string>; itemNotes: Record<string,string> };
export function serializeWeeklyDraft(form: {
  caseCounts: Record<string,string>; unitCounts: Record<string,string>;
}): Record<string, unknown>;
export function deserializeWeeklyDraft(
  payload: Record<string, unknown>,
): { caseCounts: Record<string,string>; unitCounts: Record<string,string> };
```

The staff `src/screens/staff/lib/countDrafts.ts` re-exports these (as
`countOrder.ts` re-exports `applyCountOrder`/`firstUncounted`), so the staff
screen imports the entire draft surface from one staff-local module.

**Jest coverage (AC-18):** `src/lib/countDrafts.test.ts` — `reconcileDrafts`
(all six branches incl. the equal-tie server-wins and the lone-unsynced-push),
`applyDraftStaleFilter` (drops deleted ids across all three maps; header passes
through), the round-trip (serialize→deserialize identity for both shapes), and
the malformed-payload tolerance (unknown `v`, non-object, out-of-enum `kind`).

### 9. Reconcile timing + `saved_at` minting (the offline/sync flow)

**On screen open (both surfaces).** The existing count-order load effect already
runs on mount/store change; add a **parallel** draft-load effect (do not fold
into the order effect — different table, different failure degrade). Flow:
1. `readLocal*Draft(uid, screen, storeId)` → local candidate (may be null /
   unsynced).
2. If online: `fetchCountDraft(uid, screen, storeId)` → server candidate.
   If offline: server candidate is null (skip the fetch).
3. `reconcileDrafts(local, server)`:
   - `action: 'push'` → `saveCountDraft(...)` with the local's `savedAt` +
     payload, then `writeLocal*Draft` with `unsynced: false`.
   - `action: 'adopt-clear-local'` → `clearLocal*Draft` (server is newer).
   - `action: 'clear-local-flag'` → rewrite local `unsynced: false` (already in
     sync).
   - `restoreFrom` selects which payload feeds the form.
4. If a winner exists → `applyDraftStaleFilter(payload, liveItemIds)` →
   deserialize → set the form state, show the "Draft restored (saved <rel>)"
   banner, and jump to `firstUncounted` (reuse the existing helper).

**On connectivity false→true flip.** Reuse the `useEodSubmit` Effect-1 shape — a
`wasOnlineRef` that fires a **reconcile-and-push** when `!was && isOnline`. This
is the "sync on reconnect" half of AC-15: an unsynced local draft newer than the
server gets pushed; an older one is dropped. It calls the SAME reconcile flow as
screen-open (steps 2-3, minus the form re-apply if the user is mid-typing — do
NOT clobber in-progress edits on a reconnect that happens while the screen is
focused; only push/clear the storage, and refresh the banner's saved-at).

**CORRECTION (post-impl, spec 106 fix pass):** the flip TRIGGER differs by
surface, and an earlier draft mislabeled the admin one. **Staff** uses its genuine
`window 'online'`/NetInfo `useConnectionStatus` (spec 062). **Admin web** uses the
admin top-level `useConnectionStatus` (spec 059), which flips on the Supabase
**realtime SOCKET** (`onOpen`/`onClose`), NOT the browser `window 'online'` event
— so its flip has a reconnect-latency tail (Phoenix backoff up to ~10s) and can
toggle on transport blips. Two consequences the implementation now handles: (a)
the admin **Save path does not consult this hook at all** — it is server-first
with local-fallback-on-error (see §0.2 correction); (b) the **draft-load RESTORE
is guarded by a restore-once-per-slot ref on BOTH surfaces** (SF-1), so a socket
blip that re-runs the effect pushes/clears storage but never re-applies values
over in-progress typing. Admin native's hook is web-only chrome (optimistic-true),
so admin native relies on the screen-open reconcile (minority surface).

**`saved_at` minting.** At **Save-button press**, mint `const savedAt = new
Date().toISOString()` ONCE. Pass that identical string to BOTH `saveCountDraft`
(server) and the local write (fallback) so the server row and the local record are
byte-identical when synced — this is what makes the equal-tie case a true "same
write, already synced" no-op rather than a spurious push.

### 10. Realtime impact

**None — and this is a deliberate ABSENCE, not an omission.** `user_count_drafts`
is a private single-author scratch; it is NOT added to the `supabase_realtime`
publication and no channel (`store-{id}` / `brand-{id}`) replays it — matching
`user_count_orders` (spec 103) and per the spec's "Realtime channels touched:
none." **The `docker restart supabase_realtime_imr-inventory` publication gotcha
does NOT apply to this migration** (the migration makes no
`alter publication supabase_realtime add table ...` change). Flagged as an
absence so the deploy checklist isn't padded. Cross-device visibility (AC-17) is
achieved by the server being the source of truth once synced + the screen-open
fetch on the other device — NOT by realtime push.

### 11. Risks, tradeoffs, and the clock-skew caveat (explicit)

- **Client-clock skew (the PM-flagged caveat — now a documented decision).**
  `saved_at` is client-stamped, so two devices with skewed wall clocks can pick
  the "wrong" winner under last-write-wins. Mitigations baked into the design:
  (a) reconcile compares `saved_at` **local-vs-server only, never against server
  `now()`** — the two candidates are both client-stamped, so at least the
  comparison is apples-to-apples per device family; (b) the same-user
  single-author scope means skew only matters across THAT user's own devices,
  which is a narrow, low-stakes window for a private scratch; (c) the server
  `updated_at` audit column lets a human diagnose a suspected skew incident
  post-hoc. Accepted limitation for v1, exactly as the PM scoped — no NTP, no
  server-authoritative timestamp, no vector clock. **If** a future spec makes
  drafts shared/handed-off, this must be revisited (a server-stamped
  monotonic sequence would replace client `saved_at`).
- **Non-atomic offline→online push.** The reconnect push is
  `saveCountDraft` then `writeLocal(unsynced:false)` — two steps, not atomic. If
  the process dies between them, the local stays `unsynced: true` and the next
  reconcile re-pushes the SAME `saved_at`+payload → the equal-tie
  `clear-local-flag` no-op corrects it. Idempotent by construction (same shape
  as the `eodQueue` write-then-remove ordering rationale). No data loss.
- **Upsert `onConflict` correctness.** The single FULL unique constraint makes
  `.upsert` legal here — but the developer MUST pass
  `onConflict: 'user_id,screen,store_id'`. A regression to spec-103-style
  delete-then-insert is unnecessary and would introduce a torn-write window this
  design avoids. Pinned in §4; the post-impl review should confirm the upsert
  path (not delete+insert) landed.
- **Grants gate interaction (spec 097).** The new table is postgres-owned and
  inherits the no-TRUNCATE `anon/authenticated` grant + `ALL` for `service_role`
  via `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` (migration 20260618000000).
  The migration MUST **also re-state the explicit grants** at the table's birth
  (idempotent, matches `item_vendors` / `user_count_orders`):
  `grant select, insert, update, delete, references, trigger ... to anon,
  authenticated;` + `grant all ... to service_role;`. **CORRECTION to the
  dispatch prompt:** the table does **NOT** get added to the
  `public_grants_explicit` pgTAP **allowlist**. The allowlist is ONLY for tables
  that deliberately `REVOKE` a grant from anon/authenticated (Category A — the
  two audit tables). `user_count_drafts` HOLDS the SELECT grant, so the probe's
  **positive** arm (1) asserts it automatically as a new public base table — no
  allowlist edit, and adding one would wrongly stop asserting the grant. See the
  probe header's Category A vs B distinction
  (`supabase/tests/public_grants_explicit.test.sql:63-100`). The developer must
  NOT touch that test file for this table (arm 1 covers it for free); the only
  DB test to WRITE is the RLS pgTAP in §13.
- **Permissive-policy lint (spec 053).** The four owner-scoped policies use
  `auth.uid() = user_id` as the WHOLE clause — not trivially-wide, no OR-tail —
  so `permissive_policy_lint.test.sql` passes with NO allowlist edit (identical
  to spec 103's four policies). One permissive policy per command; no
  `auth.uid() IS NOT NULL` arm that the OR-compose rule would let shadow the
  owner scope.
- **Performance on the 286 KB seed.** Zero rows added by seed (runtime-created).
  Reads are single-row by PK-equivalent unique index. No N+1, no scan. Payload
  jsonb for a full-store weekly count is bounded by item count (~hundreds of
  short string entries) — well under any practical jsonb/localStorage limit
  (the `eodQueue` quota note establishes AsyncStorage headroom at ~12k items).
- **RLS gap check.** Owner-scoped, no admin/super_admin bypass (AC-10). The
  pgTAP suite (§13) pins that a second user — including a super_admin JWT —
  cannot read/update/delete/spoof-insert another user's draft. No
  `auth_can_see_store()` (wrong axis — the row belongs to the user, store is a
  key field) and no `auth_is_admin()` (staff write these too).
- **Cold-start.** N/A — no edge function.

### 12. Migration ordering

`20260703000000` sorts after the latest on disk
(`20260702000000_report_reorder_for_counted_onhand.sql`). It references only
`public.profiles` and `public.stores`, both long-established, so there is no
forward-reference hazard. Additive; no down-migration (repo convention).

### 13. Test tracks (AC-18)

- **pgTAP — `supabase/tests/user_count_drafts_rls.test.sql`** (new). Mirror
  `supabase/tests/user_count_orders_rls.test.sql` shape (JWT-claims injection,
  hermetic `begin; ... rollback;`, two seed profiles A/B + a synthetic
  super_admin). Assertions (owner-scoping is the core AC-10 surface):
  1. A inserts its own `(admin-inventory, storeX)` draft → succeeds.
  2. A reads it back → 1 row, expected `payload` + `saved_at` (round-trip).
  3. B SELECTs A's row → 0 rows (RLS hides).
  4. B UPDATE of A's row → 0 rows affected (RLS USING denies).
  5. B DELETE of A's row → 0 rows affected.
  6. B INSERT of a row `user_id = A` under `staff-weekly` → 42501 (WITH CHECK
     spoof guard).
  7. super_admin JWT SELECTs A's row → 0 rows (NO admin bypass, AC-10).
  8. A upserts the SAME `(admin-inventory, storeX)` slot a 2nd time → still
     exactly ONE row, `payload` reflects the 2nd write (the FULL-unique
     `ON CONFLICT` fired — the single-slot + whole-draft-overwrite contract, the
     analog of spec-103 arm 9 but for the full constraint, not a partial index).
  9. A writes `(staff-weekly, storeX)` → coexists with the `admin-inventory`
     row (2 distinct screen keys for the same user+store).
  10. A writes `(admin-inventory, storeY)` → coexists with `(admin-inventory,
      storeX)` (store_id is part of the slot identity — per-store slots, matching
      the "Per-store" project note).
  11. A deletes `(admin-inventory, storeX)` → gone; the `staff-weekly` and
      `storeY` rows are UNTOUCHED (single-slot delete, delete-on-submit/Discard
      analog).
  (Plan ~11; the developer finalizes the count. The permissive-policy lint +
  the grants probe cover the policy-shape and grant invariants automatically —
  do NOT duplicate them here.)
- **jest — `src/lib/countDrafts.test.ts`** (new). `reconcileDrafts` branches
  (both-null, one-present, local-newer-push, server-newer-adopt, equal-tie
  server-wins, lone-unsynced-push), `applyDraftStaleFilter` (drops deleted ids
  from all three maps, header untouched), serialize↔deserialize round-trip for
  both payload shapes, malformed-payload tolerance. This is the single jest unit
  that covers BOTH admin and staff (they import the same pure module).
- **jest — screen restore flows (optional, if the screens are unit-testable).**
  The spec's AC-18 scopes the mandatory jest to the pure helpers; the screens'
  restore-on-open banner + first-uncounted-jump can be covered by a render test
  if the existing count-screen test harness supports it (the staff `WeeklyCount`
  already has `testID`-rich rows; the admin section is web-render-testable). The
  test-engineer routes final coverage.
- **No shell smoke.** Consistent with the spec.

### 14. Frontend store impact + wiring points

- **Admin `InventoryCountSection.tsx` (count.tsx tab).** No `useStore.ts` slice
  change is strictly required — the draft state can live in the section's local
  React state (the count form already does: `caseCounts`/`unitCounts`/
  `itemNotes`/`kind`/`countedAtLocal`/`notes` are all `useState` at lines
  129-134). Add: a **Save** button in the `TabStrip` `rightSlot` next to SUBMIT
  COUNT (AC-1, ungated by `nonBlankCount`); a draft-load effect parallel to the
  spec-103 `fetchCountOrder` effect (301-324); a restored-draft banner + Discard
  affordance (reuse `confirmAction` for the Discard confirm, `relativeTime` for
  the saved-at); delete-on-submit wired into the existing `onSubmit` success
  block (after line 518's form-clear, call `deleteCountDraft` + `clearLocal`).
  The optimistic-then-revert + `notifyBackendError`/Toast pattern applies to
  Save (offline branch shows the "saved on this device" toast instead of "Draft
  saved" — AC-13/14). The `firstUncounted` jump helper is already imported
  context (via `applyCountOrder`); admin Inventory has no gate, so the jump on
  restore is a scroll/focus affordance, not a submit-blocker.
- **Staff `WeeklyCount.tsx`.** Same shape against the staff carve-out. Add: a
  **Save** button (staff `Button`) near the footer Submit (AC-2, ungated); a
  draft-load effect parallel to the spec-103 `fetchCountOrder` effect (272-294);
  the `useConnectionStatus` hook (already used across the staff subtree) driving
  the offline toast + the reconnect-sync effect (§9, `wasOnlineRef` shape from
  `useEodSubmit`); a restored-draft `Banner` (staff component) + Discard (staff
  confirm); delete-on-submit in the `onSubmit` success block (after line 526's
  form-clear). Reuse `firstUncounted` (already imported) for the restore jump.
  No `useStaffStore` slice change strictly required — draft state can stay in the
  screen's local state (case/unit maps already are), and the staff store has no
  realtime to reconcile against. If the developer prefers a small
  `useStaffStore` slice for the unsynced-draft indicator, that is acceptable but
  not mandated; keep it isolated (slice-isolated is the staff-store convention).
- **i18n.** New strings both catalogs: Save button label, "Draft saved" (online
  toast), "Saved on this device — will sync when online" (offline toast), "Draft
  restored (saved {time})" banner, "Discard draft" + its confirm body. Route
  through the admin `useT` and staff `useI18n`/`t` paths the two screens already
  consume (the spec-103 `section.countOrder.*` and `weekly.*` namespaces are the
  precedent — add a `section.countDraft.*` / `weekly.draft.*` sub-namespace).

### 15. Summary of files the build will touch

Backend (backend-developer):
- `supabase/migrations/20260703000000_user_count_drafts.sql` (new table + RLS +
  explicit grants).
- `supabase/tests/user_count_drafts_rls.test.sql` (new pgTAP).
- `src/lib/db.ts` (add `fetchCountDraft` / `saveCountDraft` / `deleteCountDraft`
  + the local-storage trio, or a sibling `countDraftLocal.ts`).
- `src/lib/countDrafts.ts` (new pure module) + `src/lib/countDrafts.test.ts`
  (new jest).
- `src/screens/staff/lib/countDrafts.ts` (new staff carve-out I/O + local
  storage).
- Prod-apply of the migration via Supabase MCP (flag to user; keeps
  `db-migrations-applied.yml` green).

Frontend (frontend-developer):
- `src/screens/cmd/sections/InventoryCountSection.tsx` (Save button, draft-load
  effect, banner, Discard, delete-on-submit).
- `src/screens/staff/screens/WeeklyCount.tsx` (same + `useConnectionStatus`
  offline branch + reconnect-sync).
- i18n catalogs (admin + staff): new Save / online-toast / offline-toast /
  banner / discard strings.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in
  specs/106-count-screen-save-draft-resume.md.
  Backend-developer owns §2 (migration 20260703000000_user_count_drafts.sql —
  table, four owner-scoped RLS policies via auth.uid() = user_id, explicit
  grants matching item_vendors/user_count_orders; do NOT add the table to the
  public_grants_explicit allowlist — arm 1 covers it, see §11), §5 (db.ts
  fetch/save/delete draft helpers + local-storage trio, tracked reads/writes
  with abortSignal, .upsert onConflict 'user_id,screen,store_id' — NOT
  delete-then-insert), §6 (staff carve-out I/O), §8 (src/lib/countDrafts.ts pure
  reconcile/stale-filter/(de)serialize helpers), and the two DB/jest test files
  in §13. Flag the prod-apply-via-MCP in your handoff so db-migrations-applied
  stays green.
  Frontend-developer owns §14 (Save button ungated on both screens, draft-load
  effect, restored-draft banner + relativeTime, Discard via confirmAction /
  staff confirm, delete-on-submit + clear-local, offline toast + reconnect-sync
  via useConnectionStatus on staff) and §14's i18n strings in both catalogs.
  Both: after implementation set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/106-count-screen-save-draft-resume.md

## Files changed

Status note: BOTH slices are now complete and validated. The BACKEND slice
landed first (migration + pure/local/carve-out modules + db.ts helpers + the two
backend test files, all listed below). The FRONTEND slice (§14 — the two count
screens' Save/restore/banner/Discard/offline wiring + i18n catalogs + the two
render-test files) landed second; `Status:` is now `READY_FOR_REVIEW`.

### Backend (backend-developer)

Migrations:
- `supabase/migrations/20260703000000_user_count_drafts.sql` (new) — the
  `public.user_count_drafts` table: `payload jsonb` (default `'{}'`, CHECK
  `jsonb_typeof = 'object'`), client-stamped `saved_at`, server-defaulted
  `created_at`/`updated_at` audit cols, FULL `unique (user_id, screen,
  store_id)` (store_id NOT NULL), `screen` CHECK `('admin-inventory',
  'staff-weekly')`, four owner-scoped RLS policies (`auth.uid() = user_id`),
  explicit grants mirroring `user_count_orders`/`item_vendors`. NOT added to the
  `public_grants_explicit` allowlist (§11 — arm 1 covers it). NOT added to the
  `supabase_realtime` publication (§10). **Prod-apply PENDING** via Supabase MCP
  (project `ebwnovzzkwhsdxkpyjka`) — flagged so `db-migrations-applied.yml`
  stays green (see Handoff below).

src/lib (admin path):
- `src/lib/db.ts` (modified) — added `fetchCountDraft` / `saveCountDraft` /
  `deleteCountDraft` + the `CountDraftRow` type, in a new "COUNT-SCREEN
  SAVE-DRAFT + RESUME (Spec 106)" block after the spec-103 `resetCountOrder`.
  All three `track()`ed with `.abortSignal(signal)`; `saveCountDraft` uses
  `.upsert({ onConflict: 'user_id,screen,store_id' })` (NOT delete-then-insert);
  caller-minted `savedAt` passed through unchanged.
- `src/lib/countDraftLocal.ts` (new) — admin device-local trio
  (`readLocalCountDraft` / `writeLocalCountDraft` / `clearLocalCountDraft`) +
  `LocalCountDraft`, localStorage(web)/AsyncStorage(native) split mirroring
  `persistDarkModeLocal`, key `imr.countDraft.<screen>.<storeId>.<userId>`. Kept
  out of `db.ts` so that file stays PostgREST-only (design §5 allows the
  sibling).
- `src/lib/countDrafts.ts` (new) — the dependency-free PURE module:
  `reconcileDrafts` (whole-draft last-write-wins, six branches, tie→server),
  `applyDraftStaleFilter` (stale-id tolerance), per-screen (de)serializers,
  `COUNT_DRAFT_PAYLOAD_VERSION`. Imported by both the admin and staff paths.

src/screens/staff (carve-out):
- `src/screens/staff/lib/countDrafts.ts` (new) — the same three server ops
  authored directly against `supabase.from('user_count_drafts')` (no `track()`),
  the AsyncStorage local trio (`readLocalStaffDraft` / `writeLocalStaffDraft` /
  `clearLocalStaffDraft`) with key `imr-staff:count-draft:v1:<screen>:<storeId>:<userId>`
  + shape-validator/backupCorrupt, and re-exports of the pure `countDrafts.ts`
  helpers/types.

Tests:
- `supabase/tests/user_count_drafts_rls.test.sql` (new pgTAP, plan 11) —
  owner-scoped RLS: owner CRUD + round-trip, cross-user read/update/delete
  denied, WITH-CHECK spoof 42501, super_admin no-bypass, FULL-unique upsert
  replace, per-screen + per-store coexistence, single-slot delete.
- `src/lib/countDrafts.test.ts` (new jest, 20 tests) — `reconcileDrafts`
  branches, `applyDraftStaleFilter`, serialize↔deserialize round-trips (both
  shapes), malformed-payload tolerance.

Validation run (backend slice):
- Migration applied to the LOCAL stack; owner-scoped RLS proven live (owner
  upsert+read = 1 row; cross-user read = 0 rows; cross-user spoof-insert raises
  the RLS violation).
- `scripts/test-db.sh` — 60/60 DB test files pass (permissive-policy lint +
  grants probe green automatically, unchanged).
- `npx jest` — 76/76 suites, 818/818 tests pass.
- `npx tsc --noEmit` — clean (exit 0).

### Frontend (frontend-developer)

Screens (§14):
- `src/screens/cmd/sections/InventoryCountSection.tsx` (modified) — admin
  count.tsx tab. Added: a **Save draft** button in the `TabStrip` `rightSlot`
  (UNGATED by `nonBlankCount` — AC-1/AC-12; ghost/outlined style, left of SUBMIT
  COUNT); a `draftSavedAt`/`savingDraft` local-state pair (draft form state
  reuses the existing kind/countedAtLocal/notes/case/unit/itemNotes useState —
  no slice change); a draft-load effect parallel to the spec-103 `fetchCountOrder`
  effect (read local → fetch server when online → `reconcileDrafts` → run sync
  action → `applyDraftStaleFilter` → `deserializeAdminInventoryDraft` → restore +
  banner); a reconnect draft-sync effect (`wasOnlineRef` false→true flip, pushes
  a newer unsynced local without clobbering edits); `onSaveDraft` (mints one
  `savedAt`; online → `saveCountDraft` + synced local + "Draft saved"; offline →
  unsynced local + "Saved on this device"; server-error → unsynced-local +
  failure toast); `onDiscardDraft` (`confirmAction` → `deleteCountDraft` +
  `clearLocalCountDraft` + clear form, AC-7); delete-on-submit in the `onSubmit`
  success block (`deleteCountDraft` + `clearLocalCountDraft`, AC-8); and a
  restored-draft banner (`relativeTime(savedAt)` + Discard, testIDs
  `inv-draft-banner`/`inv-draft-discard`/`inv-save-draft`). Uses the ADMIN
  top-level `useConnectionStatus` (no staff-subtree import).
- `src/screens/staff/screens/WeeklyCount.tsx` (modified) — staff Weekly. Added:
  a **Save draft** button (staff `Button`, `variant="secondary"`, UNGATED —
  AC-2) above the footer Submit; `draftSavedAt`/`savingDraft` state +
  `isOnline`/`wasOnlineRef` (via the staff `useConnectionStatus`); a draft-load
  effect (runs once items load; read AsyncStorage → fetch server when online →
  `reconcileDrafts` → sync action → `applyDraftStaleFilter` → `deserializeWeeklyDraft`
  → restore + banner + `firstUncounted` jump); a sync-on-reconnect effect
  (`wasOnlineRef` false→true, pushes a newer unsynced local, design §7);
  `onSaveDraft` (online/offline/error branches, staff Toast copy);
  `onDiscardDraft` (`confirmAction` → `deleteCountDraft` + `clearLocalStaffDraft`
  + clear maps); delete-on-submit in the `onSubmit` success block; and a
  restored-draft `Banner` (tone `info`) + a staff-styled Discard link (testIDs
  `weekly-draft-banner`/`weekly-draft-discard`/`weekly-save-draft`). Imports the
  shared `relativeTime` for the `{time}` slot.

i18n (both catalogs, all three languages — parity + placeholder tests green):
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` (modified) — new
  `section.countDraft.*` sub-namespace: `save`, `saved`, `savedLocal`,
  `restored` (`{time}`), `discard`, `discardConfirmTitle`, `discardConfirmBody`,
  `saveFailed`.
- `src/screens/staff/i18n/en.json`, `.../es.json`, `.../zh-CN.json` (modified) —
  new `weekly.draft.*` sub-namespace with the same eight keys (`restored`
  carries the `{time}` token in all three locales — staff placeholder-parity
  test enforced).

Tests (§13 / AC-18 screen restore-flow coverage):
- `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx` (new,
  7 tests) — full-render admin restore flow with db.ts / `countDraftLocal` /
  `useConnectionStatus` / `confirmAction` mocked and `useStore` seeded: restore
  newer-server, restore newer-local (+ push + unsynced-clear), stale-id filtered
  out, Discard clears server+local+form, Save ungated (empty form writes), and
  offline Save marks unsynced (no server write).
- `src/screens/staff/screens/WeeklyCount.test.tsx` (modified, +7 tests in a new
  spec-106 describe) — restore newer-server, restore newer-local (+ push),
  stale-id ignored, Discard clears server+local+form, submit clears server+local,
  offline Save marks unsynced + offline toast, and reconnect (offline→online
  flip) pushes the unsynced local up. Extended the file's `mockQueryBuilder` with
  a `user_count_drafts` branch and added `useConnectionStatus` + `confirmAction`
  mocks + an AsyncStorage reset.

Validation run (frontend slice):
- `npx tsc --noEmit` — clean (exit 0).
- `npx jest` (FULL suite) — 77/77 suites, 832/832 tests pass (14 new spec-106
  render tests + the pre-existing 818). i18n catalog-parity + staff
  placeholder-parity suites green.
- Live-DB contract round-trip against the local `user_count_drafts` table as the
  admin user (JWT via password grant): the exact FE PostgREST calls —
  upsert(`on_conflict=user_id,screen,store_id`)→201, select(payload,saved_at)→200
  with the verbatim payload, re-upsert same slot→200 (single-slot overwrite,
  AC-4 — table stayed at 1 row), delete→204 (table→0 rows). Confirms the
  `db.ts`/carve-out helpers issue exactly the requests the live RLS + unique
  constraint accept.
- Web bundle: the Expo web `AppEntry.bundle` compiles clean (12.8 MB, HTTP 200,
  no Metro build error) with all spec-106 FE symbols (`serializeAdminInventoryDraft`,
  `reconcileDrafts`, `applyDraftStaleFilter`, `readLocalCountDraft`,
  `writeLocalStaffDraft`, `deserializeWeeklyDraft`) and the new i18n strings
  present in the compiled app graph — both edited screens + all new imports build
  for web.
- **Browser-driver caveat:** the interactive `preview_*` click-through tools were
  NOT available in this session (Bash/Read/Write/Edit only). In-browser
  verification was therefore done at the bundle-compiles + live-DB-contract +
  render-test level (above), not a manual click-through of the running UI. Stated
  explicitly per project norm rather than claimed.

### Review fix pass (frontend-developer, post-review)

Resolves the review Criticals + Should-fixes + untested-ACs + nits from
`specs/106-count-screen-save-draft-resume/reviews/{code-reviewer,backend-architect,test-engineer}.md`.

Frontend:
- `src/screens/cmd/sections/InventoryCountSection.tsx` (modified) —
  (C2) `onSaveDraft` rewritten **server-first with local-fallback-on-error**: the
  Save path no longer reads `useConnectionStatus` (which tracks the realtime
  SOCKET — false-flips on websocket blips, hardcoded-true on admin native); it
  attempts the server write unconditionally, and on a network-type rejection
  writes the device-local unsynced copy + the offline toast (the AC-14
  observable), no error toast. (SF-1) added a `restoredSlotRef` restore-once
  guard on the draft-load effect: the form RESTORE fires at most once per
  `(user, store)` slot, so a socket-blip re-run of the `isOnline`-keyed effect
  syncs storage but never re-applies over in-progress typing. (AC-6) wired the
  first-uncounted jump on restore — new `jumpToFirstUncounted` (reuses the shared
  `firstUncounted`) + `pendingFocusId`/`firstInputRefs` + a focus effect that
  focuses the target row's primary input on restore (mirrors the staff jump;
  admin has no submit gate so it is a scroll/focus affordance). (discard-fail)
  `onDiscardDraft` is now server-first: it awaits `deleteCountDraft` and only
  clears the local copy + form on success; on failure it keeps the banner +
  values and shows `discardFailed` (no silent resurrection). (nit) the Save
  button in-flight label routes through the new `section.countDraft.saving` i18n
  key instead of the bare `'SAVING…'` literal.
- `src/screens/staff/screens/WeeklyCount.tsx` (modified) — (SF-1) same
  `restoredSlotRef` restore-once guard on the draft-load effect. (discard-fail)
  same server-first `onDiscardDraft` (await server delete; keep banner + values +
  `weekly.draft.discardFailed` toast on failure). Staff KEEPS its window-online
  `useConnectionStatus` + offline-gated Save (a genuine connectivity signal, as
  designed) — the server-first Save change is admin-only.

i18n (both catalogs, all three languages — parity + placeholder tests green):
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` (modified) — added
  `section.countDraft.saving` and `section.countDraft.discardFailed`.
- `src/screens/staff/i18n/en.json`, `.../es.json`, `.../zh-CN.json` (modified) —
  added `weekly.draft.discardFailed`.

Pure module + doc alignment:
- `src/lib/countDrafts.ts` (modified, nit/finding-6) — corrected the
  `COUNT_DRAFT_PAYLOAD_VERSION`, `deserializeAdminInventoryDraft`, and
  `deserializeWeeklyDraft` doc comments to state the deserializers read
  forward-tolerantly and do NOT version-gate on `v` (the prior "unknown-`v`
  tolerance" wording overstated the code). Tightened the `reconcileDrafts`
  local-only branch comment to state the invariant directly (a local-only
  candidate is always the push winner) instead of the "what-if" hedge. No logic
  change.

Tests:
- `src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx`
  (modified) — (C1/TS2556) the three db.ts mocks now declared as bare `jest.fn()`
  (permissive signature) so the `(...a: unknown[]) => mockFn(...a)` re-forwarding
  type-checks under `tsconfig.test.json` (resolved values set in `beforeEach`).
  (AC-14) the offline-Save test now rejects the server write (server-first path)
  and asserts local-unsynced + offline toast + no error toast. (AC-9, new) a Save
  press asserts `submitInventoryCount` is NOT called. (AC-17, new) a fresh mount
  with an empty local slot restores a server-only draft (client half of
  cross-device visibility; pgTAP owner-read covers the DB half).
- `src/screens/staff/screens/WeeklyCount.test.tsx` (modified) — (C1/TS2556)
  `draftUpsert`/`draftDelete` declared as bare `jest.fn()`. (AC-9, new) Save press
  asserts `submitWeeklyCount` NOT called. (AC-17, new) fresh mount with empty
  AsyncStorage restores a server-only draft. (nit) removed the dead `twoItems()`
  helper from the spec-106 describe.
- `src/lib/countDrafts.test.ts` (modified, finding-6) — retitled the
  admin-deserialize tolerance test to describe what it actually exercises
  (forward-tolerant field reading, no `v`-gating).

Spec prose (finding-7 / SF-2):
- `specs/106-count-screen-save-draft-resume.md` §0.2 + §9 — corrected the claim
  that admin `useConnectionStatus` listens to the window `'online'` event (it
  tracks the realtime socket; the window-event version is the staff copy) and
  noted the admin Save path is now server-first/error-fallback + the SF-1
  restore-once guard.

Validation run (fix pass):
- `npx tsc --noEmit` — clean (exit 0).
- `npx tsc -p tsconfig.test.json --noEmit` (CI Track 1a) — clean (exit 0); the
  four TS2556 errors are gone.
- `npx jest` (FULL suite) — 77/77 suites, 836/836 tests pass (+4 net-new:
  admin/staff AC-9 + AC-17).
- `scripts/test-db.sh` — 60/60 DB test files pass (no SQL change; confirmed no
  regression).
- **Browser-driver caveat (unchanged):** the interactive `preview_*` tools remain
  unavailable in this session; the fix-pass changes are exercised by the
  full-render jest suites (which mount the real components and assert on the real
  reconcile/restore/discard/save/first-uncounted wiring), typecheck, and pgTAP.
  Stated explicitly rather than claimed.
