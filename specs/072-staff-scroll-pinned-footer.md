# Spec 072 — staff app: pin Submit/header, make the items list scroll internally

Status: READY_FOR_REVIEW
Shape: hotfix (pure frontend, post-spec-070 regression visibility)
Pipeline note: PM/architect ceremony skipped — root cause + fix + DOM/visual proof
captured inline by main Claude during a live user-reported "cannot scroll on staff
site" incident. Reviewers may run retroactively if the user wants the full audit.

## Problem (user-reported)

> "cannot scroll on staff site"

On the staff EOD screen (`src/screens/staff/screens/EODCount.tsx`), when the
selected vendor returns enough items to exceed viewport height (US FOOD has
31 items on Frederick), the items list rendered taller than the viewport:
the document body scrolled instead of the list scrolling internally, and the
pinned footer (queue indicator + Submit) was pushed below the fold and could
not be reached without scrolling the entire page. On a notched phone the
header could also escape the safe area during the scroll.

The bug existed since the spec 063 imr-staff merge but was not user-visible
until spec 070's redesign made each row visibly taller (soft cards + 12px
inter-card spacing), so 14–31 items now reliably overshoot the 812px viewport.

## Root cause (web)

Captured live via `preview_eval` on the rendered DOM at mobile (375×812)
viewport — the parent chain of each item card:

| chain idx | role                                  | flex          | height | min-height | overflow      |
|-----------|---------------------------------------|---------------|--------|------------|---------------|
| 3 (was 4) | **FlatList outer** (scroll container) | `1 1 0%`      | 2417   | auto       | `hidden auto` |
| 4         | (RNW shim)                            | `1 1 0%`      | 2567   | auto       | visible       |
| 5         | (RNW shim)                            | `1 1 0%`      | 2567   | auto       | visible       |
| 6         | **our SafeAreaView** (`flex: 1`)      | `1 1 0%`      | 2567   | auto       | visible       |
| **7**     | **RN Navigation screen wrapper** (`r-minHeight-2llsf r-pointerEvents-12vffkv`) | **`0 0 auto`** | **2567** | **`100%`** | visible       |
| 8         | RN Navigation Card (`position: absolute; top:0; left:0; right:0; bottom:0`) | `0 0 auto` | 812 | auto | visible |
| 9..       | navigator chrome / NavigationContainer | `1 1 0%`      | 812    | auto       | visible       |

Element **7** is the breaker. `@react-navigation/stack`'s screen wrapper on
react-native-web sets `min-height: 100%` (= 812) **with `flex: 0 0 auto`**,
which lets the wrapper *grow* with content past its parent — the standard
"body-scroll page" pattern react-native-web uses to support short screens
that should still cover the viewport. Inside it our `SafeAreaView` is
`flex: 1` with the CSS default `min-height: auto` (= content height), so it
inherits the content size — 2567px tall — instead of being capped at the
parent Card's 812.

Native Yoga has no equivalent loophole (`flex: 1` is strictly "fill"), so
this is web-specific.

## Fix

Two-part, applied to both staff screens (`StorePicker.tsx` + `EODCount.tsx`):

1. **`SafeAreaView` `styles.container`**: `{ flex: 1 }` → `{ ...StyleSheet.absoluteFillObject }`.
   Sizes the SafeAreaView to its nearest positioned ancestor (the RN
   Navigation Card at 812px), bypassing the breaker entirely. SafeAreaView
   `edges` padding still works (padding is independent of position). On
   native Yoga the change is a no-op for sizing.
2. **Items / store `FlatList`**: add `style={{ flex: 1 }}` (via a new
   `itemListBody` / `listBody` stylesheet entry).
   Without `flex: 1` on the FlatList outer, RNW renders it at content
   height. With it, the FlatList claims the leftover space between the
   pinned header and the pinned footer and becomes the scroll container
   (`overflow: hidden auto`).

The `loadingPane` / `emptyPane` branches already had `flex: 1` and worked
correctly — only the populated FlatList branch was the asymmetry.

## Verification

### DOM verification (post-fix, computed style)

Same chain after the edit, mobile viewport (375×812):

| chain idx | role                                  | height   |
|-----------|---------------------------------------|----------|
| 3 (FlatList outer, `overflow: hidden auto`) | **663** (812 - header ≈76 - footer ≈150 - padding) |
| 6 (our SafeAreaView, now absolute-fill)     | **812** (sized to Card) |
| 7 (RN screen wrapper / breaker)             | **812** (no longer grown — our SafeAreaView is out of normal flow) |
| 8 (Card)                                    | **812** |

### Visual verification

Reproduced live in the preview at mobile (375×812). Used a temp local-only
insert into `order_schedule` to give Frederick a Friday vendor (immediately
deleted after verification — local seed, never prod):

```sql
insert into order_schedule (store_id, vendor_id, vendor_name, day_of_week, delivery_day)
select s.id, v.id, v.name, 'Friday', 'Friday' from stores s, vendors v
where s.name='Frederick' and v.name='US FOOD';
-- verified; immediately:
delete from order_schedule where ... ; -- (above row deleted)
```

Before: list spilled past viewport, Submit invisible, document body scrolled.
After: header pinned at top, list scrolls internally with a visible scrollbar,
Submit (solid blue) pinned at the bottom.

### Unit tests

- `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.
- `npx jest src/screens/staff` → 9 suites / 74 tests green.

The fix is pure style tokens; the meaningful regression guard is the
computed-style DOM proof captured above. Pinning the `styles.container`
shape in jest would test the literal (no extra coverage).

## Files changed

- `src/screens/staff/screens/EODCount.tsx`
  - `styles.container`: `{ flex: 1 }` → `{ ...StyleSheet.absoluteFillObject }` with comment explaining the RNW Card sizing path.
  - `styles.itemListBody`: new `{ flex: 1 }` entry.
  - Items `<FlatList>`: `style={styles.itemListBody}` added (alongside the existing `contentContainerStyle={styles.itemList}`).
- `src/screens/staff/screens/StorePicker.tsx`
  - `styles.container`: same change as EODCount, cross-referenced in the comment.
  - `styles.listBody`: new `{ flex: 1 }` entry.
  - Stores `<FlatList>`: `style={styles.listBody}` added.

## Scope / non-changes

- React Navigation `screenOptions.cardStyle` in `StaffStack.tsx` — **untouched**. The shared `NavigationContainer` in `RoleRouter.tsx` is **untouched**. Admin stack — **untouched**. No backend/RLS/RPC/migration surface.
- Pure frontend. Vercel deploys on push. No prod migration.

## Out-of-scope follow-ups

- EODCount defensive empty-state branch at `EODCount.tsx:376-381` still uses default (all-four) edges on its `SafeAreaView` — architect's spec-071 nit, unchanged here. The container style change DOES apply (same `styles.container`), so its scroll posture is automatically correct.
- No new `imr-staff` regression test for "list scrolls when populated past viewport" — would require a viewport-sized harness; deferred. Pinning the static style was rejected as low-value.
