## Code review for spec 016 (Reports Runner Foundation, REPORTS-1)

Reviewer: code-reviewer
Files examined: all 8 files listed under "## Files changed" in the spec.

### Pre-existing finding (noted per reviewer instructions)

~436 "Maximum update depth exceeded" React errors appear in the console during cold-boot on the Inventory section, before the Reports section mounts. These are not introduced by Spec 016 and do not block this spec, but they are worth a separate investigation pass.

---

### Critical

No Critical findings. All Supabase calls flow through `src/lib/db.ts`, no legacy files (`useSupabaseStore.ts`, `useJsonServerSync.ts`, `db.json`, `AdminScreens.tsx`) were modified, `app.json` slug was not touched, and all `document`/`window` access in the new frontend files is correctly guarded by `Platform.OS !== 'web'` checks.

---

### Should-fix

- **`src/store/useStore.ts:1872-1878` — error revert deletes a pre-existing good run.**
  When `runReport` fails (e.g. RPC succeeds but the `report_runs` INSERT is rejected by RLS), the catch block does `delete next[definitionId]`, wiping whatever was stored under that key. If the user had previously pressed RUN successfully — so `reportRuns[definitionId]` held a resolved `ok` row loaded by `loadLatestRun` — the error now leaves the detail frame in the "No runs yet" empty state instead of reverting to the last-good run. The fix is to snapshot the previous value before the optimistic write and restore it on error, following the same pattern `deleteReportDefinition` uses at line 1832 (`const prev = (get().savedReports || []).find(...)` → restore on catch). Suggested correction:
  ```ts
  const prev = (get().reportRuns || {})[definitionId] ?? null;
  set(…optimistic…);
  db.runReport(…)
    .then(…)
    .catch((e) => {
      set((s) => {
        const next = { ...(s.reportRuns || {}) };
        if (prev) next[definitionId] = prev;
        else delete next[definitionId];
        return { reportRuns: next };
      });
      notifyBackendError('Run report', e);
    });
  ```
  The spec's pseudocode (backend-arch, line 862) prescribes `delete next[definitionId]`, but that prescription assumes there was no previous run — the implementation should defend against the case where there was.

- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:163` — inline color literal `'#000'` on accent button text.**
  The RUN button uses `color: runDisabled ? C.fg3 : '#000'` for button label text when the button is active (non-disabled). The Cmd palette has an `accentFg` token in `useCmdColors()` whose value flips between `'#FFFFFF'` (light mode, where accent is dark green `#3F7C20`) and `'#0E1014'` (dark mode, where accent is bright green `#7DD668`). Using hardcoded `'#000'` gives black text on dark green in light mode — low contrast against the WCAG threshold. Fix: `color: runDisabled ? C.fg3 : C.accentFg`. The existing `BrandFormDrawer.tsx:84` and `NewReportModal.tsx:108` (pre-existing) already use `C.accentFg` / the same `'#000'` pattern — the pre-existing case in `NewReportModal.tsx:108, 192` is out of scope for this spec, but the new code in `ReportDetailFrame.tsx` must not introduce additional instances.

- **`src/screens/cmd/sections/ReportsSection.tsx:137` — same inline color literal on `+ NEW REPORT` button.**
  `color: '#000'` on `backgroundColor: C.accent`. Same fix as above: use `C.accentFg`.

- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:89-91` — `as any` cast to access `params.range`.**
  ```ts
  const rangeChip =
    typeof (definition.params as any)?.range === 'string'
      ? `range: ${(definition.params as any).range}`
      : 'range: last 30d';
  ```
  `definition.params` is typed as `Record<string, unknown> | undefined`. The `as any` is used to suppress a non-existent type error — `definition.params?.['range']` is already legal TypeScript and returns `unknown`, and a `typeof` guard narrows it. Fix:
  ```ts
  const range = definition.params?.['range'];
  const rangeChip = typeof range === 'string' ? `range: ${range}` : 'range: last 30d';
  ```
  CLAUDE.md flags `as` assertions used to suppress type errors instead of fix them.

---

### Nits

- **`src/store/useStore.ts:45-46` — defensive `|| []` / `|| {}` fallbacks create false impression of possible undefined.**
  ```ts
  const savedReports = useStore((s) => s.savedReports || []);
  const reportRuns = useStore((s) => s.reportRuns || {});
  ```
  The store initialises both as `[]` and `{}` at line 355/358 and there is no code path that sets them to `null` or `undefined`. The `||` fallbacks therefore never fire, but suggest to a reader that the slice can be nullish — which could mask a future bug if the initial state is accidentally cleared to `null`. Prefer the selector without the fallback (`s.savedReports` / `s.reportRuns`) to keep the type honest. The same `|| {}` / `|| []` inside `runReport` action's `set()` callbacks (e.g. `useStore.ts:1857, 1869`) are harmless because they're inside spread operations that always produce a new object anyway.

- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:30-41` — `isToneKey` helper is used only to pre-normalize `k.tone` to `null` before passing to `toneColor`, which repeats the same conditional. The guard is redundant.**
  `toneColor(C, k.tone)` handles any `unknown` input directly (returns `C.fg` for anything that isn't `'ok'`/`'warn'`/`'danger'`). The call site at line 375-376 could be simplified to `const valueColor = toneColor(C, k.tone);` and `isToneKey` removed. Minor but slightly confusing to a reader who wonders why the narrowing produces a value immediately passed to a function that re-checks the same condition.

- **`supabase/migrations/20260510120000_report_runs.sql:122-124` — misleading comment about the UPDATE policy.**
  The comment reads "Update is included so the client can flip status `pending → ok|error` after the RPC returns." But the actual flow in `db.runReport` never issues an UPDATE — it inserts with the final `status` directly (lines `db.ts:1662-1674` always insert `'ok'` or `'error'`, never `'pending'`). The UPDATE policy is present for forward-compatibility, which is fine, but the comment's explanation of why it's there is inaccurate. A more accurate comment: "Update policy is included for forward-compatibility; the client currently inserts with final status, but a future server-side dispatcher may UPDATE instead."

- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:149-152` — `title` property in style spread does not produce a tooltip on web.**
  ```ts
  ...(Platform.OS === 'web'
    ? ({
        cursor: runDisabled ? 'not-allowed' : 'pointer',
        title: isNotImplemented ? 'Not yet wired' : '',
      } as Record<string, unknown>)
    : {}),
  ```
  `title` is an HTML attribute, not a CSS style property. Spreading it into the `style` prop has no effect in react-native-web; the tooltip will not appear. `cursor` (a CSS property) works fine. If a tooltip is desired, `title` must be passed as a component prop (e.g. `<TouchableOpacity accessibilityHint="Not yet wired" ...>`). No runtime error, but the intent is silently unmet.

- **`src/screens/cmd/sections/reports/ReportDetailFrame.tsx:493-495` — row key uses array index.**
  ```tsx
  key={`r-${rowIdx}`}
  ```
  Acceptable for a read-only table, but if REPORTS-2/3 add sortable rows, the index key will cause unnecessary remounts. Using `row[columns[0].key]` (the first column value) or a composite of column values would be more robust. Low priority until rows become interactive.

- **(out-of-scope)** `src/components/cmd/NewReportModal.tsx:108, 192` — pre-existing `color: '#000'` on accent backgrounds. These are in code that predates this spec (the `'#000'` is not on newly-added code paths within the modal). Flagging for awareness; a dedicated cleanup pass should replace with `C.accentFg`.
