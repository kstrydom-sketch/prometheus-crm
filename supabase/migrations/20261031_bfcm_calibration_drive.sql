-- BFCM calibration samples can come from a Drive folder, like Moments creatives.
-- Additive: the deployed code ignores these columns.
BEGIN;
-- The folder the team pasted on the samples task.
ALTER TABLE public.bfcm_calibrations
  ADD COLUMN IF NOT EXISTS drive_folder_url text CHECK (drive_folder_url IS NULL OR length(drive_folder_url) <= 500);
-- Which Drive file a sample was copied from, and the version copied (Drive modifiedTime),
-- so a re-sync adds new files and refreshes edited ones instead of duplicating them.
ALTER TABLE public.bfcm_calibration_items
  ADD COLUMN IF NOT EXISTS drive_file_id text CHECK (drive_file_id IS NULL OR drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  ADD COLUMN IF NOT EXISTS drive_modified_at text CHECK (drive_modified_at IS NULL OR length(drive_modified_at) <= 40);
CREATE UNIQUE INDEX IF NOT EXISTS bfcm_calibration_items_drive_uniq
  ON public.bfcm_calibration_items(plan_slug, drive_file_id) WHERE drive_file_id IS NOT NULL;
COMMIT;
