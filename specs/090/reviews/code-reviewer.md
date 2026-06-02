## Code review for spec 090

### Critical

None.

### Should-fix

- `src/lib/inviteUser.test.ts:35` — `mockStoreBrandRow` is initialized to `null` at module scope, then reset to `{ brand_id: BRAND_A }` in `beforeEach`. The factory closure at line 53 reads it by reference at call time, which is correct. However, the zero-store test (case 2) and the admin-passthrough test (case 3) both rely on `mockStoresReadFired` staying `false`, and the `beforeEach` correctly resets it. The subtle concern is that `jest.clearAllMocks()` (line 87) clears the `jest.fn()` call histories INSIDE the factory — including the inner `jest.fn()`s on `select`, `eq`, `single` — which means after clearAllMocks those inner fns have no call records. This is fine for the current assertions because the test only checks `mockStoresReadFired` (a plain boolean), not mock call counts on the inner fns. But it also means if a future test wants to `expect(supabase.from).toHaveBeenCalledWith('stores')` it will silently pass even after clearAllMocks because the outer `from` fn is also cleared. This is the exact asymmetry the reference test (`registerInvitedUser.test.ts`) has — it's not a bug for the current assertions. Noting it so a future case author knows to reset `mockStoresReadFired` rather than relying on `from` call counts.

  Actually on reflection this is informational, not a must-fix. Demoting to Nit.

- `src/lib/auth.ts:298-311` — The block comment explains the defense-in-depth, the off-by-one note, and the zero-store rationale — all "why", which is correct. However line 299 says "user/manager invite" while `InviteUserOptions.role` is typed `'admin' | 'user'` — there is no `'manager'` role in this system. The informal "manager" shorthand is used throughout the spec narrative (not a code contract), but having it in a code comment could mislead a future reader who tries `role: 'manager'` and wonders why the guard fires. The comment at line 298-299 should say "user invite" or "non-admin invite" to stay consistent with the actual type. The same "user/manager" phrasing appears in `InviteUserDrawer.tsx:140` ("Spec 090 — derive the user/manager invite's brand"). Suggest replacing both with "user (non-admin)" or just "user" to match the type.

### Nits

- `src/lib/inviteUser.test.ts:31-35` — The three module-scoped mutable variables (`mockInvitationInsertPayload`, `mockStoresReadFired`, `mockStoreBrandRow`) are declared with `let` and annotated `: any` or plain `boolean/null`. The reference file (`registerInvitedUser.test.ts`) follows the same pattern — fine. Minor nit: `mockStoreBrandRow` could be typed as `{ brand_id: string } | null` instead of `any` to get type-narrowing in the factory closure, matching how the real `supabase.from('stores').single()` returns `{ data: { brand_id: string } | null, error: ... }`. Not a bug; the tests pass correctly with `any`.

- `src/lib/inviteUser.test.ts:87` — `jest.clearAllMocks()` is called in `beforeEach` before the module-scoped state variables are reset (lines 88-91). This ordering is correct (clear mocks first, then reset state), and mirrors `registerInvitedUser.test.ts:76-79` exactly. No issue; noting for completeness.

- `src/components/cmd/InviteUserDrawer.tsx:140-154` — The Spec 090 comment block is thorough and explains the "why" well (the store-first form, the fallback chain, the NB about indexing). At 14 lines it's on the long side for inline code. Consider trimming to the load-bearing lines (the NB about off-by-one + the zero-store null rationale) and referencing the spec for the rest. Current form is not harmful — it follows the pattern established by Spec 068's comment block at lines 89-111 — so this is a preference, not a convention violation.

- `src/lib/auth.ts:259-263` — The updated `InviteUserOptions.brandId` doc comment says "inviteUser also derives it server-side from storeIds[0] as defense-in-depth." The word "server-side" is slightly misleading — this is a client-side `auth.ts` call to PostgREST, not a server-side SECURITY DEFINER RPC. The original distinction the spec draws is between "inside `inviteUser`" (admin-authenticated client session reads `stores` via PostgREST) vs. the RPC-based `get_pending_invitation` derivation. Suggest "inviteUser also derives it as defense-in-depth via a stores read" to avoid implying a DB-side computation.

---

### Summary

No Criticals. The implementation is clean and faithful to the architect's design. The core correctness properties all hold:

- The off-by-one trap is correctly avoided — `storeIds[0]` (JS) and `store_ids[1]` (Postgres) are the same element; the NB comment is present in both changed files.
- Zero-store gating is in both layers (`storeIds.length > 0`) and preserved throughout.
- The admin path is untouched — the existing early-return guard at `auth.ts:279-281` fires before the new derive code at `auth.ts:312-320`, and the admin branch in the drawer (`values.role === 'admin' ? brandId : ...`) is unchanged.
- The insert at `auth.ts:334` uses `resolvedBrandId`, not `opts.brandId` — the resolved value is what gets written.
- The drawer derivation uses `brandStores.find((s) => s.id === values.storeIds[0])?.brandId ?? brandId ?? null` — the store-first form per the architect's spec.
- `src/lib/auth.ts` is a documented `db.ts` carve-out; the new `supabase.from('stores')` read inside `inviteUser` is within that exemption.
- The four jest cases are non-vacuous and cover all four acceptance criteria branches. The mock structure correctly isolates the `stores` branch from the `invitations` branch. The test file is modeled correctly on `registerInvitedUser.test.ts`.
- The `InviteUserOptions.brandId` doc comment is updated to accurately describe the new behavior.

The two Should-fix items are comment-accuracy nits (the "manager" type mismatch in prose, and "server-side" wording); neither affects runtime behavior or test correctness. The review has 2 Should-fix and 4 Nits.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in (comment-only); the Nits deferred (cosmetic).

- **S1 ("user/manager" in comments vs the `'admin' | 'user'` type)** — **fixed.** Changed "user/manager invite" → "user (non-admin) invite" in both `auth.ts` (the derive-block comment) and `InviteUserDrawer.tsx` (the Spec-090 comment) so the prose tracks the actual type union.
- **S2 (misleading "server-side" in the `InviteUserOptions.brandId` doc, `auth.ts:261`)** — **fixed.** Reworded to "inviteUser also derives it from storeIds[0] via a `stores` read as defense-in-depth" — no longer implies a DB-side step (it's a client-initiated PostgREST read under the caller's session). The drawer's separate reference to the `get_pending_invitation` `COALESCE` derivation as "server-side" is left as-is (that one genuinely IS the server-side RPC).
- **Nits** — deferred (cosmetic): the `: any` on the test's `mockStoreBrandRow` (matches the reference `registerInvitedUser.test.ts`), and the comment-block length.

Re-verified post-fix-pass: `npx tsc --noEmit` (base) exit 0. Comment-only edits — no behavior/type change; the build's jest 557 + test-graph-tsc baselines stand. (security-auditor PASS 0-across-all; test-engineer 7/7 ACs.)
