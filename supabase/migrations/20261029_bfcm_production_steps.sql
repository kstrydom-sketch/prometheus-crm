-- BFCM production steps: who makes what by when, after the plan.
-- Additive only: one new table. No change to bfcm_plans or any existing table/policy.
BEGIN;
CREATE TABLE IF NOT EXISTS public.bfcm_production_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_slug text NOT NULL REFERENCES public.bfcm_plans(slug) ON DELETE CASCADE,
  sort_order integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review','samples','statics','motion','check')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  UNIQUE (plan_slug, kind)
);
CREATE INDEX IF NOT EXISTS bfcm_production_steps_plan_idx ON public.bfcm_production_steps(plan_slug, sort_order);
ALTER TABLE public.bfcm_production_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bfcm_production_steps FROM anon, authenticated;
GRANT SELECT ON public.bfcm_production_steps TO authenticated;
-- Same boundary as bfcm_plans: staff with can_edit read; writes are server-only.
CREATE POLICY bfcm_production_staff_read ON public.bfcm_production_steps FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit));
GRANT ALL ON public.bfcm_production_steps TO service_role;
COMMIT;
