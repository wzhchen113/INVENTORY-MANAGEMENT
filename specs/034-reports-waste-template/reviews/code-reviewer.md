## Code review for spec 034

### Critical

None.

### Should-fix

- `src/components/cmd/NewReportModal.tsx:112` — `by` state initializes unconditionally to `'category'`, not to `defaultByForTemplate(initialPicked)`. The component unmounts when the modal closes (`if (!visible) return null` at line 298) and remounts on the next open. On remount for a `waste` pre-seed, the first render shows `category` selected; the `useEffect([visible, initialTemplateId, initialName])` fires after paint and corrects it to `reason` — a one-frame chip-highlight flash before the right default lands. Fix: change line 112 to `React.useState<'reason' | 'category' | 'item'>(defaultByForTemplate(initialPicked))`. The function is already defined above the hook at line 77-81 so there is no ordering issue.

- `supabase/tests/report_run_waste.test.sql` — Spec AC item 4 requires: "row count = 1, `rows[0].reason = 'Spoilage'`" for a single-item fixture run. The test instead inserts three rows on the same date (A=Spoilage $10, B=Quality issue $0, C=Theft $20) and never asserts `rows[0].reason`. Because Theft sorts first by dollar-desc, `rows[0].reason` would be `'Theft'`, not `'Spoilage'`. The formula and ordering are each tested (tests 6+7 filter by reason; test 9 checks the full order), but the literal AC assertion "`rows[0].reason = 'Spoilage'`" is absent. The test description comment (line 125-133) explains the three-row choice but does not note the AC delta. Either add the missing assertion or document the intentional deviation from the AC in the test file's top comment block.

### Nits

- `supabase/migrations/20260514170000_report_run_waste.sql:96-98` — The param-coercion comment says the default matches "spec AC line 35-37 / COGS precedent at line 111-118." The spec AC says `current_date` while the implementation (correctly, per COGS) uses `(now() at time zone 'utc')::date`. These two citations do not agree. Consider dropping the spec-AC reference and keeping only the COGS citation, which is the actual behavioral contract: `-- Default window: last 30 days inclusive, matching COGS precedent at line 111-118.`

- `src/components/cmd/NewReportModal.tsx:71-75` — `BY_OPTIONS` is typed `Record<string, ReadonlyArray<ByOption>>`. The loose `string` key is intentional for forward-compat (new template IDs won't require touching this map), but it means a typo in a future key goes undetected at compile time. A narrower `Partial<Record<ReportDefinition['templateId'], ReadonlyArray<ByOption>>>` would catch that class of error and still allow optional keys. The `?? DEFAULT_BY_OPTIONS` fallback already handles the undefined case correctly if a key is missing.
