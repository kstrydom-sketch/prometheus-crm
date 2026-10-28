-- BFCM-only additive migration. Reviewed separately before application.
-- No updates to brands/projects/profiles, no existing policies/triggers changed.
BEGIN;
CREATE TABLE IF NOT EXISTS public.bfcm_plans (
  slug text PRIMARY KEY,
  brand_id uuid UNIQUE REFERENCES public.brands(id) ON DELETE SET NULL,
  snapshot_key text NOT NULL UNIQUE,
  access_token_hash text UNIQUE CHECK (access_token_hash IS NULL OR access_token_hash ~ '^[a-f0-9]{64}$'),
  state jsonb,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  generation_requested_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state IS NULL OR (jsonb_typeof(state) = 'object' AND state->>'brandSlug' = slug)),
  CHECK (state IS NULL OR pg_column_size(state) <= 262144)
);
CREATE TABLE IF NOT EXISTS public.bfcm_plan_versions (
  plan_slug text NOT NULL REFERENCES public.bfcm_plans(slug) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_slug, version)
);
ALTER TABLE public.bfcm_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bfcm_plan_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bfcm_plans, public.bfcm_plan_versions FROM anon, authenticated;
GRANT SELECT ON public.bfcm_plans TO authenticated;
GRANT SELECT ON public.bfcm_plan_versions TO authenticated;
-- Exactly the existing app's profiles.can_edit boundary, not any signed-in user.
CREATE POLICY bfcm_staff_read ON public.bfcm_plans FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit));
CREATE POLICY bfcm_versions_read ON public.bfcm_plan_versions FOR SELECT TO authenticated
 USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit));
-- Writes are server-only through existing service credentials, after app authorization.
-- No authenticated INSERT/UPDATE/DELETE policies on either table.

-- Transactional compare-and-swap, SECURITY INVOKER: RLS remains in force.
CREATE OR REPLACE FUNCTION public.bfcm_save_plan(p_slug text, p_state jsonb, p_expected_version integer)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE current_row public.bfcm_plans; next_version integer;
BEGIN
  SELECT * INTO current_row FROM public.bfcm_plans WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BFCM plan unavailable'; END IF;
  IF current_row.version <> p_expected_version THEN RAISE EXCEPTION 'BFCM_CONFLICT'; END IF;
  IF p_state->>'brandSlug' IS DISTINCT FROM p_slug THEN RAISE EXCEPTION 'BFCM brand mismatch'; END IF;
  IF current_row.state->>'status' = 'locked' AND p_state->>'status' = 'locked' THEN
    RAISE EXCEPTION 'BFCM locked plan must be explicitly reopened';
  END IF;
  IF p_state->>'status' = 'locked' AND (p_state->>'approvedCopiesRevision' IS NULL OR p_state->>'approvedCopiesRevision' IS DISTINCT FROM p_state->>'copyRevision') THEN
    RAISE EXCEPTION 'BFCM explicit copy approval required';
  END IF;
  next_version := current_row.version + 1;
  UPDATE public.bfcm_plans SET state = p_state - 'history', version = next_version, updated_at = now() WHERE slug = p_slug;
  IF p_state->>'status' = 'locked' AND coalesce(current_row.state->>'status', 'draft') <> 'locked' THEN
    INSERT INTO public.bfcm_plan_versions(plan_slug, version, snapshot)
      VALUES (p_slug, next_version, p_state - 'history');
  END IF;
  RETURN next_version;
END $$;
REVOKE ALL ON FUNCTION public.bfcm_save_plan(text,jsonb,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bfcm_save_plan(text,jsonb,integer) TO service_role;
GRANT ALL ON public.bfcm_plans, public.bfcm_plan_versions TO service_role;

-- Atomic per-plan cooldown: capability holders cannot spam billable generation.
CREATE OR REPLACE FUNCTION public.bfcm_claim_generation(p_slug text, p_expected_version integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.bfcm_plans SET generation_requested_at = now()
  WHERE slug = p_slug AND version = p_expected_version
    AND coalesce(state->>'status', 'draft') <> 'locked'
    AND (generation_requested_at IS NULL OR generation_requested_at < now() - interval '60 seconds');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.bfcm_claim_generation(text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bfcm_claim_generation(text,integer) TO service_role;

COMMIT;
