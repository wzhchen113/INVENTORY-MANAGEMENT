# Code review for spec 047

## Critical

None.

## Should-fix

- `.github/workflows/test.yml:47` — `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` uses an unquoted YAML boolean rather than a string literal. GitHub Actions environment variables are always strings; GitHub's runner converts the YAML boolean `true` to the string `"true"` in practice, but the authoritative GitHub Actions docs show this flag set as a string (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'`). Unquoted `true` works today, but it is relying on implicit YAML-to-string coercion behavior rather than stating intent. Quoting the value makes it unambiguous: `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'`. Low practical risk but easily corrected before merge.

## Nits

- `.github/workflows/test.yml:39-45` — The comment block is good (explains *why*, cites spec 047, correctly distinguishes action runtime from project Node). One minor wording tightening: the parenthetical `(still node-version: '20' below — that's our app's Node, not the action's Node — they're independent)` uses two em-dashes and a compound clause that could be split into two sentences for easier scanning.

- `specs/047-ci-node24-action-runtime.md:43-44` — The out-of-scope rationale states "Address when Node 20 EOLs (April 2026)"; Node 20 EOL has already passed (as of today, May 2026). Stale date will confuse a future reader auditing why project Node is still `'20'`. Worth a one-word correction ("EOL'd (April 2026)") before this spec is archived.

- `specs/047-ci-node24-action-runtime.md` (design doc, lines describing `node-version` at "lines 53, 74, 96") — After the `env:` block was inserted (adding ~10 lines), the actual `node-version: '20'` entries appear at lines 63, 84, and 106 in the file, not the lines cited in the design doc. Either drop the line numbers from the spec prose or annotate them as "approximate".

- `specs/047-ci-node24-action-runtime.md:3` — AC bullets 3 and 4 (deprecation annotation absent; all four jobs continue passing) are post-merge-only verifiable. The spec correctly lists them as `[ ]` (unchecked) with a verification plan section, which is the right posture. No change needed.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 4 Nits.
