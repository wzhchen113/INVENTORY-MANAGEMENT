# Code review for spec 056

## Critical

None.

## Should-fix

None.

## Nits

- `src/components/cmd/MobileTopAppBar.tsx:47` — Anchor-comment line citation is stale. The comment says `Mirrors TitleBar.tsx:116` but `position: 'relative'` actually lives on **TitleBar.tsx:102** in the current file. The companion JSX comment at line 54 says `mirrors TitleBar.tsx:119-122` but `<LoadingBar />` is on **TitleBar.tsx:108**. The spec's own design section (spec line 148) cited "TitleBar.tsx:113–116" — these numbers were off at design time and the developer copied them forward. The cross-reference is advisory only (no runtime effect) but will mislead anyone who `grep`s or jumps to the cited line. Suggested fix: update both citations to the correct line numbers (`TitleBar.tsx:102` and `TitleBar.tsx:108`).

---

### Scope-verification notes (no findings)

The four files declared byte-for-byte unchanged in the spec's `### Non-changes` section — `src/lib/inflight.ts`, `src/lib/db.ts`, `src/components/cmd/LoadingBar.tsx`, `src/store/useStore.ts` — were read and match their spec 055 / pre-056 shapes. No drift detected.

`position: 'relative'` is present on the outer wrapper at line 48 (load-bearing requirement confirmed by eyeball, consistent with the architect's callout that jsdom cannot assert this).

`<LoadingBar />` is mounted as the first child of the outer View at line 55, before the inner 44px row at line 56 — order is correct.

Test mock shape mirrors `TitleBar.test.tsx` correctly: same Platform stub, same `useCmdColors` palette stub with `loadingBar`/`loadingBarSlow` keys, same `useInflight.setState` reset in `beforeEach`, same three test cases (hidden / inflight / slow). The extra `useSafeAreaInsets` stub is a correct addition specific to `MobileTopAppBar`'s `insets.top` read; it has no TitleBar counterpart because TitleBar does not call that hook. The absence of `useStore`, `react-dom`, `useT`, and `useConnectionStatus` mocks is correct because `MobileTopAppBar` does not import any of those.

No direct Supabase calls, no inline color literals, no `window`/`document` usage outside `LoadingBar.tsx` (which has a web guard), no `Alert.alert` / `window.confirm`, no legacy file recreations, no `app.json` slug changes, no new realtime channels, no test files outside the jest track.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 0 Should-fix, 1 Nit.
payload_paths:
  - specs/056/reviews/code-reviewer.md
