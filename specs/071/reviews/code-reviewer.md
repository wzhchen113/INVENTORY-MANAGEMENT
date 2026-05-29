## Code review for spec 071

### Critical

None.

### Should-fix

None.

### Nits

- `src/screens/staff/screens/StorePicker.tsx:1` — File-level path comment says `// src/screens/StorePicker.tsx` (missing the `staff/screens/` segment). The rest of the staff subtree uses the fully-qualified path in its header comment (e.g., `EODCount.tsx:1` reads `// src/screens/staff/screens/EODCount.tsx`). Update to `// src/screens/staff/screens/StorePicker.tsx` for consistency.

- `src/screens/staff/screens/StorePicker.test.tsx:80` — The `root.type` assertion compares against the string literal `'SafeAreaView'`, which is only correct because the jest.setup mock happens to render with that tag. The comment at line 9-14 explains this, which is good, but the assertion would silently pass if the mock were rewritten to forward `displayName` instead of using `createElement('SafeAreaView', ...)`. This is an inherent constraint of the jsdom approach (not something introduced by this spec), and the mock is stable — no action required, just noting for awareness. No code change needed.

---

**Implementer flags addressed:**

1. **Extending vs. overwriting StorePicker.test.tsx** — The decision to extend in-place is correct. The existing spec-063 `describe('StorePicker')` block (rows, tap, subtitle) is preserved at lines 37-57, and the new `describe('StorePicker — spec 071 safe-area root')` block is appended at lines 59-115. Overwriting would have silently deleted the spec-063 row/tap/subtitle coverage; the architect's intent was to add the four assertions, not replace the file. Approved.

2. **Browser preview not exercised** — Acceptable. The architect's spec §"Risks and tradeoffs §1" explicitly documents that `SafeAreaView` on react-native-web resolves `env(safe-area-inset-*)` to `0px` on desktop browsers, producing a visual delta of zero. The structural correctness guarantee comes from the four new jest assertions (root type, edges prop, no-provider tolerance, title/header role). Device-level QA ships via EAS, the same posture EODCount runs under. Verification posture is sound.

3. **Pure-frontend, no backend surface** — Confirmed. No Supabase calls, no store mutations, no migrations, no edge functions, no realtime channels. Staff carve-out applies and no new violations were introduced.

**AC checklist (audited against implementation):**

- SafeAreaView from `react-native-safe-area-context`: confirmed (`StorePicker.tsx:20`).
- No deprecated `react-native` re-export in staff subtree: confirmed (grep across `src/screens/staff/**/*.tsx` finds no `SafeAreaView` import from `react-native`).
- `edges={['top', 'bottom']}`: confirmed (`StorePicker.tsx:39`), byte-for-byte match with `EODCount.tsx:392`.
- `testID="store-picker-root"` on new root: confirmed (`StorePicker.tsx:40`).
- `backgroundColor: c.bg` preserved on new root: confirmed (`StorePicker.tsx:38`).
- `View` import retained (still used for header/separator): confirmed (`StorePicker.tsx:19`).
- No new `SafeAreaProvider` nested in the staff subtree: confirmed — `SafeAreaProvider` appears only in `App.tsx:336` and in the test file (test-local, correct).
- EODCount confirmed-correct at `EODCount.tsx:390-393` (no code change): confirmed.
- Four new jest assertions in `StorePicker.test.tsx:59-115` covering no-provider tolerance, root identity, edges prop, and title/header role: confirmed and match the spec design.
- TypeScript exit 0 and 74 jest tests passing: reported in implementer's verification block.
