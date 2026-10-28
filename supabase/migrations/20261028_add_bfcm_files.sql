-- BFCM-only private attachments. Apply only after review; no existing table/policy changes.
BEGIN;
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('bfcm-files','bfcm-files',false,262144000,ARRAY['application/octet-stream'])
ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='bfcm-files' AND public=false AND file_size_limit=262144000 AND allowed_mime_types=ARRAY['application/octet-stream']) THEN
    RAISE EXCEPTION 'BFCM private file bucket configuration mismatch';
  END IF;
END $$;
-- No storage.objects policies/grants are added. Only server-signed capabilities are used.
CREATE TABLE IF NOT EXISTS public.bfcm_plan_files (
  id uuid PRIMARY KEY,
  plan_slug text NOT NULL REFERENCES public.bfcm_plans(slug) ON DELETE RESTRICT,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 150),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 262144000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','removed','expired','purged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '130 minutes',
  attached_version integer,
  removed_version integer,
  CHECK (storage_path = plan_slug || '/' || id::text),
  CHECK (status NOT IN ('active','removed') OR attached_version IS NOT NULL),
  CHECK (status <> 'removed' OR removed_version > attached_version)
);
CREATE INDEX IF NOT EXISTS bfcm_files_plan_idx ON public.bfcm_plan_files(plan_slug,status);
ALTER TABLE public.bfcm_plan_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bfcm_plan_files FROM anon,authenticated;
GRANT SELECT ON public.bfcm_plan_files TO authenticated;
CREATE POLICY bfcm_files_staff_read ON public.bfcm_plan_files FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.can_edit));
GRANT ALL ON public.bfcm_plan_files TO service_role;

-- Serialize with existing plan saves/locks. A client token is checked again under the row lock.
-- Attachment intervals use the actual plan CAS version, so old locked versions remain reproducible.
CREATE OR REPLACE FUNCTION public.bfcm_file_change(
  p_slug text,p_expected_version integer,p_operation text,p_id uuid DEFAULT NULL,
  p_file_name text DEFAULT NULL,p_content_type text DEFAULT NULL,p_byte_size bigint DEFAULT NULL,
  p_access_token_hash text DEFAULT NULL,p_state jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE plan public.bfcm_plans; item public.bfcm_plan_files; object_size bigint; object_type text;
  next_version integer; object_count bigint; total_bytes bigint;
BEGIN
  SELECT * INTO plan FROM public.bfcm_plans WHERE slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BFCM_NOT_FOUND'; END IF;
  IF p_access_token_hash IS NOT NULL AND plan.access_token_hash IS DISTINCT FROM p_access_token_hash THEN RAISE EXCEPTION 'BFCM_UNAUTHORIZED'; END IF;
  IF plan.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'BFCM_CONFLICT'; END IF;
  IF coalesce(plan.state->>'status','draft')='locked' THEN RAISE EXCEPTION 'BFCM_LOCKED'; END IF;
  IF p_operation='reserve' THEN
    IF p_id IS NULL OR p_file_name IS NULL OR length(p_file_name) NOT BETWEEN 1 AND 180 OR p_file_name ~ '[[:cntrl:]/\\]' OR p_content_type IS NULL OR length(p_content_type) NOT BETWEEN 1 AND 150 OR p_content_type !~ '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$' OR p_byte_size IS NULL OR p_byte_size<=0 OR p_byte_size>262144000 THEN RAISE EXCEPTION 'BFCM_FILE_INVALID'; END IF;
    -- Signed upload tokens permit up to the bucket ceiling, regardless of declared size.
    -- Charge the full ceiling until validated finalization (or completed expiry cleanup).
    SELECT count(*),coalesce(sum(CASE WHEN status IN ('pending','expired') THEN 262144000 ELSE byte_size END),0) INTO object_count,total_bytes FROM public.bfcm_plan_files WHERE plan_slug=p_slug AND status<>'purged';
    IF object_count>=20 OR total_bytes+262144000>1073741824 THEN RAISE EXCEPTION 'BFCM_FILE_QUOTA'; END IF;
    INSERT INTO public.bfcm_plan_files(id,plan_slug,storage_path,file_name,content_type,byte_size)
      VALUES(p_id,p_slug,p_slug||'/'||p_id::text,p_file_name,p_content_type,p_byte_size);
    RETURN jsonb_build_object('version',plan.version);
  END IF;
  SELECT * INTO item FROM public.bfcm_plan_files WHERE id=p_id AND plan_slug=p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BFCM_FILE_NOT_FOUND'; END IF;
  IF p_operation='finalize' THEN
    IF item.status='active' THEN RETURN jsonb_build_object('version',plan.version); END IF;
    IF item.status<>'pending' OR item.expires_at<=now() THEN RAISE EXCEPTION 'BFCM_UPLOAD_EXPIRED'; END IF;
    SELECT (metadata->>'size')::bigint,metadata->>'mimetype' INTO object_size,object_type FROM storage.objects WHERE bucket_id='bfcm-files' AND name=item.storage_path;
    IF NOT FOUND OR object_size IS DISTINCT FROM item.byte_size OR object_type IS DISTINCT FROM 'application/octet-stream' THEN RAISE EXCEPTION 'BFCM_FILE_BYTES_MISMATCH'; END IF;
    next_version:=plan.version+1;
    UPDATE public.bfcm_plan_files SET status='active',attached_version=next_version WHERE id=item.id;
  ELSIF p_operation='remove' THEN
    IF item.status='removed' THEN RETURN jsonb_build_object('version',plan.version); END IF;
    IF item.status<>'active' THEN RAISE EXCEPTION 'BFCM_FILE_NOT_FOUND'; END IF;
    next_version:=plan.version+1;
    UPDATE public.bfcm_plan_files SET status='removed',removed_version=next_version WHERE id=item.id;
    -- Retain bytes for immutable prior locked versions. Removed files still consume quota.
  ELSIF p_operation='expire' THEN
    IF item.status NOT IN ('pending','expired') OR item.expires_at>now() THEN RAISE EXCEPTION 'BFCM_UPLOAD_NOT_EXPIRED'; END IF;
    UPDATE public.bfcm_plan_files SET status='expired' WHERE id=item.id;
    RETURN jsonb_build_object('version',plan.version);
  ELSIF p_operation='purge' THEN
    IF item.status<>'expired' OR EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='bfcm-files' AND name=item.storage_path) THEN RAISE EXCEPTION 'BFCM_FILE_NOT_PURGED'; END IF;
    UPDATE public.bfcm_plan_files SET status='purged' WHERE id=item.id;
    RETURN jsonb_build_object('version',plan.version);
  ELSE RAISE EXCEPTION 'BFCM_FILE_OPERATION_INVALID';
  END IF;
  IF p_state IS NULL OR p_state->>'brandSlug' IS DISTINCT FROM p_slug OR p_state->>'status' IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'BFCM_FILE_INVALID_STATE'; END IF;
  IF plan.state IS NOT NULL AND (p_state->>'revision')::integer IS DISTINCT FROM (plan.state->>'revision')::integer THEN RAISE EXCEPTION 'BFCM_CONFLICT'; END IF;
  UPDATE public.bfcm_plans SET state=jsonb_set(jsonb_set(p_state-'history','{fileIds}',
      (SELECT coalesce(jsonb_agg(id::text ORDER BY created_at,id),'[]'::jsonb) FROM public.bfcm_plan_files WHERE plan_slug=p_slug AND status='active')),
      '{revision}',to_jsonb(coalesce((p_state->>'revision')::integer,0)+1)),
    version=next_version,updated_at=now() WHERE slug=p_slug;
  RETURN jsonb_build_object('version',next_version);
END $$;
REVOKE ALL ON FUNCTION public.bfcm_file_change(text,integer,text,uuid,text,text,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bfcm_file_change(text,integer,text,uuid,text,text,bigint,text,jsonb) TO service_role;
COMMIT;
