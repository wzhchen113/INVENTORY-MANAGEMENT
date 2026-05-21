# Code review — Spec 054

Date: 2026-05-21
Reviewer: code-reviewer

## Verdict

0 Critical, 1 Should-fix, 2 Nits.

## Critical

None.

## Should-fix

- **`src/components/cmd/IngredientForm.help-text.test.tsx:242`** — `expect(screen.getByText('required')).toBeTruthy()` is a weaker assertion than it should be. `getByText` already throws if no match is found, so `.toBeTruthy()` is redundant and gives a misleading error message on failure (RTL's "Unable to find element" is swallowed before the jest matcher fires). A consistent assertion would be `expect(screen.getAllByText('required')).toHaveLength(1)`, which mirrors the style of every other assertion in the file (lines 124, 131, 155, 170, 202, 241) and makes test failure output point at the count rather than truthiness. The inconsistency is small but the pattern across this file is `getAllByText(...).toHaveLength(1)`, not `getByText(...).toBeTruthy()`.

## Nits

- **`src/components/cmd/IngredientForm.help-text.test.tsx:205`** — Test name uses "required" (the raw translation key) rather than a user-visible label. Fine given the key-echoing translator and the spec's explicit statement, but the test description could say `'required' error key` instead of just `"required" error` to make the intent self-documenting for future readers who don't have the spec at hand.
- **`src/components/cmd/IngredientForm.tsx:342-351`** — The two new `<Text>` blocks are siblings directly under the `<View style={{ width, gap: 4 }}>` at line 298. The `gap: 4` already provides the inter-element rhythm, which is correct. The spec notes this explicitly (design §1 last bullet). No action needed; confirming the reviewer validated it.
