# Backend-architect post-impl drift review — spec 051

Contract: the `## Backend design` section I appended in design mode.
Implementation: the four files at the bottom of the spec.

## Verdict
**No Critical or Should-fix findings.** Implementation matches the design contract on every load-bearing dimension. One Minor doc-drift item the developer already self-flagged in the spec's Files-changed section.

---

## Critical
None.

## Should-fix
None.

## Minor

### M1. Matrix B narrative drifted from observed reality (developer self-flagged)
**Location:** [specs/051-legacy-permissive-policy-dropout.md:657](../../051-legacy-permissive-policy-dropout.md) (my design, Matrix B row "brand-A admin INSERTs grant for brand-A user on brand-B store") and the parallel narrative at the §"AFTER" predicate paragraph.

My design predicted "RLS 42501 (cleaner error class than trigger raise)". The implementation correctly lands the policy that *would* return 42501 if the trigger didn't fire first — but per documented Postgres BEFORE-ROW execution order (`38.6 Trigger Execution`), the spec-012a `user_stores_brand_match_trg` raises P0001 first and the WITH CHECK never gets to evaluate. Defense-in-depth is intact (trigger first, RLS second — two structural rejections of the same operation), but my matrix narrative about "cleaner error class" was wrong.

The developer caught this and:
- Landed arm (11) asserting P0001 + stable trigger message (the observed reality).
- Documented the inversion inline in the test arm comment ([supabase/tests/legacy_permissive_policy_dropout.test.sql:544-571](../../../supabase/tests/legacy_permissive_policy_dropout.test.sql)).
- Self-noted the matrix inaccuracy in the spec's Files-changed bullet for arm (11) ([specs/051-legacy-permissive-policy-dropout.md:1232](../../051-legacy-permissive-policy-dropout.md)).

**Resolution decisions (parent dispatch asked me to make these):**
1. **Acceptable?** Yes. Defense-in-depth is preserved — two layers reject the same operation. Only the predicted error class differed from observed.
2. **Correct Matrix B?** Not load-bearing for this spec — the spec is shipped and the developer's inline note in §"Files changed" is sufficient breadcrumb. If a future reviewer cross-references the matrix vs. the test, they hit the inline disclaimer first. A retroactive matrix edit is doc-churn for no reader benefit at this point.
3. **Test assertion choice.** Landing on trigger P0001 + stable message is correct — it asserts what executes. Adding a structural assertion that the policy would *also* reject if the trigger were removed is theoretically attractive but operationally impractical (you can't drop a trigger inside a pgTAP arm without a separate fixture transaction). The migration's policy text is the structural proof, and arm (10) demonstrates the same admin policy admits when brand check passes — the contrapositive shows it would reject when it fails.

No action required.

---

## Verified-clean items (the parent dispatch's checklist)

1. **Migration filename** — `supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql` matches design §0 exactly. Lands after spec 050's `20260520000000` slot.
2. **Idempotency shape** — Every `create policy` is preceded by `drop policy if exists` of the same name ([supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:101-102, 157, 180](../../../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)). Not `create or replace`.
3. **EXISTS subquery shape** — `where s.id = user_stores.store_id and public.auth_can_see_brand(s.brand_id)` at lines 122-127 and 131-136. The `user_stores.store_id` reference (not `id`) is correct — resolves to the candidate row's store_id per Postgres policy-expression semantics, mirroring the 012a child-policy convention.
4. **WITH CHECK presence on own-row policy** — Lines 109-110: `using (user_id = auth.uid())` AND `with check (user_id = auth.uid())`. Blocks the spec-042-class UPDATE-row-key-forgery attack (caller cannot UPDATE another user's row OR mutate `user_id` on their own row). Matches design §3 "Why USING and WITH CHECK are both specified for FOR ALL".
5. **Matrix B vs landed test** — Test asserts P0001 (trigger fires first, observed) rather than 42501 (RLS WITH CHECK, predicted). See M1 above. Inline test comment is exhaustive.
6. **Spec 041 closeout** — Appended at [specs/041-brand-scoped-store-visibility.md:1228](../../../specs/041-brand-scoped-store-visibility.md) under the existing `## Files changed` → `Migrations:` list. Right section. Wording matches design §12 verbatim with a slight expansion (acceptable elaboration).
7. **CLAUDE.md bullet** — Placed at [CLAUDE.md:66](../../../CLAUDE.md) under "Conventions already in use", after the `callEdgeFunction` bullet, before the "Imports." line. Strictly additive — no existing bullet reworded. Matches design §11 phrasing with minor polish (no semantic drift).
8. **plan(13)** — Confirmed [supabase/tests/legacy_permissive_policy_dropout.test.sql:96](../../../supabase/tests/legacy_permissive_policy_dropout.test.sql). Arms (1)-(7) = 7 stores assertions, arms (8)-(11) = 4 user_stores assertions, arms (12)-(13) = 2 categories assertions, total 13. Arm (5) correctly compacts the four super_admin ops into one `is(...)` over `bool_and` per design §10.

---

## Cross-cutting confirmation

- **Helpers unchanged.** No `auth_can_see_brand`, `auth_can_see_store`, `auth_is_privileged`, `auth_is_admin`, `auth_is_super_admin` body changes. Confirmed by reading the migration body (policy DDL only).
- **Realtime publication unchanged.** The migration contains zero `alter publication` statements. `docker restart supabase_realtime_imr-inventory` is correctly not required (matches design §8).
- **Client-side surface unchanged.** No `src/lib/db.ts`, `src/store/useStore.ts`, or edge function edits ship with this commit, matching design §7 and §6.
- **Header comment idiom** — The migration's header documents the rollback shape ([supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql:55-69](../../../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)), matching the spec 043 precedent referenced in design §15.
- **Comment-on-policy annotations** — Both categories SELECT policies AND both rewritten user_stores ALL policies carry inline `comment on policy` strings pinning the intent to spec 051. Promotes the buried migration comments to `pg_policies`-queryable annotations, matching design §2 Matrix C/D and §3.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 0 Should-fix, 1 Minor (developer-self-flagged matrix-narrative drift on trigger-vs-RLS error-class ordering; defense-in-depth intact). Implementation matches the design contract.
payload_paths:
  - specs/051-legacy-permissive-policy-dropout/reviews/backend-architect.md
