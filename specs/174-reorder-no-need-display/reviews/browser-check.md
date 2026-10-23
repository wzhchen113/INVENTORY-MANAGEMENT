# Spec 174 — AC-23 browser check (main Claude, 2026-10-23)

Local stack (`expo-web` on :8081, local Supabase), signed in as the local test admin, store Towson.

Seed (local only, removed afterwards): a submitted SYSCO EOD for 2026-10-23 with French Fries counted 2 and American Cheese marked NO NEED. American Cheese's `current_stock` was set to 37 as the stale figure, and a Friday order schedule row was added for SYSCO.

## Results: PASS

- **Payload:** American Cheese `flags = ["no_usage_rate","no_need"]`, `onHand = 37`, `suggestedUnits = 0`.
- **Phone Ordering at 390x844 (AC-14/15/17):** with an edit in the buffer for the NO NEED line, `phone-order-noneed-347dd643…` renders "NO NEED" under the item name. It is a grey pill with a border, the name stays on one line, and the stepper and cost are unchanged. It is the only tagged line (count = 1). `scrollWidth` is 390, so there is no horizontal overflow.
- **Phone Export CSV (shared `handleCsvExport`):** the American Cheese row reads `SYSCO,no,American Cheese,NO NEED,0,8,12,3,4,cases,163.56,"no_usage_rate, no_need",…`. The French Fries row keeps its numeric `2`.
- **Admin jsPDF (`handlePdfExport`, the function the phone and desktop PDF buttons call), text extracted from the generated PDF:**
  - en: `American Cheese | NO NEED | 0 | 8 | 0 cs | cases | $0.00`
  - es: `American Cheese | NO HACE FALTA | …`
  - zh-CN: `American Cheese | NO NEED | …` (English, per AC-6)
  - The French Fries row reads `2` in all three.
- **Desktop row (unchanged, spec 172):** `on hand: NO NEED`.
- **Console:** no error-level messages (`read_console_messages` with `onlyErrors`, checked on the phone Ordering screen during the run).

## Notes

- The edit was set with `setReorderEditQty` from the browser console, which is the same store action the phone + stepper calls. In the app, an edited line rarely turns NO NEED without a remount, and remounting clears the edit buffer. See the next note.
- **Pre-existing, out of scope:** any full store reload, including the realtime echo after an export records its draft PO, sets `reorderPayload` to null (`useStore.ts` ~L2136). Phone Ordering then shows "No reorder suggestions" until you navigate away and back. Spec 174 does not touch this.
- The first phone PDF export may have saved a local-test-data PDF in the browser pane before the save path was stubbed. The CSV and the later PDFs were captured in-page and not downloaded.
