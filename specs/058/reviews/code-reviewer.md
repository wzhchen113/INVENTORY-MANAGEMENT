## Code review for spec 058

### Critical

None.

### Should-fix

- `src/hooks/useConnectionStatus.test.ts:236` — Stale comment still says `jest.mock('react-native', ...)`, but the actual mock at line 24 now correctly targets `'react-native/Libraries/Utilities/Platform'`. This spec's whole purpose was the path swap; the comment describing the old path is immediately misleading to the next reader of this block. Update line 236 to read `jest.mock('react-native/Libraries/Utilities/Platform', ...)`.

### Nits

None.

---

**Verification checklist** (per task brief):

1. **Line 24 `jest.mock` path** — `'react-native/Libraries/Utilities/Platform'`. Confirmed.
2. **Line 24 factory shape** — `{ __esModule: true, default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default }, OS: 'web' }`. Matches `LoadingBar.test.tsx:24-28` byte-for-byte. Confirmed.
3. **Line 245 `require`** — `require('react-native/Libraries/Utilities/Platform').default`. Confirmed; targets the same module instance the `jest.mock` registers.
4. **Production hook untouched** — `src/hooks/useConnectionStatus.ts` is unchanged. Confirmed.
5. **No drift outside the test file and spec** — only `src/hooks/useConnectionStatus.test.ts` was modified. Confirmed.
6. **Mutation evidence** — Spec line 99-100 records the mutation test: the `Platform.OS !== 'web'` guard was temporarily replaced with `void Platform;`, the native-bail test failed with `expect(setSpy).not.toHaveBeenCalled()` receiving 1 call, proving the mock and production hook share the same Platform object. Confirmed recorded in spec.
