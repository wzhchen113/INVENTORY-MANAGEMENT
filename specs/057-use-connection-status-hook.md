# Spec 057: Extract useConnectionStatus hook from TitleBar

Status: READY_FOR_ARCH

## User story

As a developer maintaining the Cmd UI, I want connection-status polling
encapsulated in a reusable hook so that tests can mock the hook boundary
(not the supabase client), the `TitleBar` component contains no direct
`lib/supabase` import, and the project's "all PostgREST/RPC traffic
flows through `src/lib/db.ts`" convention holds.

## Acceptance criteria

- [ ] New file `src/hooks/useConnectionStatus.ts` exports
      `useConnectionStatus(): boolean` (returns `connected`), preserving
      the current TitleBar semantics: optimistic `true` when no channels
      yet, else `channels.some(c => c.state === 'joined' || c.state === 'subscribed')`.
- [ ] The hook owns the `setInterval(..., 2000)` poll and the
      `supabase.realtime.channels` read currently inlined at
      `src/components/cmd/TitleBar.tsx:86-100`.
- [ ] `TitleBar.tsx` removes the `import { supabase } from '../../lib/supabase'`
      line (line 6) and replaces lines 85-100 with
      `const connected = useConnectionStatus();`.
- [ ] `TitleBar.test.tsx` removes the `jest.mock('../../lib/supabase', ...)`
      block introduced during spec 055 Pass-2 and replaces it with
      `jest.mock('../../hooks/useConnectionStatus', () => ({
      useConnectionStatus: () => true }))` (or the equivalent shape the
      test-engineer prefers).
- [ ] New jest test for the hook itself at
      `src/hooks/useConnectionStatus.test.ts` (or `.tsx`) covers:
      empty-channels → `true`; one channel with state `'joined'` → `true`;
      one channel with state `'closed'` → `false`; mixed states → `true`
      if any joined/subscribed; cleanup clears the interval on unmount.
- [ ] No UI change — pixel-equivalent render before vs after; manual
      browser check shows the same green/amber dot + "connected" /
      "reconnecting" label.
- [ ] No behavioral change — polling cadence stays at 2000 ms; initial
      tick fires immediately on mount as today.
- [ ] No new connection states added — the hook returns the same boolean
      shape `TitleBar` consumes today.

## In scope

- Create `src/hooks/useConnectionStatus.ts`.
- Edit `src/components/cmd/TitleBar.tsx` to consume the hook and drop the
  direct `lib/supabase` import.
- Edit `src/components/cmd/TitleBar.test.tsx` to mock the hook boundary
  instead of the supabase client.
- Add `src/hooks/useConnectionStatus.test.ts` covering the polling logic.

## Out of scope (explicitly)

- Adding new connection states (e.g. `'syncing'`, `'offline'`,
  `'degraded'`) or new UI for them — pure refactor, behavior preserved.
- Changing the polling cadence (2000 ms stays).
- Adding `useConnectionStatus` consumers beyond TitleBar — the hook is
  reusable, but this spec only touches TitleBar. (Future consumers like
  `MobileTopAppBar` add the import in their own spec.)
- Spec 056 (separate spec for the LoadingBar phone-tier follow-up).
- Replacing the `supabase.realtime.channels` read with a different
  channel-state source — same source, new home.

## Open questions resolved

- Q: Should the hook be tested independently with its own jest test, or
  is the TitleBar smoke test sufficient? → A: Default yes, add a small
  test for the hook itself — the polling logic (interval, cleanup,
  mixed-state aggregation) is non-trivial and benefits from isolated
  coverage. AC includes this test.

## Dependencies

- Spec 055 (global loading indicator) must be merged — this spec edits
  the `TitleBar.test.tsx` mock block introduced during spec 055 Pass-2.
- No new migrations, no edge functions, no RPCs.

## Project-specific notes

- Cmd UI section / legacy: Cmd UI shell chrome. No section.
- Per-store or admin-global: N/A — pure FE refactor.
- Realtime channels touched: none added; the existing
  `supabase.realtime.channels` read is moved, not changed.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: Web only — `TitleBar` already bails on
  `Platform.OS !== 'web'`; the hook inherits that constraint because it
  is only consumed inside web-only code paths. The hook itself does not
  need a platform bail.
- Tests: jest track — new hook test + existing TitleBar test edit.
- Convention compliance: closes the CLAUDE.md "All PostgREST/RPC traffic
  flows through `src/lib/db.ts`" violation at `TitleBar.tsx:6`. Note:
  `supabase.realtime.channels` is realtime state, not PostgREST/RPC, so
  the convention's letter is debatable — but the spirit (no direct
  `lib/supabase` import in components) is the goal here, and the
  test-mock workaround it forced is the concrete cleanup motivation.

## Handoff

next_agent: backend-architect
prompt: Design the contract for this spec. Read the acceptance criteria
  and any project-specific notes, then produce the design doc and set
  Status: READY_FOR_BUILD.
payload_paths:
  - specs/057-use-connection-status-hook.md
