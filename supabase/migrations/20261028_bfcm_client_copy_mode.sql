-- Preserve BFCM concurrency/history; explicit client-copy mode replaces CRM-copy approval only.
BEGIN;
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
  IF p_state->>'status' = 'locked' AND p_state->'useClientCopy' IS DISTINCT FROM 'true'::jsonb AND (p_state->>'approvedCopiesRevision' IS NULL OR p_state->>'approvedCopiesRevision' IS DISTINCT FROM p_state->>'copyRevision') THEN
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
COMMIT;
