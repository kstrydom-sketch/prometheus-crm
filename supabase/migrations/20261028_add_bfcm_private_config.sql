-- Only the new BFCM module table is changed. No seed/client data belongs in Git.
BEGIN;
ALTER TABLE public.bfcm_plans ADD COLUMN IF NOT EXISTS config jsonb;
ALTER TABLE public.bfcm_plans ADD CONSTRAINT bfcm_config_object
  CHECK (config IS NULL OR (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 262144));
COMMIT;
