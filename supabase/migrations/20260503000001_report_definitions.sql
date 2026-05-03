-- report_definitions: persists saved reports created from the
-- + NEW REPORT modal in the cmd theme. Templates (variance, waste, cogs,
-- vendor, velocity, custom) are hardcoded in client code; this table
-- stores the *instance* with a user-given name + scope + free-form params.

CREATE TABLE IF NOT EXISTS public.report_definitions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID REFERENCES public.stores(id) ON DELETE CASCADE,
  template_id  TEXT NOT NULL,    -- 'variance' | 'waste' | 'cogs' | 'vendor' | 'velocity' | 'custom'
  name         TEXT NOT NULL,
  scope        TEXT,             -- 'this_store' | 'all_stores'
  params       JSONB DEFAULT '{}'::jsonb,
  created_by   UUID REFERENCES public.profiles(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_definitions_store_idx ON public.report_definitions(store_id);
CREATE INDEX IF NOT EXISTS report_definitions_template_idx ON public.report_definitions(template_id);

ALTER TABLE public.report_definitions ENABLE ROW LEVEL SECURITY;

-- Permissive policy mirroring the local seed convention (per Phase 12 plan
-- + local-stack gotcha #1 — real prod RLS gets defined in a separate
-- migration when Reports lands in prod).
DROP POLICY IF EXISTS "authenticated can do anything" ON public.report_definitions;
CREATE POLICY "authenticated can do anything"
  ON public.report_definitions
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);
