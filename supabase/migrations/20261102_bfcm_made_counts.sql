-- BFCM production: how many creatives are made so far on a plan-linked subtask,
-- and a log of every change so the list page can show real daily pace.
-- Additive: the code already deployed keeps working with this applied.
-- Apply BEFORE the code that reads made_count goes live.
BEGIN;
ALTER TABLE public.bfcm_production_steps
  ADD COLUMN IF NOT EXISTS made_count integer NOT NULL DEFAULT 0 CHECK (made_count BETWEEN 0 AND 100000);

CREATE TABLE IF NOT EXISTS public.bfcm_made_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_slug text NOT NULL REFERENCES public.bfcm_plans(slug) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES public.bfcm_production_steps(id) ON DELETE CASCADE,
  -- Negative when someone corrects a count down, so totals stay true.
  delta integer NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bfcm_made_log_created_idx ON public.bfcm_made_log(created_at);

-- Same boundary as the other BFCM tables: staff read, server-only writes.
ALTER TABLE public.bfcm_made_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bfcm_made_log FROM anon, authenticated;
GRANT SELECT ON public.bfcm_made_log TO authenticated;
GRANT ALL ON public.bfcm_made_log TO service_role;
DROP POLICY IF EXISTS bfcm_made_log_staff_read ON public.bfcm_made_log;
CREATE POLICY bfcm_made_log_staff_read ON public.bfcm_made_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit));
COMMIT;
