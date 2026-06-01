# Code review for spec 084

Spec: `fetchBrandAdmins` NULL-brand email-inference blind spot + stale `auth.ts` comment
Files reviewed:
- `src/lib/db.ts` — `fetchBrandAdmins` (Edit 1: dropped `.eq('brand_id', brandId)` on the invitations query; Edit 2: strict-equality gate on `pendingInvites`)
- `src/lib/auth.ts` — comment-only rewrite at the `fetchInvitationsForUserLookup` call site
- `src/lib/db.fetchBrandAdmins.test.ts` — new arms (e), (f), (f-bis), (g)

---

## Critical

None.

The `pendingInvites` predicate is strict `!inv.used && inv.brand_id === brandId` with no `|| inv.brand_id == null` escape hatch and no loose `==`. `null === brandId` evaluates to `false` exactly as the architect required. The pollution guard is correctly implemented — this was the #1 flagged review check.

---

## Should-fix

- `src/lib/db.ts` (the spec-082 inference-map comment block) — The comment "Maps are built from ALL **brand** invites (the query no longer filters used=false)" is now factually stale. After spec 084's Edit 1 the invitations query reads ALL invitations (not brand-filtered). The word "brand" should be dropped/replaced so a reader doesn't conclude the query is still brand-scoped for inference. Suggested rewrite: "Maps are built from ALL invitations (the query no longer filters used=false, and since spec 084 also no longer filters by brand_id — see comment above)."

---

## Nits

- `src/lib/auth.ts` — Minor wording mismatch with the spec-083 authoritative doc block. The rewritten comment says `opts?.brandId` is "currently IGNORED by the helper," while the `db.ts` `fetchInvitationsForUserLookup` doc block (the block this was supposed to mirror) says "currently UNUSED." Both convey the same meaning, but the spec required mirroring the authoritative wording. One-word delta — trivial.

- `src/lib/db.fetchBrandAdmins.test.ts` (arm (e) comment) — The comment "Pre-fix the `.eq('brand_id', BRAND)` query would have excluded the `brand_id:null` invite → empty email" is accurate for production but inaccurate for the test harness: `makeBuilder`'s `eq` ignores its arguments, so the mock returns the injected invite regardless, and arm (e) would pass on pre-fix code too. The describe-block header already includes the `eq`-ignores-args caveat, but the arm-level comment omits it, which is misleading in isolation. Consider adding the caveat to the arm comment (arm (f) is the true regression-detector) or removing the "Pre-fix…" sentence.

---

## Summary

The implementation is clean and correct. The one Should-fix is the word "brand" in the spec-082 inference-map comment block, now mildly misleading since the query is no longer brand-scoped. Both `auth.ts` edits are comment-only and logically sound. The `pendingInvites` strict-equality predicate — the flagged #1 check — is exactly right. The four new test arms cover the acceptance criteria; arms (a)-(d) are intact and unweakened. **0 Critical, 1 Should-fix, 2 Nits.**

---

## Resolution (post-review fix-pass — main Claude)

All three findings were comment-accuracy fixes on this spec's own code; folded in immediately:

- **Should-fix (stale "brand" word, `db.ts`)** — **fixed.** The inference-map comment now reads "Maps are built from ALL invitations (the query no longer filters used=false — spec 082 — and as of spec 084 no longer filters by brand_id either; see comment above), so a used or NULL-brand invite still feeds inference." No longer implies brand-scoping for inference.
- **Nit (`auth.ts` "IGNORED" → "UNUSED")** — **fixed.** Now mirrors the authoritative `db.ts:fetchInvitationsForUserLookup` doc-block wording ("currently UNUSED by the helper").
- **Nit (arm (e) comment overstating regression-detection)** — **fixed.** The comment now clarifies that in production the old `.eq` would have excluded the NULL-brand invite, but under the harness `eq` ignores its args, so arm (e) verifies the inference CONTRACT while arm (f) is the true regression-detector.

Re-verified post-fix-pass (comment-only edits): `npx jest src/lib/db.fetchBrandAdmins` 9/9 green; `npx tsc --noEmit` (base) exit 0. No logic/type changes.
