# Spec 158: In-app Guide — plain-language explainer for every page

Status: READY_FOR_REVIEW

> Owner request (verbatim): *"i need the walkthru tutorial of what does each page
> or function does. so that for each new admin or staff users can learn by
> themself"*
>
> New managers and new staff are onboarded by shoulder-tapping whoever trained
> last. Nothing in the product says what "Reconciliation" or "Weekly count" is
> for. This spec ships a **Guide**: one browsable section listing every page in
> plain language, plus a small **`?`** on each screen that opens that page's
> explainer in place. Frontend-only. No migration, no RPC, no edge function.

## Locked decisions (owner, do not reopen)

1. **Format** = a **Guide** entry in the nav listing every page with
   plain-language explanations, **plus** a small **`?`** on each screen/section
   that deep-links to that page's explainer. NOT an interactive spotlight tour.
   NOT a single static page.
2. **No first-login auto-open.** Manual discovery only, always available. No
   per-profile "seen" tracking, therefore no `profiles` column and no backend.

## User story

As a newly hired store manager (admin Cmd UI) or a newly hired staff member
(staff EOD app), I want a Guide I can open at any time — either as a full list of
every page, or as a `?` on the screen I am currently stuck on — so that I can
learn what each page is for and what I am supposed to do on it without asking
anyone.

## Findings from the codebase (the real starting point)

**The admin surface has 17 reachable destinations, not the 17 the request
listed.** `useDefaultSidebarGroups()`
([src/lib/cmdSelectors.ts:1077](../src/lib/cmdSelectors.ts)) is the single source
of truth, and `InventoryDesktopLayout`'s dispatch
([InventoryDesktopLayout.tsx:328-365](../src/screens/cmd/InventoryDesktopLayout.tsx))
is its mirror:

| group | ids |
|---|---|
| Operations | `Inventory`, `Dashboard`, `EODCount`, `InventoryCount` ("Weekly count"), `WasteLog` |
| Planning | `Ordering`, `Vendors`, `Recipes` ("Menu items / BOM"), `PrepRecipes` |
| Insights | `MenuImpact`, `Reconciliation`, `POSImports`, `AuditLog`, `Reports`, `DBInspector` |
| Admin *(gated `useIsMaster()`)* | `Users` |
| Tenancy *(gated `useIsSuperAdmin()`)* | `Brands` |

Corrections to the request's list: **Receiving** and **Purchase orders** no
longer exist (spec 138 retired both; `Ordering` is now the reorder list plus a
read-only history panel). `Categories` / `RecipeCategories` / `OrderSchedule` /
`POsSection` are *not* sidebar destinations — `Categories` is a tab inside
Inventory, the rest are dormant files. Guide topics therefore track **sidebar
destinations**, and tabs inside a destination are described inside that
destination's topic.

**The staff surface has 5 screens, not the 3 the request listed.**
[StaffStack.tsx](../src/screens/staff/navigation/StaffStack.tsx): a tab bar of
`EODCount` | `Reorder` | `WeeklyCount`, plus the `StorePicker` gate and the
`Settings` stack screen (spec 126). `Receiving` is dormant (spec 138).

**Precedent to copy — specs 153/154 (install tutorial):**

- [src/lib/installGuide.ts](../src/lib/installGuide.ts) — a **pure model** that
  imports no store and nothing from a `.tsx` file, returning **catalog-relative**
  key suffixes so the admin and staff catalogs stay two independent trees (the
  spec-063 contract) over one model. Runs in the fast jest **node** project.
- [src/components/cmd/InstallGuideSheet.tsx](../src/components/cmd/InstallGuideSheet.tsx)
  — `ResponsiveSheet` (`phone: fullscreen`, `tablet/desktop: right-drawer`),
  glyphs from the model, every string from the catalog.
- [src/screens/staff/components/InstallGuideCard.tsx](../src/screens/staff/components/InstallGuideCard.tsx)
  — staff-local tokens/components + the staff catalog, consuming the same shared
  model. This is the proof that a shared **pure `src/lib/` model** is spec-063
  legal; a shared **themed component** is not.
- [src/screens/staff/components/SettingsGear.tsx](../src/screens/staff/components/SettingsGear.tsx)
  — the shape for a small per-screen staff control: self-contained, owns its own
  `useNavigation`, dropped into each staff screen's header row (there is no
  shared staff header).

**Adding a new sidebar id is a supported operation.** `applySidebarOverride`
([sidebar layout merge](../src/lib/sidebarLayout.ts)) walks the *default* groups
and falls back to the default group + default sort key for any id missing from a
user's saved `profiles.sidebar_layout`. Spec 060 added `MenuImpact` exactly this
way. So a new `Guide` item appears for users with and without a saved override,
with **no migration**.

**Chrome space is the real constraint.** The phone top app bar is a fixed 52 px
(handoff Hard Rule 5) and its trailing cluster already carries brand picker
(super-admin) + bell + theme + refresh
([ResponsiveCmdShell.tsx:482-499](../src/screens/cmd/ResponsiveCmdShell.tsx)). A
fifth 44×44 control does not fit at 375 px. The desktop/tablet `TitleBar` cluster
has room.

## Design

Four parts. All frontend, all additive.

### 1 — One pure model: `src/lib/guide.ts` (new)

Same split as `installGuide.ts` — a pure, catalog-agnostic registry that jest
exercises in the node project, with **no** store import, **no** `.tsx` import,
and no browser globals.

```ts
export type GuideAudience = 'admin' | 'staff';
/** Role gate mirroring the sidebar's own gates. */
export type GuideGate = null | 'master' | 'superAdmin';

export interface GuideTopic {
  /** Admin: identical to the shell's section id (that identity is load-bearing
   *  — it is what makes the `?` a one-line lookup). Staff: the route name. */
  id: string;
  audience: GuideAudience;
  gate: GuideGate;
  /** Index grouping — mirrors the sidebar groups so the Guide reads in the
   *  same order as the nav. */
  group: 'operations' | 'planning' | 'insights' | 'admin' | 'tenancy' | 'staff';
  /** Catalog-RELATIVE key root, e.g. 'topics.inventory'. Each surface prefixes
   *  it with its own catalog root (`guide.`). */
  key: string;
  /** How many "key actions" bullets this topic has (1-4). */
  actions: number;
}

export function guideTopics(a: GuideAudience): GuideTopic[];      // ordered
export function findGuideTopic(a: GuideAudience, id: string): GuideTopic | null;
/** ['topics.inventory.title','topics.inventory.purpose',
 *   'topics.inventory.actions.1', ...] — used by the i18n parity test. */
export function guideTopicKeys(t: GuideTopic): string[];
```

**Drift prevention lives here, in three layers** (this is the part that has to
survive the next 40 specs):

1. **Compile-time.** The admin registry is a
   `Record<AdminSectionId, GuideTopic>`, where `AdminSectionId` is a union
   exported from this same pure module (`export const ADMIN_SECTION_IDS = [...]
   as const`). `useDefaultSidebarGroups()`'s item ids and
   `InventoryDesktopLayout`'s `section` prop adopt that type (**type-only**
   change, zero behavior change). A new section id then fails compilation until
   a guide topic exists. `npm run typecheck:test` is the gate that runs it.
2. **Nav parity test.** A jest test renders `useDefaultSidebarGroups()` for a
   plain admin, a master, and a super_admin and asserts every rendered item id
   (except `Guide` itself) has a topic whose `gate` matches the visibility it was
   rendered under. Catches a section added to the sidebar without a topic, and a
   topic whose role gate drifted from the sidebar's.
3. **i18n parity.** The two existing parity suites
   ([src/i18n/i18n.test.ts](../src/i18n/i18n.test.ts) and the staff twin) fail the
   build on any key present in `en` but missing in `es` / `zh-CN`. A new test
   asserts every key produced by `guideTopicKeys()` exists in `en` for the
   matching catalog — so a topic can never render a raw key path.

### 2 — Admin: a `Guide` sidebar destination

- New sidebar id **`Guide`** in a new, always-visible group **Help**, appended
  last in `useDefaultSidebarGroups()` (after Tenancy). No override migration —
  see Findings.
- New `src/screens/cmd/sections/GuideSection.tsx` in the shell's dispatch:
  - **desktop / tablet:** two-pane — topic list on the left (grouped, in sidebar
    order), the selected topic's body on the right.
  - **phone (375 px):** `PhoneDrillScaffold` list → detail, per the spec 140-148
    pattern (list stays mounted, scroll survives back).
- **`GuideTopicBody`** (`src/components/cmd/GuideTopicBody.tsx`, new) renders one
  topic: title, "What this page is for" paragraph, "Key actions" bullets. It is
  the **only** renderer of topic content and is reused verbatim by the sheet in
  §3 — no second copy of the layout.
- Topic list is filtered by role using the existing `useIsMaster()` /
  `useIsSuperAdmin()` hooks — the same gates the sidebar uses, read from the same
  place. It is **not** filtered by the user's personal spec-008 sidebar-hide
  override (a hidden section is still a real page they can unhide; hiding its
  documentation would be a dead end).

### 3 — Admin: the `?` affordance, per tier

One shell-owned sheet, `src/components/cmd/GuideSheet.tsx` (new):
`ResponsiveSheet` with `{ phone: 'fullscreen', tablet: 'right-drawer', desktop:
'right-drawer' }`, props `{ visible, onClose, topicId }`. It renders
`GuideTopicBody` for `topicId`, with a "See all pages" link that switches the
sheet to the index list. The shell already knows the active `section`, and topic
ids **are** section ids, so the `?` needs no per-section wiring — **the 22 files
under `src/screens/cmd/sections/` are not touched.**

- **Desktop + tablet:** a `?` button in the `TitleBar` right cluster, before the
  bell. `TitleBar` gains one **optional** `onHelpPress?: () => void` prop so
  existing callers stay byte-unchanged; the shell passes
  `() => setGuideTopic(section)`. One insertion point covers both tiers (the
  TitleBar renders in the tablet and desktop branches).
- **Tablet collapsed rail:** a glyph-only `?` twin in `railFooter`, exactly the
  spec-153 pattern (the rail never receives `sidebarFooterLeft` / TitleBar
  cluster). Same testID — the branches are mutually exclusive at render time.
- **Phone (recommended default, OQ-2):** **do not** add a fifth glyph to the
  52 px bar. Instead make the bar's **section title** the affordance:
  `MobileTopAppBar` gains optional `onTitlePress?: () => void` and renders a
  small trailing `?` glyph inside the title area when it is supplied. The whole
  title row becomes the pressable target (≫44 px wide, 52 px tall), costs ~16 px
  of title width, and adds no control to the trailing cluster. Existing callers
  that pass no `onTitlePress` are byte-unchanged.
- The phone nav drawer gets the `Guide` entry for free (it renders
  `groupsForSidebar`), which is the browsable half on phone.
- Opening the sheet from the phone drawer MUST close the drawer first —
  `MobileNavDrawer` is itself a `Modal` and `ResponsiveSheet` is another one.
  Reuse the spec-153 `openInstallGuide` ordering (`setMobileDrawerOpen(false)`
  then open).

### 4 — Staff: a `Guide` screen + a `?` in each screen header

Staff gets a **screen**, not a sheet: `ResponsiveSheet` reads `useCmdColors()`
and is therefore an admin-surface component that the staff subtree may not
import (spec 063). The staff surface's own precedent for "a page you navigate to
from a small header control" is spec 126's Settings.

- `src/screens/staff/screens/Guide.tsx` (new), registered as a `Stack.Screen`
  sibling of `Settings` in `StaffStack`, route param `{ topicId?: string }`.
  `topicId` present → that topic's body with a back-to-index control; absent →
  the index list of the 5 staff topics.
- `src/screens/staff/components/HelpButton.tsx` (new) — a direct structural
  mirror of `SettingsGear`: owns its own `useNavigation`, icon-only
  (`help-circle-outline`), ≥44 px target, staff tokens + staff catalog. Dropped
  into the header row of `EODCount`, `Reorder`, `WeeklyCount`, `StorePicker`,
  and `Settings`, each passing its own topic id.
- A **Guide** row in staff `Settings` (between Text size and the install-guide
  card) opens the index with no `topicId`.
- Staff renders **only** `guideTopics('staff')`. Admin topics are structurally
  unreachable from the staff surface: they are a different array in the model and
  their strings only exist in the admin catalog. That is the role-awareness
  guarantee — not a runtime filter that could be bypassed.

### 5 — i18n

Both catalogs get a new top-level `guide` root. Keys are catalog-relative from
the model (`guide.` + `topic.key` + `.title` / `.purpose` / `.actions.N`), plus
chrome keys: `guide.title`, `guide.indexTitle`, `guide.intro`,
`guide.purposeLabel`, `guide.actionsLabel`, `guide.seeAllPages`,
`guide.backToIndex`, `guide.helpAria`, `guide.groups.*`. Admin also adds
`sidebar.items.guide` and `sidebar.groups.help`.

Six files: `src/i18n/{en,es,zh-CN}.json` and
`src/screens/staff/i18n/{en,es,zh-CN}.json`. Volume: ~17 admin topics × ~5 keys +
~5 staff topics × ~5 keys + chrome ≈ **110 keys × 3 locales**. English below is
the source of truth; es / zh-CN are translations of it.

## Content (English source of truth)

PM-authored draft. Wording corrections from the owner are **catalog-only edits**
and do not require a spec revision. Developers must not invent replacement copy —
if a line reads wrong, flag it rather than rewriting the meaning.

### Admin topics

| id | Title | What this page is for | Key actions |
|---|---|---|---|
| `Inventory` | Inventory | The master list of every ingredient this store stocks, with its current on-hand count, unit, cost and vendor. | 1. Search or filter to find an item. 2. Open an item to see its history, cost and which menu items use it. 3. Use `catalog.tsv` to manage the brand-wide catalog and `categories` to organise items into groups. |
| `Dashboard` | Dashboard | The daily health check for this store — what changed, what is running low, what needs attention today. | 1. Scan the summary cards for low stock and today's activity. 2. Click through a card to the section it summarises. |
| `EODCount` | EOD count | End-of-day counting. Staff enter what is physically left at close; this is what keeps on-hand numbers honest. | 1. Enter tonight's counts, item by item. 2. Review what staff submitted for the day. 3. Fix a wrong entry before it flows into reports. |
| `InventoryCount` | Weekly count | The full-store count, done weekly rather than nightly. Catches the drift that a nightly partial count misses. | 1. Start or continue this week's count. 2. Work through every item, including the ones not counted nightly. 3. Submit to set the new baseline. |
| `WasteLog` | Waste log | A record of everything thrown out, spilled or comped, so shrinkage shows up as waste rather than as an unexplained gap. | 1. Log an item, quantity and reason. 2. Review the recent waste history for this store. |
| `Ordering` | Ordering | The reorder list — what to buy, from whom, and how much, based on current stock. Also keeps a read-only history of past orders. | 1. Review the suggested reorder list and adjust quantities. 2. Export or send the order to the vendor. 3. Open History at the bottom to see what was ordered previously. |
| `Vendors` | Vendors | Who you buy from: contact details, order method and which items each vendor supplies. | 1. Add or edit a vendor. 2. Set how orders reach them. 3. See which items are tied to a vendor. |
| `Recipes` | Menu items / BOM | Every menu item and the ingredient list (bill of materials) behind it. This is what turns a sale into an inventory depletion. | 1. Add or edit a menu item. 2. Set the ingredients and quantities it consumes. 3. Check the resulting plate cost. |
| `PrepRecipes` | Prep recipes | Sub-recipes made in-house — sauces, doughs, batches — that other menu items consume as if they were an ingredient. | 1. Create a prep recipe and its ingredient list. 2. Set the batch yield. 3. Use it as an ingredient inside a menu item. |
| `MenuImpact` | Menu impact | How many of each menu item you can still make with what is on hand, and which single ingredient is the limit. | 1. Read the list, lowest makeable quantity first. 2. Check the binding ingredient to see what to reorder first. |
| `Reconciliation` | Reconciliation | The variance report: what the counts say you used versus what you should have used. Where theft, waste and miscounts show up. | 1. Review variance by item for the latest period. 2. Switch to the category or timeline view for the wider pattern. 3. Investigate the biggest dollar gaps first. |
| `POSImports` | POS imports | Bringing sales data in from the point-of-sale system, so sales can deplete inventory automatically. | 1. Run an import or backfill a date range. 2. Review the preview before confirming. 3. Check the import history for failures. |
| `AuditLog` | Audit log | A time-stamped record of who changed what. The place to answer "who edited this and when". | 1. Browse recent changes for this store. 2. Filter to a user, item or date. |
| `Reports` | Reports | Exportable summaries — usage, cost and movement over a date range — for sharing outside the app. | 1. Pick a report and a date range. 2. Export to CSV or PDF. |
| `DBInspector` | DB inspector | A read-only technical view of the raw database tables. For debugging, not for daily work. | 1. Pick a table to inspect. 2. Read the raw rows. Nothing here changes data. |
| `Users` | Users & access | Who can sign in, what role they have, and which stores they can see. | 1. Invite a new user. 2. Change a role or store access. 3. Remove someone who has left. |
| `Brands` | Brands | Super-admin only: the brands (restaurant concepts) this account manages and the stores under each. | 1. Switch the active brand. 2. Review the stores under a brand. |

### Staff topics

| id | Title | What this page is for | Key actions |
|---|---|---|---|
| `EODCount` | Count (end of day) | Entering what is physically left at the end of your shift, so the next order is based on real numbers. | 1. Enter a number for each item you counted. 2. Leave an item blank if you did not count it. 3. Submit before you leave — it saves even without signal and sends when you are back online. |
| `Reorder` | Reorder | Flagging what needs to be bought so the manager sees it. | 1. Mark the items that are running low. 2. Add a quantity or note if you know how much is needed. |
| `WeeklyCount` | Weekly count | The full count of everything in the store, done once a week rather than nightly. | 1. Work through every item on the list. 2. Save as you go — your progress is kept. 3. Submit when the whole list is done. |
| `StorePicker` | Choosing your store | Picking which store you are working at. Everything you enter is recorded against this store. | 1. Tap the store you are working at today. 2. Switch stores from the header if you move. |
| `Settings` | Settings | Your personal settings: notifications, language, text size, reporting a problem, and signing out. | 1. Turn notifications on so you are reminded to count. 2. Change the language or text size. 3. Report a problem if something looks wrong. |

## Acceptance criteria

- [ ] **AC-1** `guideTopics('admin')` returns exactly **17** topics whose ids
      match the 17 sidebar destinations in the Findings table, in sidebar order,
      each with the gate `null` except `Users` (`'master'`) and `Brands`
      (`'superAdmin'`). `guideTopics('staff')` returns exactly **5**:
      `EODCount`, `Reorder`, `WeeklyCount`, `StorePicker`, `Settings`.
      *(Amended by the OQ-1 build, 2026-08-10: with the owner-approved
      `Overview` standalone topic prepended on both surfaces the exact
      id-arrays are now **18** admin / **6** staff — the counts above describe
      the section-derived topics only.)*
- [ ] **AC-2** The admin registry is typed `Record<AdminSectionId, GuideTopic>`;
      adding a member to `AdminSectionId` without adding a topic fails
      `npm run typecheck:test`. `src/lib/guide.ts` imports no store, no `.tsx`
      file, and nothing from `react-native` beyond `Platform` (if at all), so its
      suite runs in the jest **node** project.
- [ ] **AC-3** A nav-parity jest test renders `useDefaultSidebarGroups()` as a
      plain admin, a master and a super_admin and asserts every rendered item id
      other than `Guide` resolves via `findGuideTopic('admin', id)` with a `gate`
      consistent with the role it rendered under.
- [ ] **AC-4** The admin sidebar shows a **Guide** item (id `Guide`) in a **Help**
      group, last, for every admin role, at all three breakpoints (desktop
      sidebar, tablet sidebar, phone drawer). Selecting it renders
      `GuideSection` (testID `cmd-guide-section`).
- [ ] **AC-5** `GuideSection` lists every role-visible topic grouped in sidebar
      order (testID `cmd-guide-index-<id>` per row); selecting one renders
      `GuideTopicBody` (testID `cmd-guide-topic-<id>`) showing the topic title,
      the purpose paragraph and its `actions` bullets — count equal to the
      topic's declared `actions`.
- [ ] **AC-6** At 375 px, `GuideSection` renders as a `PhoneDrillScaffold`
      list → detail: tapping a row slides in the topic, back returns to the list
      with its scroll position intact, and no row, title or bullet is clipped
      horizontally.
- [ ] **AC-7** A `?` control (testID `cmd-guide-entry`) renders in the `TitleBar`
      cluster on desktop and tablet, and as a glyph twin in the collapsed tablet
      rail. Pressing it opens `GuideSheet` (testID `cmd-guide-sheet`) showing the
      topic for the **currently active section**, without changing the active
      section. *(Amended per §0 C-2 — the collapsed-rail glyph twin is struck;
      the TitleBar `?` covers both tablet sub-states — and per review fix
      round 1 — the `?` is suppressed entirely while the active section is
      `Guide` itself.)*
- [ ] **AC-8** On phone, the top app bar's title is pressable and carries a `?`
      marker; pressing it opens `GuideSheet` on the active section's topic. The
      bar stays exactly 52 px tall, the trailing cluster gains **no** new control,
      and at 375 px with a super-admin brand picker present nothing in the bar
      overflows or truncates below one legible word of title.
- [ ] **AC-9** `GuideSheet` offers a "See all pages" affordance that switches it
      to the index; the index rows open topics inside the sheet. Closing the sheet
      returns the user to exactly the screen and state they were on.
- [ ] **AC-10** Opening `GuideSheet` from the phone nav drawer closes the drawer
      **in the same handler** before opening the sheet (never two live `Modal`s).
- [ ] **AC-11** No file under `src/screens/cmd/sections/` other than the new
      `GuideSection.tsx` is modified. The `?` derives its topic from the shell's
      `section` state.
- [ ] **AC-12** Staff `StaffStack` registers a `Guide` screen (testID
      `staff-guide-screen`) taking an optional `topicId` param: with it, the
      topic body; without it, the 5-topic index. A back control returns to the
      index from a topic, and the hardware/browser back returns to the screen the
      user came from.
- [ ] **AC-13** A `HelpButton` (testID `staff-guide-help-button`) renders in the
      header row of `EODCount`, `Reorder`, `WeeklyCount`, `StorePicker` and
      `Settings`, each navigating to `Guide` with **its own** topic id; it is a
      ≥44×44 target and does not push `SettingsGear` or the store name out of the
      header at 375 px.
- [ ] **AC-14** Staff `Settings` shows a **Guide** row (testID
      `staff-guide-entry`) between the Text-size section and the install-guide
      card, opening the index.
- [ ] **AC-15** The staff surface can reach **only** staff topics: no admin topic
      id, title, purpose or action string exists in
      `src/screens/staff/i18n/*.json`, and no staff file imports the admin
      registry export.
- [ ] **AC-16** Every user-visible string in every new view resolves through a
      catalog — no hardcoded English in any component. Every key produced by
      `guideTopicKeys()` for admin topics exists in all three
      `src/i18n/*.json`, and for staff topics in all three
      `src/screens/staff/i18n/*.json`, enforced by a new test plus the two
      existing parity suites.
- [ ] **AC-17** Zero new image assets and zero new dependencies: `git status`
      shows no additions under `assets/` or `public/`, and `package.json` is
      unchanged.
- [ ] **AC-18** Zero backend surface: the diff contains no change to
      `supabase/migrations/*`, `supabase/functions/*`, `supabase/config.toml`,
      `src/lib/db.ts`, `src/store/useStore.ts`, or
      `src/screens/staff/store/useStaffStore.ts`, and the feature issues no
      network request of its own. `app.json` is not modified (slug included).

### Regression group (AC-REG)

- [ ] **AC-REG1** Adopting `AdminSectionId` in `useDefaultSidebarGroups()` and
      `InventoryDesktopLayout` is **type-only**: the rendered groups, item ids,
      labels, order, role gates and the section dispatch are behaviorally
      unchanged, and existing sidebar / shell suites pass unmodified.
- [ ] **AC-REG2** Users with a saved `profiles.sidebar_layout` override still see
      every previously visible item in its saved position, plus `Guide` in its
      default position. No override migration, no `sidebarLayout.ts` change.
- [ ] **AC-REG3** Admin chrome is otherwise unchanged: the spec-153 install-guide
      footer chip and rail twin, the bell / theme / refresh cluster, the phone
      trailing trio, `SessionLostBanner` and `StoreSwitchOverlay` placement all
      stay as they are. `TitleBar` and `MobileTopAppBar` callers that pass no new
      prop render byte-identically.
- [ ] **AC-REG4** Staff screens are otherwise unchanged: the EOD submit + offline
      queue path, the spec-126 Settings section order (Notifications → Language →
      Text size → **[Guide]** → install guide → Report an issue → Sign out), and
      the spec-152 sign-out ordering pins stay green.

## In scope

- One pure, node-testable content model (`src/lib/guide.ts`) with the drift
  guards of §1.
- Admin: a `Guide` sidebar destination + `GuideSection` (two-pane desktop/tablet,
  drill-in phone) + `GuideTopicBody` + `GuideSheet`.
- Admin `?` affordance: TitleBar (desktop + tablet), rail twin (tablet
  collapsed), pressable title (phone).
- Staff: a `Guide` screen in `StaffStack`, a `HelpButton` in the 5 screen
  headers, a Guide row in staff Settings.
- English copy for all 22 topics (above) plus es and zh-CN translations, in both
  catalogs.
- Role-gated topic visibility using the existing `useIsMaster()` /
  `useIsSuperAdmin()` hooks.
- jest coverage per §Verification.

## Out of scope (explicitly)

- **Interactive spotlight / coach-mark tours, tooltips on individual fields, or
  any overlay that follows the user.** Locked decision 1.
- **First-login auto-open, "seen" tracking, dismissal state, or any per-profile
  persistence.** Locked decision 2 — this is what keeps the spec backend-free.
- **Videos, screenshots, GIFs or any image asset.** Same reasoning as spec 153:
  images cannot be localized, go stale, and ignore both theme palettes. Text +
  tokens only.
- **A "getting started / how a day flows" overview topic.** Genuinely useful and
  one registry entry, but not what was asked for — see OQ-1.
- **Search inside the Guide, or ⌘K palette entries for individual topics.** The
  index is 17 rows; search is premature. `Guide` itself may appear in the palette
  if it falls out of the existing section indexing, but no work is done for it.
- **Per-field / per-button help beyond the page-level topic.** Topic granularity
  is the sidebar destination; tabs inside a destination are described in prose
  inside that destination's topic.
- **Documenting dormant surfaces** (`Receiving`, `POsSection`, `OrderSchedule`,
  `RecipeCategories`) or the retired staff Receiving tab — they are not reachable.
- **The customer PWA and any sibling repo.** This repo is admin + staff only.
- **Rewriting existing section copy, empty states or labels** to match the Guide's
  wording. Tangential; a separate cleanup if the owner wants it.
- **Changing `app.json`** — slug, identifiers, EAS config. Hard rule.

## Open questions resolved

- Q: Format — spotlight tour, single static page, or per-page explainers?
  → A (owner): a **Guide** nav section listing every page **plus** a per-screen
  `?` deep-link. Not a spotlight tour, not one static page.
- Q: Should it auto-open for new users on first login, with "seen" tracking?
  → A (owner): **No.** Manual discovery only, always available, no tracking.
- Q: Which surfaces? → A (owner): **both** — the admin Cmd UI and the staff EOD
  app, respecting the spec-063 staff isolation contract.

## Open questions (non-blocking — defaults chosen, owner may overrule)

- **OQ-1 — Overview topic. RESOLVED: BUILT (owner-approved 2026-08-10).** Added
  one short "how a normal day flows" topic at the top of each index. Shipped on
  **both** surfaces per the architect's ruling ("push a `GuideTopic` with
  `group: 'overview'` into `ADMIN_STANDALONE_TOPICS` **(and the staff twin)**").
  It cost exactly the one registry entry per surface the reserved group member
  was designed to make possible — see `## OQ-1 build (2026-08-10)` at the bottom
  of this file.
- **OQ-2 — Phone `?` placement.** Pressable section title with a `?` marker
  **[default]** vs. a fifth glyph in the 52 px trailing cluster.
  *Recommendation: keep the default* — the trailing cluster is already at four
  items for super-admins at 375 px, and Hard Rule 5 forbids growing the bar.
- **OQ-3 — Where `Guide` sits in the sidebar.** A new always-visible **Help**
  group, last **[default]** vs. appended to Insights vs. a footer chip next to
  the spec-153 install chip. *Recommendation: keep the default* — a footer chip
  would not satisfy "a Guide section in the nav", and Insights is for data.
- **OQ-4 — Translation quality.** es / zh-CN for ~110 keys will be
  machine-assisted unless the owner has a translator. **Default: ship
  machine-assisted translations**, consistent with the existing catalogs;
  corrections are catalog-only edits later.
- **OQ-5 — A convention bullet in CLAUDE.md** ("a new Cmd section ships with its
  guide topic in the same PR"), so the drift guard is enforced by review as well
  as by the compiler. *Recommendation: yes*, but CLAUDE.md is owner-owned — it
  is proposed here, not done.
- **OQ-6 — Native (EAS) scope.** The Guide is plain text and works on native as
  written, so no platform gate is proposed (unlike spec 153, which is web-only by
  nature). **Default: ships on both.** Confirm the phone-title affordance is
  acceptable on a native build too.

## Dependencies

- Existing components, unchanged: `ResponsiveSheet`, `PhoneDrillScaffold` /
  `PhoneDetailHeader`, `TabStrip`, `MobileNavDrawer`, `Sidebar` / `RailSidebar`,
  `TitleBar`, `MobileTopAppBar`, staff `SettingsGear` (as the shape for
  `HelpButton`), the Cmd + staff token sets, `useT` / staff `useI18n`,
  `useIsMaster` / `useIsSuperAdmin`.
- Touched for a **type-only** adoption: `src/lib/cmdSelectors.ts`
  (`useDefaultSidebarGroups` item ids), `src/screens/cmd/InventoryDesktopLayout.tsx`
  (`section` prop type + one new dispatch branch).
- No new libraries, no migration, no RPC, no edge function, no `vercel.json` or
  `eas.json` change.

## Verification (test track: **jest**)

- `src/lib/guide.test.ts` (new, **node** project) — AC-1, AC-2 (`@ts-expect-error`
  pin on the exhaustiveness guard; `npm run typecheck:test` is what runs it),
  `guideTopicKeys()` shape, `findGuideTopic()` misses returning `null`.
- `src/lib/guide.i18n.test.ts` (new) — AC-16: every admin key exists in all three
  `src/i18n/*.json`; every staff key in all three staff catalogs; no admin topic
  string leaks into the staff catalogs (AC-15).
- `src/lib/cmdSelectors.guide.test.tsx` (new, jsdom) — AC-3 nav parity across the
  three admin roles.
- `src/screens/cmd/sections/GuideSection.test.tsx` (new) — AC-4, AC-5, AC-6
  (phone drill-in), role filtering.
- `src/components/cmd/GuideSheet.test.tsx` (new) — AC-7, AC-9, topic resolution
  from an active section id.
- `src/screens/cmd/__tests__/ResponsiveCmdShell.spec158.test.tsx` (new, mirroring
  the spec-153 shell test) — AC-7, AC-8, AC-10, AC-REG3 across all three
  breakpoint branches.
- `src/screens/staff/screens/Guide.test.tsx` (new) — AC-12, AC-15.
- `src/screens/staff/components/HelpButton.test.tsx` (new) — AC-13.
- Extend `src/screens/staff/screens/Settings.test.tsx` — AC-14, AC-REG4 order
  (the spec-152 sign-out pins must stay green **unmodified**).
- Gates: full `npx jest` (not a subset), `npx tsc --noEmit`, **and**
  `npm run typecheck:test`.

No pgTAP track (no DB surface). No shell-smoke track (no HTTP surface).

**Manual check (not CI):** desktop Chrome at 1440×900 and 390×844, plus a real
phone at 375 px — the phone title affordance with and without the super-admin
brand picker, the Guide drill-in back-scroll, and the es / zh-CN index at 375 px
(the longest labels).

## Project-specific notes

- **Cmd UI section / legacy:** one new section, `src/screens/cmd/sections/GuideSection.tsx`,
  plus a new sidebar id `Guide` in a new **Help** group. No legacy admin surface
  exists (spec 025). New shared components live in `src/components/cmd/`.
- **Per-store or admin-global:** neither — the Guide is static product
  documentation with no rows and no store scoping. `auth_can_see_store()` is not
  involved; an `auth_can_see_store` grep on this diff must return zero hits.
  Visibility is **role**-gated only (master / super_admin), mirroring the sidebar.
- **Edge function or PostgREST:** **neither.** The feature makes no backend call
  of any kind. Content ships in the i18n catalogs inside the bundle.
- **Realtime channels touched:** none. No `supabase_realtime` publication change,
  so the realtime-publication restart gotcha explicitly does not apply.
- **Migrations needed:** **no.** Also no `profiles` column (locked decision 2
  removed the only candidate), so the `db-migrations-applied.yml` gate has
  nothing to check for this spec.
- **Edge functions touched:** none.
- **Web/native scope:** both. Ships to Vercel (web) and EAS (native) with no
  platform gate — see OQ-6.
- **`app.json` slug:** untouched (`towson-inventory`), per CLAUDE.md's hard rule.
- **Staff isolation (spec 063):** staff imports the shared **pure** model
  `src/lib/guide.ts` only — the same footing as `src/lib/installGuide.ts`. No
  staff file imports `useStore`, a Cmd component, or the Cmd catalog. `guide.ts`
  must never gain a store import.
- **Tests:** jest track only (node project for the model, jsdom for the views).

## Files expected to change (architect may refine)

- `specs/158-in-app-guide.md` (this file)
- `src/lib/guide.ts` (new) + `src/lib/guide.test.ts`, `src/lib/guide.i18n.test.ts` (new)
- `src/lib/cmdSelectors.ts` — `Guide` item + `Help` group; type-only id adoption
- `src/screens/cmd/InventoryDesktopLayout.tsx` — one dispatch branch + `section` prop type
- `src/screens/cmd/sections/GuideSection.tsx` (new) + test
- `src/components/cmd/GuideTopicBody.tsx` (new)
- `src/components/cmd/GuideSheet.tsx` (new) + test
- `src/components/cmd/TitleBar.tsx` — optional `onHelpPress` + `?` control
- `src/components/cmd/MobileTopAppBar.tsx` — optional `onTitlePress` + `?` marker
- `src/screens/cmd/ResponsiveCmdShell.tsx` — guide sheet state, `?` wiring in all
  three branches, rail twin
- `src/screens/staff/screens/Guide.tsx` (new) + test
- `src/screens/staff/components/HelpButton.tsx` (new) + test
- `src/screens/staff/navigation/StaffStack.tsx` — `Guide` stack screen
- `src/screens/staff/screens/{EODCount,Reorder,WeeklyCount,StorePicker,Settings}.tsx` — `<HelpButton />` in the header row
- `src/i18n/{en,es,zh-CN}.json`, `src/screens/staff/i18n/{en,es,zh-CN}.json`

Explicitly **not** in the diff: `supabase/**`, `src/lib/db.ts`,
`src/store/useStore.ts`, `src/screens/staff/store/useStaffStore.ts`,
`src/lib/sidebarLayout.ts`, `vercel.json`, `eas.json`, `app.json`, `package.json`,
and the 21 existing files under `src/screens/cmd/sections/`.

---

## Backend design

Design mode, architect pass. The spec's shape is sound; five things in it do not
survive contact with the code and are corrected below (§0). Everything else is
confirmed as written.

### 0 — Corrections to the spec (binding; these override the §Design text above)

| # | Where | Problem | Ruling |
|---|---|---|---|
| C-1 | §Verification, `src/lib/cmdSelectors.guide.test.tsx` | **This path matches no jest project.** [jest.config.js:84-103](../jest.config.js) node project matches `src/lib/**/*.test.ts` (not `.tsx`); the jsdom project matches only `src/components/**` and `src/screens/**`. The file would be silently never run. | Relocate to **`src/screens/cmd/__tests__/navGuideParity.test.tsx`** (matches `src/screens/**/*.test.tsx`). Do **not** widen `jest.config.js`. |
| C-2 | §3, tablet collapsed rail twin | The `?` is proposed in `TitleBar`, but the tablet branch renders `TitleBar` **always** and *then* forks `RailSidebar` XOR `Sidebar` ([ResponsiveCmdShell.tsx:537-585](../src/screens/cmd/ResponsiveCmdShell.tsx)). A rail twin would render a **second** live `?` and a **duplicate `cmd-guide-entry` testID** on collapsed tablet. This differs from spec 153, whose chip lives in `sidebarFooterLeft` (genuinely XOR with the rail). | **Drop the rail twin entirely.** The TitleBar `?` already covers both tablet sub-states. AC-7's "and as a glyph twin in the collapsed tablet rail" is struck; `railFooter` is not touched. |
| C-3 | §1 / AC-2, `Record<AdminSectionId, GuideTopic>` | `Guide` is itself a sidebar id, so it lands in `AdminSectionId`, so an exhaustive `Record` would demand an 18th topic — contradicting AC-1's "exactly 17". | Registry is `Record<Exclude<AdminSectionId, GuideExemptSectionId>, GuideTopic>` with `type GuideExemptSectionId = 'Guide'` **named as its own type**, so a future exemption is a deliberate, reviewable edit. |
| C-4 | §Dependencies, `InventoryDesktopLayout` `section` prop type | **Rejected.** `section` is fed by `useState<string>`, by `Sidebar.onSelect: (id: string) => void` ([Sidebar.tsx:20](../src/components/cmd/Sidebar.tsx)), and by `usePaletteAction.pending.section: string` ([paletteAction.ts:11](../src/lib/paletteAction.ts)). Narrowing the prop forces either an `as` cast (a lie) or a runtime guard (a behavior change that violates AC-REG1). It also buys nothing: the dispatch is an if-chain with a `ComingSoonPanel` fallback, not an exhaustive switch, and `DBInspector` is a sidebar id that is *never* a `section` value (it navigates to a sibling stack screen). | `section: string` stays. `InventoryDesktopLayout`'s only change is **one new dispatch branch**. |
| C-5 | §4 / AC-13, `HelpButton` on `StorePicker` | `StorePicker` renders in a **different `Stack.Navigator`** than `StaffTabs`/`Settings` ([StaffStack.tsx:186-207](../src/screens/staff/navigation/StaffStack.tsx)) — which is exactly why `SettingsGear` is not on it. `navigate('Guide')` from `StorePicker` would target an unregistered route. | Register the `Guide` `Stack.Screen` in **both** the `activeStore` branch and the picker branch. The Guide screen reads no store state, so it is valid in the pre-store branch. Splash branch unchanged. |

### 1 — Data model changes

**None.** No table, no column, no index, no view, no trigger, no grant.
**No migration file is created**, so there is no `supabase/migrations/YYYYMMDDHHMMSS_*.sql`
proposal in this design and nothing for the `db-migrations-applied.yml` gate to
compare (it stays trivially green).

The Guide's content is **static product documentation shipped in the i18n
catalogs inside the JS bundle**. A `guide_topics` table was considered and
rejected: 22 static rows would drag in RLS policy design, per-locale row storage,
a realtime channel decision, a `db.ts` fetch + mapper, a loading state, and a
brand/store-scoping question — all for content that changes at the same cadence
as the code that it documents. The tradeoff is recorded in §8 (R-7).

### 2 — RLS impact

**None.** No new table, therefore no new policy. No existing policy changes.
Neither `auth_is_admin()` nor `auth_can_see_store()` is involved: the Guide has
no rows and no store scope. Per §Project-specific notes, an `auth_can_see_store`
grep on this diff must return **zero hits**.

Visibility is **role**-gated in the client only, using the same two hooks the
sidebar uses — `useIsMaster()` ([useRole.ts:45](../src/hooks/useRole.ts)) and
`useIsSuperAdmin()` ([useRole.ts:24](../src/hooks/useRole.ts)). This is
**presentation gating, not authorization**: the gated topics are static English
prose describing that "Users & access" and "Brands" exist. Nothing behind them is
secret, and a determined non-master reading the JS bundle learns nothing they
could not learn from the sidebar's own labels. Security reviewers should treat
the topic gate as cosmetic parity with the nav, **not** as an access control —
the real gate remains `auth_is_privileged()` on the DB side and the edge-function
`ADMIN_ROLES` set.

### 3 — API contract

**Neither PostgREST nor RPC.** The feature issues **zero network requests of its
own** — no `supabase.from`, no `supabase.rpc`, no `supabase.functions.invoke`, no
`callEdgeFunction`, no bare `fetch`. There is no request shape, no response
shape, and no error case, because there is no call.

The only "contract" is the pure-model API in §5.

### 4 — Edge function changes

**None.** No function added, removed, or modified. `supabase/config.toml` is not
touched, so no `verify_jwt` decision and no service-token validation strategy is
in play. Cold start is not a consideration — see §8 (R-10).

### 5 — Module contract: `src/lib/adminSections.ts` + `src/lib/guide.ts`

Two new pure modules, both node-project-testable, both store-free and `.tsx`-free.

**`src/lib/adminSections.ts` (new — architect addition, not in the spec's file list).**
The section-id union does **not** belong in `guide.ts`: making `cmdSelectors.ts`
(core navigation) depend on the guide model inverts the dependency direction —
documentation should depend on the product, never the reverse — and a future
non-guide consumer of the union (deep links, palette routing) would have to
import the docs module to get it. A 15-line neutral module costs nothing and
reads right.

```ts
/** Every sidebar destination id, in default sidebar order. Load-bearing:
 *  these strings are the spec-008 override keys AND the guide topic ids. */
export const ADMIN_SECTION_IDS = [
  'Inventory', 'Dashboard', 'EODCount', 'InventoryCount', 'WasteLog',
  'Ordering', 'Vendors', 'Recipes', 'PrepRecipes',
  'MenuImpact', 'Reconciliation', 'POSImports', 'AuditLog', 'Reports', 'DBInspector',
  'Users', 'Brands',
  'Guide',
] as const;
export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];
```

`guide.ts` **re-exports** `AdminSectionId`, so AC-2's wording ("a union exported
from this same pure module") stays literally true.

**`src/lib/guide.ts` (new).** Signatures as the spec gives them, with these
amendments:

```ts
export type GuideAudience = 'admin' | 'staff';
export type GuideGate = null | 'master' | 'superAdmin';
export type GuideGroup =
  | 'overview'          // reserved for OQ-1; no topic uses it today
  | 'operations' | 'planning' | 'insights' | 'admin' | 'tenancy' | 'staff';

export interface GuideTopic {
  id: string; audience: GuideAudience; gate: GuideGate;
  group: GuideGroup; key: string; actions: number;
}

/** Sections that are deliberately undocumented. Naming the exemption as a
 *  type makes adding one a reviewable edit rather than an inline Exclude. */
export type GuideExemptSectionId = 'Guide';

/** The exhaustive half — this is the compile-time drift gate (C-3). */
declare const ADMIN_SECTION_TOPICS:
  Record<Exclude<AdminSectionId, GuideExemptSectionId>, GuideTopic>;

/** Topics with NO sidebar destination. Empty today; OQ-1's overview topic
 *  is pushed here and nothing else changes (§7, OQ-1). */
declare const ADMIN_STANDALONE_TOPICS: readonly GuideTopic[];   // []
declare const STAFF_TOPICS: readonly GuideTopic[];              // 5 entries

export function guideTopics(a: GuideAudience): GuideTopic[];
export function findGuideTopic(a: GuideAudience, id: string | null | undefined): GuideTopic | null;
export function guideTopicKeys(t: GuideTopic): string[];
/** Catalog-relative chrome keys, so the parity test covers them too (§8 R-9). */
export const GUIDE_CHROME_KEYS: readonly string[];
export type { AdminSectionId };
```

Hard constraints on `guide.ts` (mirroring
[installGuide.ts](../src/lib/installGuide.ts)'s contract, which is what makes it
spec-063-legal for the staff subtree to import):

- imports **no** store (`useStore` / `useStaffStore`) — ever;
- imports **nothing** from a `.tsx` file;
- imports **nothing** from `react-native` (not even `Platform` — it needs none);
- imports `AdminSectionId` from `adminSections.ts` as `import type`, so the
  runtime module graph gains no edge at all;
- registers no listener, reads no global.

`guideTopics('admin')` returns `[...ADMIN_STANDALONE_TOPICS, ...sectionTopicsInOrder]`
where section order is `ADMIN_SECTION_IDS` order minus the exempt ids.
`findGuideTopic` returns `null` for an unknown id — **every consumer falls back
to the index and never throws**. That is the deep-link-safety contract for both
surfaces.

### 6 — The three-layer drift guard (the PM's question, answered)

**Verdict: keep the compile-time layer, but move where it bites. It is not
either/or with a test gate — the two catch different failures, and the spec's
proposed seam only half-works as written.**

**Layer 1 — compile-time, one annotation in `cmdSelectors.ts` (type-only).**
The critical detail the spec glosses: `TreeItem.id` is `string`
([TreeGroup.tsx:8](../src/components/cmd/TreeGroup.tsx)), and assigning a string
literal into a `string` field produces **no error**. So `Record<AdminSectionId,
GuideTopic>` alone catches nothing — the chain only closes if the sidebar's item
ids are *forced* to be union members. The precise, safe formulation:

```ts
// cmdSelectors.ts — local type; TreeItem itself is NOT changed.
type NavItem = Omit<TreeItem, 'id'> & { id: AdminSectionId };
```

Annotate each group's item array as `NavItem[]` locally, then compose the
`SidebarGroup[]` as today (`AdminSectionId extends string`, so it widens
silently). The drift chain then closes: new sidebar id → `NavItem[]` rejects it →
dev adds it to `ADMIN_SECTION_IDS` → `Record<Exclude<...>>` is missing a key →
dev writes a topic. `npm run typecheck:test` and `npx tsc --noEmit` both run it.

**`TreeItem.id` MUST stay `string`.** Narrowing it would break
[sidebarLayout.ts](../src/lib/sidebarLayout.ts), whose legacy remap operates on
ids that are deliberately *not* union members (`Reorder`, `PurchaseOrders`,
`Receiving` — lines 70-84). `sidebarLayout.ts`, `Sidebar.tsx`, `RailSidebar.tsx`,
`MobileNavDrawer.tsx` and `SidebarEditMode.tsx` are all untouched.

**Layer 2 — nav parity test** (`src/screens/cmd/__tests__/navGuideParity.test.tsx`,
per C-1). Catches what the compiler structurally cannot: a topic whose `gate`
drifted from the sidebar's role gate. Keep exactly as AC-3 describes.

**Layer 3 — i18n parity**, as specced, plus `GUIDE_CHROME_KEYS` (§8 R-9).

**Why not test-only.** The compile gate fires in the developer's editor on the
line they are editing, before a commit exists; the test fires minutes later in
CI, in a file they have never opened. Given this repo's history of green-CI blind
spots (CLAUDE.md's `db-migrations-applied` and spec-060 notes), the cheaper,
earlier signal is worth 3 lines of type annotation. **Why not compile-only.** The
compiler cannot see role gates, and a lazy `as AdminSectionId` cast defeats it —
Layer 2 catches both. Ship both.

**Escape hatch, documented deliberately:** a dev who adds a section reachable
only via `usePaletteAction` (not the sidebar) bypasses both layers. That is
in-contract — guide topics track *sidebar destinations* by design (§Findings).

### 7 — Rulings on the six open questions

| OQ | Ruling | Notes for the developer |
|---|---|---|
| **OQ-1** overview topic | **DEFERRED TO OWNER — do NOT build it.** | The registry is designed so adding it later is *one entry*: push a `GuideTopic` with `group: 'overview'` into `ADMIN_STANDALONE_TOPICS` (and the staff twin) + its ~5 strings per locale. To make that literally true, ship the `'overview'` member of `GuideGroup` **now** (unused) and ship `guide.groups.overview` in all six catalogs now (6 strings; keeps 3-way parity intact and costs nothing). AC-1's count assertion should be written as an **exact id-array equality**, so the later change is one line in the test. |
| **OQ-2** phone `?` placement | **Uphold the default** — pressable section title + `?` marker. | Hard Rule 5 is non-negotiable and the trailing cluster is at four controls for super-admins at 375 px. Requirements: the title `Text` keeps `numberOfLines={1}`; the pressable wraps the whole title area with `accessibilityRole="button"` + `accessibilityLabel={T('guide.helpAria')}`; the `?` glyph is **always visible** (never hover-only) since a pressable title is otherwise undiscoverable; `MobileTopAppBar` callers passing no `onTitlePress` render a plain `Text` byte-identically (AC-REG3). |
| **OQ-3** `Guide` in a Help group, last | **Uphold the default.** | The item is a normal sidebar item: it is hideable in spec-008 edit mode like any other, with **no special-casing**. Hiding it is not a dead end because the `?` remains. |
| **OQ-4** machine-assisted es/zh-CN | **Uphold the default.** | Two hard constraints: (a) the **English is spec-locked verbatim** — translate *from* it, never regenerate it, and never "improve" it (§Content); (b) guide catalog strings contain **no `{var}` placeholders**, so the `t()` substitution path is unexercised and a translator cannot break interpolation. |
| **OQ-5** CLAUDE.md convention bullet | **Do NOT edit CLAUDE.md in this PR.** | CLAUDE.md is owner-owned and outside agent authority. Proposed text, for the owner to apply if they want it: *"A new Cmd sidebar destination ships with its `src/lib/guide.ts` topic and its catalog strings in the same PR. `src/lib/adminSections.ts` is the id union; `Record<Exclude<AdminSectionId, GuideExemptSectionId>, GuideTopic>` fails the build until the topic exists."* |
| **OQ-6** native scope | **Ships on both, no platform gate** — with one documented caveat. | `TitleBar` returns `null` off-web ([TitleBar.tsx:84](../src/components/cmd/TitleBar.tsx)), so the desktop/tablet `?` is web-only *by inheritance*. On a native tablet the Guide is reached via the sidebar `Guide` item — the same as every other TitleBar affordance today. This is **not a bug**; reviewers should not file it. The phone pressable-title affordance works on native (`MobileTopAppBar` renders there). |

### 8 — `src/lib/db.ts` surface

**None.** No new helper, no modified helper, no new mapper. There is no
snake_case → camelCase mapping because there is no row.

Corollary for reviewers: **any `supabase.from` / `supabase.rpc` /
`supabase.functions.invoke` / `fetch` call anywhere in this diff is a Critical
finding**, whether it is inside `db.ts` or (worse) outside it. The documented
`db.ts` carve-outs (`auth.ts`, `webPush.ts`, `authGate.ts`, `sessionRestore.ts`,
the `src/screens/staff/` subtree) are irrelevant here — this feature has no data
access to carve out.

### 9 — Realtime impact

**None.** Neither `store-{id}` nor `brand-{id}` replays anything for this
feature; [useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) is not touched and
its 400 ms debounce is not involved.

**Publication gotcha — explicitly does not apply.** This migration-free spec
makes no change to `supabase_realtime` publication membership, so
`docker restart supabase_realtime_imr-inventory` after `npm run dev:db` is **not**
a required dev/deploy step for spec 158. (Stated affirmatively so a reviewer
checking the standard architect checklist can tick it and move on.)

### 10 — Frontend store impact

**None — and this is binding, not incidental.** No slice of
[src/store/useStore.ts](../src/store/useStore.ts) changes, and no slice of
`src/screens/staff/store/useStaffStore.ts` changes. Both files appear in AC-18's
prohibited list.

The **optimistic-then-revert + `notifyBackendError` pattern does not apply**,
because the feature performs no mutation and has nothing to revert. Reviewers
should not ask for it. State lives where spec 153 put its equivalent:

- **Admin sheet:** plain `React.useState` in `ResponsiveCmdShell` — mirroring
  `installGuideOpen` ([ResponsiveCmdShell.tsx:135](../src/screens/cmd/ResponsiveCmdShell.tsx)).
  Two fields: `guideSheetOpen: boolean` and `guideSheetTopicId: string | null`.
  `GuideSheet` owns its internal index-vs-topic view and **re-seeds it from the
  `topicId` prop on every `visible` false→true transition** (an effect, not a
  remount), so reopening on a new section never shows the previous topic.
- **Admin `GuideSection`:** selected-topic id is component state; nothing
  persists across a section switch, and nothing is written to `profiles`.
- **Staff:** the selected topic is a **route param** (`{ topicId?: string }`),
  not store state — `useStaffStore` is not imported by `Guide.tsx` or
  `HelpButton.tsx` at all. That store-free property is what makes C-5's
  dual-branch registration valid.

Drawer/modal ordering (AC-10): reuse `openInstallGuide`'s exact shape —
`setMobileDrawerOpen(false)` then open, **in the same handler**
([ResponsiveCmdShell.tsx:290-293](../src/screens/cmd/ResponsiveCmdShell.tsx)).
`MobileNavDrawer` is a `Modal` and `ResponsiveSheet` is another; two live at once
is the failure mode.

### 11 — Staff isolation (spec 063) — enforcement detail

`src/lib/guide.ts` is shared on exactly the same footing as
`src/lib/installGuide.ts`: a pure model, catalog-relative keys, two independent
catalog trees.

- The staff subtree imports **only** `guideTopics`, `findGuideTopic`,
  `guideTopicKeys`, `GUIDE_CHROME_KEYS`, and the types. It must **never** import
  `ADMIN_SECTION_TOPICS` or `ADMIN_STANDALONE_TOPICS` — that is the concrete
  reading of AC-15's "the admin registry export", and the name reviewers should
  grep for.
- Every staff call site passes the **literal** `'staff'` as the audience.
  Threading the audience through a route param, a prop, or a variable is
  forbidden — a `topicId` route param is caller-controlled, an audience must not
  be.
- No staff file imports `useStore`, a `src/components/cmd/` component, or
  `src/i18n/`. `ResponsiveSheet` reads `useCmdColors()` and is therefore
  admin-only; staff gets a **screen**, per §4 — that reasoning is confirmed
  correct.
- `src/lib/adminSections.ts` is never imported by the staff subtree (only
  `guide.ts` references it, `import type`, so it is erased and never enters the
  staff bundle).

### 12 — AC-18 is binding: this spec has zero backend surface

Confirming explicitly, as requested, so reviewers can treat it as a bright line:

> **No migration. No RPC. No edge function. No `config.toml` change. No
> `db.ts` change. No store change. No network request. No realtime change.
> No `app.json` change (slug stays `towson-inventory`, untouched — CLAUDE.md
> hard rule).**

Any of the following appearing in the implementation diff is **contract drift and
a Critical finding at review**, regardless of how small or how well-intentioned:

- any file under `supabase/` (migrations, functions, `config.toml`, `seed.sql`)
- `src/lib/db.ts`, `src/store/useStore.ts`, `src/screens/staff/store/useStaffStore.ts`
- `src/lib/sidebarLayout.ts`, `jest.config.js`, `package.json`, `app.json`,
  `vercel.json`, `eas.json`
- `CLAUDE.md` (see OQ-5)
- any file under `assets/` or `public/` (AC-17)
- any existing file under `src/screens/cmd/sections/` other than the new
  `GuideSection.tsx` (AC-11)

### 13 — Refined file list (supersedes §Files expected to change)

Additions and changes vs. the spec's list:

- **+ `src/lib/adminSections.ts`** (new; §5)
- **`src/lib/cmdSelectors.ts`** — `Guide` item + `Help` group + the local
  `NavItem` annotation (type-only; §6)
- **`src/screens/cmd/InventoryDesktopLayout.tsx`** — **one** new dispatch branch
  only. `section === 'Guide' ? <GuideSection /> : ...` must be placed **before**
  the `section !== 'Inventory'` `ComingSoonPanel` fallback
  ([line 358](../src/screens/cmd/InventoryDesktopLayout.tsx)), or the Guide
  renders as "coming soon". **No `Props.section` retype** (C-4).
- **`src/screens/cmd/ResponsiveCmdShell.tsx`** — sheet state + `?` wiring in the
  desktop, tablet and phone branches. **No `railFooter` change** (C-2).
- **`src/screens/staff/navigation/StaffStack.tsx`** — `Guide` `Stack.Screen`
  registered in **both** navigator branches (C-5).
- **− `src/lib/cmdSelectors.guide.test.tsx`** → **`src/screens/cmd/__tests__/navGuideParity.test.tsx`** (C-1)
- Everything else in the spec's list stands.

### 14 — Risks and tradeoffs

- **R-1 (was Critical, fixed by C-1) — a test that never runs.** The original
  test path matched no jest project. A reviewer seeing the file on disk would
  score AC-3 as covered while nothing executed. Verify at review time with
  `npx jest --listTests | grep -i guide` — every new suite must appear.
- **R-2 (fixed by C-2) — duplicate `?` on collapsed tablet.** Would also have
  produced a duplicate `cmd-guide-entry` testID, which `getByTestId` throws on —
  so the shell test would have failed confusingly rather than obviously.
- **R-3 — the compile gate is defeatable by an `as AdminSectionId` cast.** Layer 2
  covers it, but the cast is invisible to Layer 2 if the topic *also* gets added
  with the wrong gate. Accepted; a cast on a sidebar id is a review smell and
  reviewers should reject it.
- **R-4 — `applySidebarOverride` buckets by the *translated* group label**
  ([sidebarLayout.ts:168](../src/lib/sidebarLayout.ts)). A saved override written
  in English and re-merged under `es` already mis-buckets today. Adding a sixth
  group widens the surface of that **pre-existing latent bug** by one. **Out of
  scope for 158 — do not fix it here** (AC-REG2 forbids touching
  `sidebarLayout.ts`); flagged so a future spec owns it.
- **R-5 — migration ordering: not applicable.** No migration exists, so there is
  no ordering hazard, no prod-push step, and no `schema_migrations` insert. The
  Supabase-MCP prod-apply procedure is not exercised.
- **R-6 — seed-dataset performance: not applicable.** The Guide reads zero rows;
  the 286 KB seed is irrelevant to it. The only runtime cost is `guideTopics()`
  allocating a ≤17-element array — memoize with `useMemo` in the views and move
  on.
- **R-7 — content lives in the bundle, so wording fixes need a deploy.** An owner
  typo fix is a PR + Vercel deploy for web, and an **EAS build for native**
  (native users will lag until they update). This is the accepted price of
  §1's no-table decision. If the owner later wants same-day copy edits without a
  deploy, that is a separate spec with a real backend design — not a patch to
  this one.
- **R-8 — catalog growth.** ~110 keys × 3 locales × 2 catalogs; guide prose is
  much longer per key than existing chrome strings (~340 chars/topic). Rough
  order: ~25 KB added to the admin bundle, ~7 KB to staff, across all three
  statically-imported locales. Negligible against the current bundle; no
  lazy-loading, no code-splitting, no action.
- **R-9 — chrome keys are outside `guideTopicKeys()`'s coverage.** `guide.title`,
  `guide.seeAllPages`, `guide.backToIndex` etc. are not topic keys, so a typo in
  one renders the raw dot-path (`t()` returns the key path —
  [i18n.test.ts:179-186](../src/i18n/i18n.test.ts)) and the 3-way parity suite
  would not notice, because a *consistently* misspelled key is present in all
  three locales. Mitigation: **export `GUIDE_CHROME_KEYS` from `guide.ts`** and
  assert it in `src/lib/guide.i18n.test.ts` alongside the topic keys. This closes
  the raw-key-path hole completely.
- **R-10 — edge-function cold start: not applicable.** No function is invoked, so
  there is no Deno boot latency and the
  [CLAUDE.md](../CLAUDE.md) local edge-runtime bind-mount gotcha is not in play
  for this spec either.
- **R-11 — a pressable title is low-discoverability.** The always-visible `?`
  marker is the mitigation and it is a *requirement*, not a nicety (OQ-2). If the
  owner rejects it after the manual 375 px check, the cheapest fallback is
  promoting `Guide` to the first row of the phone drawer — no chrome change at
  all. Do not fall back to a fifth glyph in the trailing cluster.
- **R-12 — the topic role gate is cosmetic, not authorization.** Restated from §2
  so a security reviewer does not mistake it for an access control.

---

## Files changed

Implemented per the `## Backend design` section, with §0's five corrections
(C-1…C-5) overriding the original `## Design` text. **Zero backend surface**:
the diff contains no `supabase/**`, no `src/lib/db.ts`, no `src/store/useStore.ts`,
no `src/screens/staff/store/useStaffStore.ts`, no `src/lib/sidebarLayout.ts`, no
`jest.config.js`, `package.json`, `app.json`, `vercel.json`, `eas.json`,
`CLAUDE.md`, and nothing under `assets/` or `public/` (AC-17, AC-18, §12).

### New — pure model
- `src/lib/adminSections.ts` — `ADMIN_SECTION_IDS` + `AdminSectionId` (§5 architect addition)
- `src/lib/guide.ts` — the registry, `guideTopics` / `findGuideTopic` /
  `guideTopicKeys` / `visibleGuideTopics` / `GUIDE_CHROME_KEYS`; imports no store,
  no `.tsx`, nothing from `react-native`, and `adminSections` only as `import type`

### New — admin surface
- `src/components/cmd/GuideTopicBody.tsx` — the ONE topic renderer (section + sheet)
- `src/components/cmd/GuideSheet.tsx` — the `?` sheet (`cmd-guide-sheet`)
- `src/screens/cmd/sections/GuideSection.tsx` — the `Guide` destination
  (`cmd-guide-section`); two-pane desktop/tablet, `PhoneDrillScaffold` at phone

### New — staff surface
- `src/screens/staff/screens/Guide.tsx` — the `Guide` screen (`staff-guide-screen`)
- `src/screens/staff/components/HelpButton.tsx` — the per-screen `?` (`staff-guide-help-button`)

### New — tests
- `src/lib/guide.test.ts` (node) — AC-1, AC-2, key shape, `findGuideTopic` misses
- `src/lib/guide.i18n.test.ts` (node) — AC-16, AC-15 (catalog + staff-subtree grep), R-9
- `src/screens/cmd/__tests__/navGuideParity.test.tsx` (jsdom) — AC-3, AC-4, AC-REG1
  *(relocated from the spec's `src/lib/cmdSelectors.guide.test.tsx`, which matched no
  jest project — §0 C-1)*
- `src/screens/cmd/sections/GuideSection.test.tsx` — AC-4, AC-5, AC-6, role filtering
- `src/components/cmd/GuideSheet.test.tsx` — AC-7, AC-9, §10 re-seed
- `src/screens/cmd/__tests__/ResponsiveCmdShell.spec158.test.tsx` — AC-7, AC-8, AC-10,
  AC-REG3, and the C-2 "exactly one `cmd-guide-entry`" pin
- `src/screens/staff/screens/Guide.test.tsx` — AC-12, AC-15
- `src/screens/staff/components/HelpButton.test.tsx` — AC-13

### Modified — admin
- `src/lib/cmdSelectors.ts` — the `Help` group + `Guide` item; local
  `type NavItem = Omit<TreeItem,'id'> & { id: AdminSectionId }` applied to each
  group's item array via `satisfies` (type-only; `TreeItem.id` stays `string`)
- `src/screens/cmd/InventoryDesktopLayout.tsx` — ONE dispatch branch, placed before
  the `section !== 'Inventory'` `ComingSoonPanel` fallback. No `Props.section` retype (C-4)
- `src/screens/cmd/ResponsiveCmdShell.tsx` — `guideSheetOpen` / `guideSheetTopicId`
  state, `openGuideSheet` (closes the phone drawer in the same handler), `?` wiring in
  all three branches, sheet mounted per branch. **No `railFooter` change** (C-2)
- `src/components/cmd/TitleBar.tsx` — optional `onHelpPress` + the `?` control before the bell
- `src/components/cmd/MobileTopAppBar.tsx` — optional `onTitlePress` / `titlePressLabel`
  + an always-visible trailing `?` marker inside the title area (OQ-2)

### Modified — staff
- `src/screens/staff/navigation/StaffStack.tsx` — `Guide` `Stack.Screen` in **both**
  signed-in navigator branches (C-5)
- `src/screens/staff/screens/{EODCount,Reorder,WeeklyCount,StorePicker,Settings}.tsx` —
  `<HelpButton topicId="…" />` in the header row; Settings also gains the Guide row
  between Text size and the install-guide card

### Modified — catalogs
- `src/i18n/{en,es,zh-CN}.json` — `guide.*` root (17 topics + chrome) +
  `sidebar.groups.help` + `sidebar.items.guide`
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — `guide.*` root (5 topics + chrome)

### Modified — existing tests (boundary stubs only, no pinned behavior changed)
- `src/components/cmd/MobileTopAppBar.test.tsx` — added the spec-158 affordance block
- `src/screens/cmd/__tests__/ResponsiveCmdShell.spec153.test.tsx` — stubs `GuideSheet`
  and adds `useIsMaster` to the existing `useRole` mock (the shell now mounts one more
  child); every spec-153 assertion is unchanged
- `src/screens/staff/screens/Settings.test.tsx` — hoisted the `navigate` mock; added the
  AC-14 / AC-13 block. The spec-152 sign-out pins are untouched
- `src/screens/staff/screens/StorePicker.test.tsx` — added a `useNavigation` stub (the
  header now carries `HelpButton`) + the AC-13 block

## Verification performed

- `npx jest --listTests | grep -i -e guide -e navGuide` — every new suite is discovered
  (R-1's "test that never runs" is closed).
- **Full `npx jest`: 210 suites / 2325 tests, all green.**
- `npx tsc --noEmit` — clean. `npm run typecheck:test` — clean.
- **Browser (local stack, `localhost:8081`, Playwright-driven Chromium):** 38 assertions,
  **0 console errors, 0 failed / 4xx requests**. Covered: desktop 1440 (sidebar `Guide`
  in a HELP group last, `GuideSection` two-pane, row → topic swap, bullet count == the
  declared `actions`, gated `Users` hidden for a plain admin and shown for master,
  TitleBar `?` opening the sheet on the ACTIVE section without changing it, "See all
  pages" → index → topic, close returns to the same screen); tablet 900 (exactly ONE
  `cmd-guide-entry`, confirming C-2); phone 375 in **light and dark** (52 px bar, `?`
  marker on the title, fullscreen sheet, drawer → `GuideSection` drill-in, back returns
  to the list, zero horizontal overflow); **es and zh-CN at 375 px** (zero overflow in
  both the index and the detail); staff at 375 (the `?` on StorePicker opening the Guide
  from the picker branch — C-5 — the 5-topic index with no admin topic present, the
  header back returning to the picker, the in-store EOD header `?` opening the EODCount
  topic without displacing the store name / Refresh / Settings, and the Settings Guide
  row in its AC-REG4 position).

## Deviations to flag at review

1. **`guide.back` catalog key (additive).** §5 enumerates the chrome keys; the staff
   Guide screen also needs a "return to the screen you came from" label for its header
   back control (`navigation.goBack()`), which none of the listed keys covers. Added as
   `guide.back` in all six catalogs and to `GUIDE_CHROME_KEYS`, so it is covered by the
   R-9 parity assertion. Reusing `chrome.settings.back` would have coupled the Guide to
   the Settings catalog namespace.
2. **AC-13's "≥44×44" is met via `hitSlop`, not the visual box.** The staff surface's
   own density pass put `touchTarget.min` at **24** at scale x1 (`SettingsGear`,
   `ListRow` and the rest of the surface sit on that token). Hard-coding 44 would render
   the `?` visibly larger than the gear beside it and break the surface's scale system.
   `HelpButton` therefore sizes its box from the token and adds
   `hitSlop={{top:10,bottom:10,left:10,right:10}}` so the *touch* target is ≥44×44 at
   x1 and larger at x1.2 / x1.5. Pinned in `HelpButton.test.tsx`.
3. **`GuideSection.tsx` imports `PhoneDrillScaffold` / `usePhoneDrill` from
   `./phone/`.** AC-11 forbids modifying existing files under
   `src/screens/cmd/sections/`; nothing under it is modified — these are read-only
   imports of the shared spec-142 scaffold, which is the pattern AC-6 mandates.
4. **`visibleGuideTopics()` added to `src/lib/guide.ts`** (not in the §5 signature list).
   It is the pure, node-testable home for the role-gate filter that `GuideSection` and
   `GuideSheet` both need; keeping it in the model prevents the two views drifting from
   each other. It takes the role booleans as arguments, so `guide.ts` stays hook-free.
5. **`ADMIN_SECTION_ORDER` is derived from the registry's own key order**, not from a
   runtime import of `ADMIN_SECTION_IDS`, because §11 requires the `adminSections`
   import to stay `import type` (so the module is erased from the staff bundle).
   `guide.test.ts` pins the resulting id array against `ADMIN_SECTION_IDS` minus the
   exempt ids, so the hand-written order cannot silently drift.
6. **OQ-1 not built, as instructed.** The reserved `'overview'` `GuideGroup` member and
   `guide.groups.overview` ship in all six catalogs; `guide.test.ts` asserts that no
   topic uses the group today.

---

## Review fix round 1 (2026-08-10)

Applied after code-reviewer (0 Critical / 1 Should-fix / 2 Nits), security-auditor
(0 Critical/High/Medium, 2 Lows) and test-engineer (21 PASS / 0 FAIL).

### Should-fix (applied) — the `?` is suppressed on the Guide page itself

`Guide` is deliberately undocumented (`GuideExemptSectionId`), so pressing `?` while
already on the Guide page opened `GuideSheet` in its **index fallback** on top of
`GuideSection`'s own always-visible index — a redundant popup over the same content, and
two live trees emitting the same `cmd-guide-index-<id>` testIDs.

Fixed in `src/screens/cmd/ResponsiveCmdShell.tsx` with two lines that together make the
invariant hold **unconditionally**, not just along today's reachable paths:

- `const guideEntryHandler = section === 'Guide' ? undefined : openGuideSheet;` passed to
  `TitleBar.onHelpPress` (desktop + tablet) and `MobileTopAppBar.onTitlePress` (phone).
  Passing `undefined` rather than a no-op handler is what keeps the tree clean: both props
  are optional, so `TitleBar` renders **no control at all** and `MobileTopAppBar` falls
  back to its plain, non-pressable title. Suppression, not a dead button.
- An effect that clears `guideSheetOpen` if `section` becomes `Guide` while the sheet is
  already open. Clearing the flag (rather than gating `visible`) means leaving Guide
  cannot resurrect a stale sheet.

### Security Low #1 (applied — it was a one-liner)

`GuideSheet`'s seed path now resolves through the same role-gated list the index view
uses (`topics.find(...)` over `visibleGuideTopics(...)`) instead of the ungated
`findGuideTopic`, so the two share exactly one gate. `findGuideTopic` is no longer
imported by that file. Behavior for a role that CAN see the topic is unchanged (verified
in the browser as master on `Users`); a gated id now falls back to the index, which is
the same deep-link-safety contract as before.

### Nits — not taken

- **Nit 1 (duplicated index-row markup between `GuideSection` and `GuideSheet`):** the
  reviewer flagged it as awareness-only and out of scope. Factoring a shared row component
  would touch both files and re-plumb the testIDs — not zero-cost, so deferred rather than
  done mid-review-round. Worth a follow-up spec if a third index consumer ever appears.
- **Nit 2 (`GUIDE_CHROME_KEYS` ships every group label to both catalogs):** confirmed
  intentional by the reviewer per §8 R-9 / Deviation #6. No change.

### Files changed by this round

- `src/screens/cmd/ResponsiveCmdShell.tsx` — `guideEntryHandler` + the close-on-Guide effect
- `src/components/cmd/GuideSheet.tsx` — role-gated seed; dropped the `findGuideTopic` import
- `src/screens/cmd/__tests__/ResponsiveCmdShell.spec158.test.tsx` — nav press targets added
  to the `Sidebar` / `RailSidebar` / `MobileNavDrawer` mocks (so a test can drive `section`),
  a second default sidebar group, and **7 new suppression pins**: `?` disappears on Guide at
  desktop / tablet / collapsed-tablet-rail / phone, returns on leaving Guide, the sheet
  cannot be opened there, an already-open sheet closes, and leaving Guide does not
  resurrect it
- `src/screens/cmd/sections/GuideSection.test.tsx` — `useBreakpoint` added to the
  breakpoints mock, plus 2 co-mount pins: with the guard honored every
  `cmd-guide-index-<id>` is unique; without it the two trees collide (documents the hazard)
- `src/components/cmd/GuideSheet.test.tsx` — 2 pins that the seed path is role-gated
  (`Users` for a plain admin vs. a master; `Brands` for a master vs. a super-admin)

### Gates after the fix

- Full `npx jest` — **210 suites / 2336 tests green** (+11).
- `npx tsc --noEmit` and `npm run typecheck:test` — both clean.
- Browser re-verification (local stack, Playwright-driven Chromium): **17 assertions, 0
  console errors, 0 failed / 4xx requests** — `?` present and still opening the sheet on a
  normal section at desktop / tablet / phone; **absent** on Guide at all three tiers with
  **zero** duplicate `cmd-guide-index-*` testIDs in the live DOM; returning after leaving
  Guide and opening on the new section; phone still at zero horizontal overflow; and, as
  master, the role-gated `Users` topic still seeds from the `?` (confirming the Low #1 fix
  is not over-tight).

---

## OQ-1 build (2026-08-10) — the "how a normal day flows" overview topic

Owner approved OQ-1 after the review round. The reserved `'overview'`
`GuideGroup` member and the `guide.groups.overview` strings shipped in the first
pass precisely so this would be **one registry entry per surface plus its catalog
strings** — which is exactly what it cost. No component, no test-infrastructure
and no navigation change was needed.

**Both surfaces get it.** The design's OQ-1 ruling is explicit — "push a
`GuideTopic` with `group: 'overview'` into `ADMIN_STANDALONE_TOPICS` *(and the
staff twin)*" — so this was not a judgement call. It also matches the PM's
framing: staff are precisely the day-one audience.

**Prominence.** `guideTopics('admin')` already returned
`[...ADMIN_STANDALONE_TOPICS, ...sectionTopics]`, so the overview reads first in
the admin index with no ordering change; the staff twin is first in
`STAFF_TOPICS`. Verified in the browser at desktop, phone and staff.

### One content deviation from the coordinator's brief — flagged deliberately

The brief's sketch included "deliveries arrive and are **received**/counted".
**There is no Receiving surface** — spec 138 retired it, this spec's own Findings
say so, and `## Out of scope` forbids documenting dormant surfaces. Per CLAUDE.md,
"stock moves at EOD/weekly counts, ordering is phone/text/cart-filler, so the
PO/receiving paperwork is gone." Writing "go to Receiving" would send a new
manager looking for a page that does not exist. Bullet 3 therefore reads:

> "When the delivery arrives it lands on the books at the next count — there is
> no separate receiving step."

That is both truthful about the product and useful (it pre-empts the exact
question a new manager asks). Every other beat of the brief — EOD count → reorder
list → review/send in Ordering → weekly count + Reconciliation → Dashboard and
Reports — is present as written.

Bullet count is **4**, honoring the `GuideTopic.actions` documented range of 1-4
(pinned by `guide.test.ts`); the six-beat narrative is carried across four bullets
plus the purpose paragraph, keeping the same voice and length discipline as the
other 22 topics.

### Files changed by this round

- `src/lib/guide.ts` — one entry in `ADMIN_STANDALONE_TOPICS`, one in
  `STAFF_TOPICS` (first), both `{ id: 'Overview', group: 'overview', actions: 4,
  gate: null }`; the `GuideGroup` and `ADMIN_STANDALONE_TOPICS` comments updated
  from "reserved / empty today" to built
- `src/i18n/{en,es,zh-CN}.json` — `guide.topics.overview.*` (6 keys × 3 locales),
  inserted first so the JSON reading order matches the render order
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — the staff twin, same shape
- `src/lib/guide.test.ts` — the exact id-array assertions updated (one line each,
  as designed); the section-order pin now compares the destination half against
  `ADMIN_SECTION_IDS`; role-gating counts 15→16 / 17→18 / 5→6; the
  "OQ-1 is NOT built" test **inverted** into "OQ-1 IS built and reads first on
  both surfaces"; new pin that `Overview` is not a sidebar destination
- `src/screens/cmd/__tests__/navGuideParity.test.tsx` — the reverse-direction
  orphan check now exempts standalone topics, keyed off `ADMIN_SECTION_IDS`
  rather than the group name so it stays exact if a future standalone topic uses
  a different group; new pin that every standalone topic is absent from the
  sidebar at every role
- `src/screens/cmd/sections/GuideSection.test.tsx` — preselection is now
  `Overview`; the Inventory copy test selects its row first; new pin for the
  OVERVIEW group caption + the 4th bullet
- `src/screens/staff/screens/Guide.test.tsx` — 5-topic index → 6, plus an
  `Overview` row pin

### Gates

- Full `npx jest` — **210 suites / 2340 tests green** (+4).
- `npx tsc --noEmit` and `npm run typecheck:test` — both clean.
- Browser: **12 assertions, 0 console errors, 0 failed / 4xx requests** — desktop
  (overview row present, preselected, FIRST index row, 4 bullets and no 5th,
  re-selectable after visiting another topic), phone 375 (row present with
  nothing preselected, drills in, zero horizontal overflow), staff 375 (row
  present, FIRST index row, opens, 4 bullets).
