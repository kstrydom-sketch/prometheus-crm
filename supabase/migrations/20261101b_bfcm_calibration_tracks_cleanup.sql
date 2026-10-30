-- Run AFTER the code from 20261101_bfcm_calibration_tracks.sql is live.
-- Round state now lives per track in bfcm_calibration_tracks.
BEGIN;
ALTER TABLE public.bfcm_calibrations
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS sent_at,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS submitted_by_name,
  DROP COLUMN IF EXISTS client_note;
COMMIT;
