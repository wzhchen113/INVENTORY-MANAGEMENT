# Code review — Spec 065 (eod_submissions FK cascade fix)

Reviewer: code-reviewer
Date: 2026-05-27

> **Provenance note**: The code-reviewer subagent emitted findings inline in its handoff payload instead of writing to disk (same shape as the spec 055 incident). Main Claude recovered the content verbatim.

## Migration body vs. architect's design pseudo-SQL

The design shows:
```sql
alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
  foreign key (submitted_by)
  references public.profiles(id)
  on delete set null;
```

The migration delivers:
```sql
alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
    foreign key (submitted_by) references public.profiles(id) on delete set null;
```

Functional content is identical; the sub-clauses are collapsed onto one line with an extra indent on `foreign key`. Postgres parses both identically. Cosmetic difference.

## Header comment coverage

- Spec 065 reference: present (line 2)
- Trigger orthogonality note: present and detailed (lines 18–26)
- RLS non-impact note: present (lines 28–29)
- Realtime non-impact note: present (lines 29–31)
- Sibling table comparison note: present (lines 11–16)

## Migration structure

- `begin / commit`: present (lines 33, 42)
- `drop constraint if exists eod_submissions_submitted_by_fkey`: present (lines 35–36)
- `add constraint ... on delete set null`: present (lines 38–40)

## Scope creep check

- Only one migration file introduced
- No edge function files modified
- No application code (db.ts, store, hooks) modified
- No RLS policy changes
- No test file changes
- No other migration files modified

## Idiom checks

- Correct directory (`supabase/migrations/`)
- Timestamp `20260527000000` > `20260525000000` (head)
- Filename slug descriptive and matches the spec
- All SQL keywords lowercase, consistent with surrounding migrations

---

## Critical

None.

## Should-fix

None.

## Nits

- `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql:23-25` — The trigger-orthogonality note asserts FK cascade "does NOT invoke user-visible BEFORE UPDATE row triggers." This is correct, but the architect's design appendix (spec line 170) also included a belt-and-braces hedge: even if the trigger *were* invoked, `auth.uid()` under the postgres cascade role is NULL so the result would still be `submitted_by = NULL`. Omitting the hedge leaves the comment slightly less defensively documented than the design intended. Consider adding one sentence: `"Even if it did fire, auth.uid() under the postgres cascade role is NULL, so submitted_by would remain NULL regardless."` Not a functional issue.

- `supabase/migrations/20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql:38-40` — The `add constraint` sub-clauses (`foreign key`, `references`, `on delete set null`) are collapsed onto a single line, whereas the architect's design pseudo-SQL showed them on separate lines, consistent with the four-clause column definition style used in surrounding migrations (`20260513000000_inventory_counts.sql:72,76`). Purely cosmetic — Postgres parses both identically — but the multi-line form makes each clause easier to scan in `git diff`. Low-priority.

## Handoff
next_agent: NONE
