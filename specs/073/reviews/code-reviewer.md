# Code review — spec 073 (staff EOD defensive empty-state SafeAreaView edges alignment)

Reviewer: code-reviewer
Scope: pure-frontend single-prop addition. No backend / SQL / auth / RLS / db.ts surface.

## Critical

None.

Verified: no direct Supabase calls outside the documented staff carve-out, no
legacy-file edits, no `app.json` slug change, no inline color literals, no
unguarded `window`/`document`/`navigator`, no new realtime channels, no
`Alert.alert`, no admin-stack changes.

## Should-fix

None.

## Nits

None.

---

### Detailed findings

**Prop value matches byte-for-byte.**
`EODCount.tsx:376-378` (defensive branch) and `EODCount.tsx:393-395` (main
branch) are now identical in their `SafeAreaView` opening tag:
`style={[styles.container, { backgroundColor: c.bgAlt }]}` and
`edges={['top', 'bottom']}`. The fix is exactly what the spec prescribes.

**StorePicker is clean.**
`StorePicker.tsx:37-39` already carries `edges={['top', 'bottom']}` — no
sibling gap. No other files in `src/screens/staff/` introduce a bare
`<SafeAreaView>` without the prop.

**No-test rationale is sound.**
The defensive branch is a transient guard state (`!activeStore`) that the
existing test suite does not exercise and that the navigator prevents from
being reachable in normal flow. Pinning the `edges` literal in a test would
assert the value of a constant rather than any behavior. The spec's reasoning
matches the precedent set in spec 072 for the `styles.container` decision.
Agree with the "no test added" call.

**CLAUDE.md conventions all satisfied (inherited clean from 070/071/072).**
Staff carve-out for direct Supabase usage applies (`supabase.from(...)` calls
present in `EODCount.tsx` are within the `src/screens/staff/` exemption).
Theme tokens consumed exclusively through `useStaffColors()` — no hex
literals. No write to `profiles.dark_mode` from the staff surface.
