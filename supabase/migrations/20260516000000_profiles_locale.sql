-- supabase/migrations/20260516000000_profiles_locale.sql
--
-- Spec 038 §1: per-user preferred chrome language for the admin app.
--
-- Adds a text column to profiles with a CHECK constraint pinning the
-- value to the three locales in scope for P1: 'en' (default), 'es',
-- 'zh-CN'. Mirrors the profiles.dark_mode / profiles.sidebar_layout
-- precedent — per-user preference, gated by the existing "Users can
-- update own profile" / "Users can read own profile" row policies
-- (both keyed on id = auth.uid()). No new policy is needed; the
-- column inherits the row-level grants for free.
--
-- Posture: additive only. Metadata-only ALTER in PG 17 (the default
-- 'en' constant is stored once, no row rewrite). Idempotent via
-- `add column if not exists` + `drop constraint if exists` and
-- recreate — same idiom used elsewhere in this codebase (see
-- 20260509000000_multi_brand_schema_rls.sql §6l for the super_admin_*
-- profile policies).
--
-- Backfill semantics: `not null default 'en'` on `add column` backfills
-- existing rows atomically in the same statement; no separate UPDATE
-- needed.
--
-- Realtime: this migration deliberately does NOT add `profiles` to the
-- `supabase_realtime` publication (see spec 038 §0.1 / §7). The single
-- writer per row is the user themselves, so cross-tab and cross-device
-- propagation via next session restore is acceptable. No
-- `docker restart supabase_realtime_imr-inventory` step needed on apply.
--
-- See specs/038-multi-language-support-p1-chrome.md §1.

begin;

alter table public.profiles
  add column if not exists locale text not null default 'en';

-- Drop-and-recreate is the idempotency idiom this codebase uses for
-- CHECK constraints. A future migration that expands the enum (e.g. adds
-- a fourth locale) can follow the same drop-and-recreate pattern.
alter table public.profiles
  drop constraint if exists profiles_locale_check;

alter table public.profiles
  add constraint profiles_locale_check
  check (locale in ('en', 'es', 'zh-CN'));

comment on column public.profiles.locale is
  'Spec 038: per-user preferred chrome language. One of en|es|zh-CN. Default en. Independent of per-store RLS — gated by the existing self-read/self-update profile policies.';

commit;
