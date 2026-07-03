# Spec 106 — backend-architect post-implementation drift review

Mode: post-implementation review (Status stays READY_FOR_REVIEW; I do not change it).
Scope: verify BOTH slices against the `## Backend design` I authored — migration
`20260703000000_user_count_drafts.sql`, `src/lib/db.ts` draft helpers,
`src/lib/countDraftLocal.ts`, `src/lib/countDrafts.ts`, the staff carve-out
`src/screens/staff/lib/countDrafts.ts`, the pgTAP suite, and the two FE screens
(`InventoryCountSection.tsx`, `WeeklyCount.tsx`) + i18n + render tests.

**Verdict: the contract landed faithfully.** Data model, RLS, grants, upsert
mechanism, pure-module single-sourcing, staff carve-out, and realtime-absence all
match the design byte-for-intent. One genuine behavioral defect (SF-1, a
mid-count re-restore that can clobber unsaved edits), which the FE-dev's
connection-hook choice materially amplifies on admin; one design-prose correction
(SF-2); the flagged hook deviation itself is **within design intent** (M-1). No
Critical.

---

## Contract conformance (matches design — no action)

- **§2 table.** `payload jsonb not null default '{}'` + `check (jsonb_typeof = 'object')`,
  client-stamped `saved_at timestamptz not null`, server-defaulted
  `created_at`/`updated_at`, FULL `unique (user_id, screen, store_id)` with all
  three cols NOT NULL, `screen` CHECK `('admin-inventory','staff-weekly')`. Exactly
  the §2 shape. Additive, references only `profiles`+`stores`.
  (`supabase/migrations/20260703000000_user_count_drafts.sql:62-93`).
- **§2/§11 RLS.** Four owner-scoped policies, each a single permissive policy per
  command with `auth.uid() = user_id` as the WHOLE clause — no admin/super_admin
  bypass, no `auth_can_see_store()`, no OR-tail. Passes the spec-053 permissive
  lint without an allowlist edit, as designed
  (`...user_count_drafts.sql:143-164`).
- **§11 grants.** Explicit `grant select, insert, update, delete, references,
  trigger … to anon, authenticated;` + `grant all … to service_role;`, TRUNCATE
  omitted for anon/authenticated. NOT added to the `public_grants_explicit`
  allowlist — correct: the table HOLDS the SELECT grant, so probe arm 1 asserts it
  for free (the §11 CORRECTION to the dispatch prompt was honored)
  (`...user_count_drafts.sql:121-123`).
- **§10 realtime.** No `alter publication supabase_realtime add table …`. The
  `docker restart supabase_realtime_imr-inventory` gotcha correctly does NOT apply
  — flagged as a deliberate absence in the migration header. Matches
  `user_count_orders`.
- **§4/§5 upsert (the pinned divergence from spec 103).** Both the admin
  `saveCountDraft` (`src/lib/db.ts:2153-2177`) and the staff carve-out
  (`src/screens/staff/lib/countDrafts.ts:104-125`) use a PLAIN
  `.upsert({ onConflict: 'user_id,screen,store_id' })` — NOT delete-then-insert.
  The full unique constraint is a legal ON CONFLICT target; pgTAP arm 8 proves the
  2nd upsert replaces rather than duplicates
  (`supabase/tests/user_count_drafts_rls.test.sql:239-267`). This is the exact
  §0.4 decision.
- **§5 tracked + abortSignal (admin).** `fetchCountDraft`/`saveCountDraft`/
  `deleteCountDraft` are each wrapped in `useInflight.getState().track(...)` with
  `.abortSignal(signal)` and `kind: 'read'|'write'` labels, mirroring the spec-103
  helpers (`src/lib/db.ts:2112-2199`). Caller-minted `savedAt` is passed through
  unchanged; the helper never mints it. `updated_at` set to a fresh server stamp
  but never read by reconcile.
- **§0.3 reconcile semantic (single-sourced pure module).** `reconcileDrafts`
  compares `saved_at` **string-vs-string only** (ISO UTC → lexicographic =
  chronological), local-candidate vs server-candidate, **never** against `now()`
  or `updated_at`; tie (byte-equal) → SERVER wins → `clear-local-flag`. All six
  branches present and correct (`src/lib/countDrafts.ts:103-142`). Lives in the
  dependency-free `src/lib/countDrafts.ts` with no `supabase`/React/store import;
  the staff module RE-EXPORTS it (`src/screens/staff/lib/countDrafts.ts:40-59`) —
  no logic fork. This is the §8 single-source contract exactly.
- **§3 payload shapes + tolerance.** `serialize*`/`deserialize*` stamp `v: 1`,
  pass values through verbatim (AC-5), and are total/tolerant (unknown `v`,
  non-object, out-of-enum `kind` → empty-but-valid, never throw). `kind` validated
  against the four-value enum with `'spot'` fallback. `applyDraftStaleFilter` drops
  deleted ids across all three per-item maps and passes header fields through
  untouched (`src/lib/countDrafts.ts:159-315`).
- **§6 staff carve-out.** Direct `supabase.from('user_count_drafts')`, no
  `track()`, plain `await`, throws on error → staff `notifyBackendError`.
  AsyncStorage local trio with the exact `imr-staff:count-draft:v1:<screen>:<storeId>:<userId>`
  key, `backupCorrupt` on malformed bytes, and a documented `:v1` migration
  contract (`src/screens/staff/lib/countDrafts.ts:104-290`). Faithful to §6.
- **§5 admin local-storage.** `src/lib/countDraftLocal.ts` kept OUT of `db.ts`
  (keeps db.ts PostgREST-only, allowed by §5), localStorage(web)/AsyncStorage(native)
  split mirroring `persistDarkModeLocal`, key `imr.countDraft.<screen>.<storeId>.<userId>`,
  best-effort never-throws. Matches §5.
- **§9 `saved_at` minting.** Both `onSaveDraft` handlers mint `const savedAt = new
  Date().toISOString()` ONCE and pass the identical string to both the server
  upsert and the local write, so the equal-tie is a true "already synced" no-op
  (`InventoryCountSection.tsx:563`, `WeeklyCount.tsx:520`). Correct.
- **§7/§14 FE lifecycle.** Save ungated on both screens (guarded only by
  store-selection + in-flight); reconcile fires on screen-open AND on a
  connectivity false→true flip; delete-on-submit + Discard clear BOTH sides
  (server row + local copy), including the `conflict:true` replay branch (AC-8);
  first-uncounted jump reused on staff restore. i18n keys present in all six
  catalogs with `{time}` token parity; `relativeTime` returns a terse "3m" so the
  "saved {time} ago" template reads "saved 3m ago" (no doubling).
- **§13 tests.** pgTAP plan 11 covers owner CRUD + round-trip, cross-user
  read/update/delete denial, WITH-CHECK spoof 42501, super_admin no-bypass,
  full-unique upsert replace, per-screen + per-store coexistence, single-slot
  delete. The jest pure-module + the two render suites exercise reconcile branches,
  stale-filter, restore-newer-server/newer-local(+push), Discard, offline-save.

---

## SF-1 (Should-fix) — mid-count re-restore can silently clobber unsaved edits; the realtime-socket hook amplifies it on admin

**Both screens.** `InventoryCountSection.tsx:439-496` and `WeeklyCount.tsx:402-458`.

The draft-load effect is keyed on `isOnline` (admin deps
`[currentUser?.id, storeId, isOnline]`; staff `[userId, activeStore, isOnline, loading]`)
and, whenever a winner exists, calls `restoreDraftToForm(winner.payload, …)`
**unconditionally** — which does `setCaseCounts(form.caseCounts)` /
`setUnitCounts(...)` (+ header on admin), overwriting whatever the counter has
typed. There is no "already restored once" ref and no "form still pristine" guard.
Contrast the *reconnect* effect (admin `:503-548`, staff `:464-509`), which is
deliberately careful to touch only storage + the banner and NOT the form — the
design's §9 anti-clobber rule. That same discipline is missing from the
**draft-load** effect, and the draft-load effect is the one wired to `isOnline`.

Reachable sequence (admin web, the amplified case):
1. Open screen → socket seed optimistic-true → `isOnline` true → server draft
   restores → user starts typing new values.
2. Realtime heartbeat times out / tab backgrounds / transport blips → admin
   `useConnectionStatus` (`src/hooks/useConnectionStatus.ts`, Phoenix socket
   `onClose`) flips `isOnline`→false → draft-load effect re-runs (server fetch
   skipped; reconcile against local-or-null).
3. Socket reopens (Phoenix backoff 1–10s) → `onOpen` → `isOnline`→true →
   draft-load effect re-runs AGAIN → server fetch → winner = the last-saved server
   draft → `restoreDraftToForm` → **the user's in-progress keystrokes since the
   last Save are overwritten with the last-saved draft.**

Why the hook choice matters here (ties into the flagged deviation): the admin
top-level hook flips on realtime **socket** state, which toggles on heartbeat
timeouts, tab-background transport drops, and slow reconnects — materially more
often than a genuine `navigator online`/`offline` transition. The staff hook
(window-online / NetInfo) flips only on real connectivity change, so staff hits
this far less, but the same effect structure means staff is not immune when
connectivity genuinely drops and returns mid-count.

Data-loss surface is bounded (only keystrokes since the last explicit Save are at
risk; Save is explicit, so the last Save survives), which is why I rate this
Should-fix rather than Critical — but it is a silent overwrite of user input on a
routine realtime blip, which is exactly the "lose your work" failure this spec set
out to eliminate.

Fix options (either is in-design):
- Add a `restoredOnceRef` (or `hasRestoredForSlotRef` keyed on `${uid}:${storeId}`)
  so the draft-load RESTORE fires at most once per slot-mount; let the reconnect
  effect own all post-first-open sync (it already does, without clobbering). This
  decouples restore from `isOnline` re-runs.
- Or gate the re-restore on "form still pristine" (no non-blank entry the user has
  added since open) before calling `restoreDraftToForm`.

Either keeps the AC-15/16 reconcile semantic (the reconnect effect still pushes an
unsynced-newer local and the screen-open path still restores the winner) while
removing the clobber.

---

## SF-2 (Should-fix, design artifact) — correct the §0.2/§9 prose that mislabels the admin connection hook

The design I wrote states (§0.2 decision 2, and again §9) that admin web reconnect
uses "the same `window 'online'` event `useConnectionStatus` already listens to."
That is **factually wrong about the admin hook**: `src/hooks/useConnectionStatus.ts`
(spec 059) subscribes to the Supabase **Phoenix realtime socket**
(`onOpen`/`onClose`/`onError` via `realtime.socketAdapter.getSocket()`), NOT to the
browser `window online`/`offline` event. The `window online/offline` mechanism is
the **staff** copy (`src/screens/staff/hooks/useConnectionStatus.ts`, spec 062).

The implementation is correct; the design text is not. Leaving the prose as-is is a
trap: a future maintainer could "fix" the admin hook to match the false description,
or wire a redundant `window online` listener into the admin surface. Recommend a
one-line correction to §0.2/§9 in the spec noting the admin hook is
realtime-socket-driven (with the reconnect-latency-tail consequence, see M-1) and
the staff hook is window-online/NetInfo-driven. Flagged as SF because it directly
feeds the SF-1 amplification and the M-1 assessment; no code change for this item
itself.

---

## M-1 (Minor / accepted) — the flagged hook deviation is WITHIN design intent

The FE-dev used the admin top-level `useConnectionStatus` (realtime socket) for the
admin section and the staff `useConnectionStatus` (window-online/NetInfo) for the
staff screen, to avoid crossing the staff-subtree import boundary. **Ruling: within
design intent, accept.** Reasoning:

- The AC pins the *semantic* (AC-15/16: "on reconnect OR on the next screen open
  while online, reconcile … newer `saved_at` wins"), not the transport that detects
  the reconnect. Both the socket-open flip and the screen-open fetch satisfy it.
- Importing the staff-subtree hook into the admin section would be a fresh
  carve-out crossing; adding a bespoke `window online` listener to admin would be a
  new pattern. The architect rules ("reuse existing patterns; justify new ones")
  make the FE-dev's choice the *lower-drift* option. Correct call.
- Correctness consequence is a **reconnect-latency tail**, not a false negative that
  loses data: on admin web, `isOnline` can stay false for up to ~10s after PostgREST
  is actually reachable (Phoenix reconnect backoff), delaying the unsynced-local
  push. The push is not dropped — it fires when the socket finally opens, or on the
  next screen-open reconcile. Idempotent by construction (§11). Socket-open is also
  a *stronger* signal than raw connectivity (same Supabase host), so false-positive
  "online but REST down" is unlikely.
- Admin native: the hook is web-only chrome → optimistic-true permanently → the
  offline branch and reconnect flip never fire on admin native. The design already
  accepted admin native as a minority surface relying on screen-open reconcile
  (§5/§9). Consistent.

The only reason this isn't a clean pass is that the hook choice feeds SF-1's
frequency — so fixing SF-1 (restore-once guard) neutralizes the downside of this
deviation entirely, at which point M-1 is a pure non-issue.

---

## Minor notes (no action required)

- **M-2.** Admin native local read returns `null` synchronously
  (`countDraftLocal.ts:72-86`), so an offline draft saved on admin *native* is not
  re-read until online (server becomes the source). This is the explicit §5
  "admin native is a minority surface; server is authoritative when online"
  trade-off — in-design, noting for completeness.
- **M-3.** The admin draft-load effect's `restoreDraftToForm` intentionally omits
  `liveItemIds` from deps (documented, `:491-495`) so an inventory realtime nudge
  doesn't re-run the reconcile. Correct — the stale-filter captures the item set at
  open, and a fixed SF-1 (restore-once) makes this moot anyway.
- **M-4.** pgTAP arm 6 spoof-insert uses `throws_ok(..., '42501', null, ...)`,
  matching the `user_count_orders_rls` shape; the WITH-CHECK denial is correctly a
  raised error (not a 0-row no-op like the UPDATE/DELETE arms). Good.

---

## Prod-apply reminder (not a finding — deploy gate)

The migration is marked **prod-apply PENDING** via Supabase MCP (project
`ebwnovzzkwhsdxkpyjka`) in the spec's `## Files changed`. Until it is applied to
prod's `schema_migrations`, the `db-migrations-applied.yml` gate will hard-fail
(a repo migration missing from prod). This is a release-coordinator / deploy
checklist item, surfaced here so it is not lost.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 4 findings — 0 Critical, 2 Should-fix
  (SF-1 mid-count re-restore clobbers unsaved edits, amplified by the admin
  realtime-socket connection hook, fix with a restore-once guard on both draft-load
  effects; SF-2 correct the design §0.2/§9 prose that mislabels the admin
  useConnectionStatus as window-online when it is realtime-socket-driven), 1 Minor
  accepted (M-1: the flagged hook deviation is within design intent — the AC pins
  the reconcile semantic, not the transport; fixing SF-1 removes its only downside),
  plus minor notes. Contract (table/RLS/grants/upsert/pure-module/carve-out/realtime
  absence) landed faithfully. Deploy note: migration prod-apply via MCP is still
  PENDING and the db-migrations-applied gate will be red until it lands.
payload_paths:
  - specs/106-count-screen-save-draft-resume/reviews/backend-architect.md
