# Spec 176 — main-Claude verification (AC-25)

Date: 2026-10-26. Local stack (`npm run dev:db`, already running), `expo-web` on :8081, signed in as admin@local.test. Working tree = spec 176 diff on top of 8acecc4.

## Store-switch race in the browser (L3)

Both stores have 143 items, but each store has its own `inventory_items` ids, so the id column shows which store's rows are on screen. The first row is `1c9b93` for Towson and `b199c6` for Charles.

Steps:
1. Charles was current. I wrapped `window.fetch` so that every request carrying Charles's store id (`1ea549bb-…`) was held for 20 s.
2. I ran a no-op `UPDATE public.inventory_items SET store_id = store_id` on one Charles row through `psql`. Realtime then called `handleSync`, which started `loadFromSupabase(Charles)` as a background reload with no switch overlay. The wrapper held its requests.
3. I switched to Towson in the TitleBar store switcher. Towson's load was not delayed, so it landed and the overlay cleared after about 1 s.
4. The stale Charles reload finished at t ≈ 40 s.

Result:
- After the Charles reload finished, the page still showed `2P://towson` and Towson's rows (`1c9b93`, `42bdc8`, `d9942b`, …, OUT 143). Nothing from Charles was written.
- No Charles `calculate_menu_capacity` or `items_last_counted` request was sent after the reload settled, so the spec 060/160 tails were skipped.
  - Compare an earlier un-raced Charles switch in the same session: there, both tail requests went out 0.1 s after the load finished.
- The "Switching stores…" overlay was not stranded and did not reappear.
- The console showed no errors.
- At the end I removed the fetch wrapper, so the original `window.fetch` was back in place.

Side observation: the spec 111 overlay covers the whole screen during a switch load, so a user cannot start a second switch from the UI while one is in flight. The UI path to L3 is therefore a background reload (realtime or a post-mutation reload) followed by a switch. That is the path tested above.

## Same-store realtime reload keeps the list (spec 175 regression)

- **Setup:** Towson was current, with Ordering open (desktop). A `MutationObserver` watched for the "fetching reorder suggestions" loading text.
- **Action:** I ran a no-op `UPDATE` on one Towson `inventory_items` row, which fired `handleSync` → `loadFromSupabase(Towson)`.
- **Result:**
  - One store reload ran, followed by exactly one background `report_reorder_list` refresh.
  - The loading text never appeared, and "NO ORDER SCHEDULE · 10" stayed on screen the whole time.

## Several switches in a row, desktop and 390 px

Each switch is started as soon as the previous overlay clears. The overlay covers the screen during a switch, so no switch can start faster than that.

- **Desktop, Ordering open:** Towson → Charles → Frederick → Reisters → Charles → Towson → Frederick.
  - The switcher showed the right store after every step.
  - The overlay appeared and then cleared each time, and never stuck.
  - At the end, Ordering was rendered and Inventory showed Frederick's own row (`#1 Togo Box` = `24774e`, which matches the DB).
- **390 × 844, phone Ordering open, switching from the drawer's store picker:** Frederick → Towson → Charles → Reisters → Towson → Charles.
  - The overlay appeared and then cleared, and never stuck.
  - The "Switched to Charles" toast showed.
  - Back at desktop width, with the same in-memory state, Inventory showed Charles's row (`b199c6`, which matches the DB).
- **Console:** no errors in either pass.

## Rows touched

The two no-op `UPDATE`s changed no column values. However, the `inventory_items_updated_at` trigger moved `updated_at` to the test time on two local rows:
- `033ffd80-…` (Charles)
- `0113ed2b-…` (Towson)

The previous timestamps were not recorded, so they could not be put back. This affects the local stack only. `npm run dev:db:reset` restores the seed if needed.

## L2 (late reorder result)

The local seed returns 0 reorder suggestions for both stores, and the same 10 brand-wide "no order schedule" warnings. A late Towson reorder payload would look identical to Charles's on screen, so there is no browser check for L2. It is covered by jest only: AC-1 to AC-9, D-T2, and the export refusal.

## Gates (from the developer and the test-engineer)

- Full `npx jest`: 266/266 suites, 3334/3334 tests.
- `npm run typecheck` and `npm run typecheck:test`: exit 0.
