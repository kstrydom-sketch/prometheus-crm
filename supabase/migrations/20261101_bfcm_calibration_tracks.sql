-- BFCM calibration gets two tracks, like Landing Page and Creatives on a Moments project:
-- Statics and Motion each have their own people, publish and client approval.
-- Additive: the deployed code keeps working. 20261101b_bfcm_calibration_tracks_cleanup.sql
-- runs after the new code is live.
BEGIN;

CREATE TABLE IF NOT EXISTS public.bfcm_calibration_tracks (
  plan_slug text NOT NULL REFERENCES public.bfcm_calibrations(plan_slug) ON DELETE CASCADE,
  track text NOT NULL CHECK (track IN ('statics','motion')),
  -- draft = internal only; sent = live on the client link; submitted = client finished.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','submitted')),
  sent_at timestamptz,
  submitted_at timestamptz,
  submitted_by_name text CHECK (submitted_by_name IS NULL OR length(submitted_by_name) <= 120),
  client_note text CHECK (client_note IS NULL OR length(client_note) <= 5000),
  PRIMARY KEY (plan_slug, track)
);
ALTER TABLE public.bfcm_calibration_tracks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bfcm_calibration_tracks FROM anon, authenticated;
GRANT SELECT ON public.bfcm_calibration_tracks TO authenticated;
GRANT ALL ON public.bfcm_calibration_tracks TO service_role;
DROP POLICY IF EXISTS bfcm_calibration_tracks_staff_read ON public.bfcm_calibration_tracks;
CREATE POLICY bfcm_calibration_tracks_staff_read ON public.bfcm_calibration_tracks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit));
-- Existing rounds carry their state into both tracks.
INSERT INTO public.bfcm_calibration_tracks (plan_slug, track, status, sent_at, submitted_at, submitted_by_name, client_note)
  SELECT c.plan_slug, t.track, c.status, c.sent_at, c.submitted_at, c.submitted_by_name, c.client_note
  FROM public.bfcm_calibrations c CROSS JOIN (VALUES ('statics'), ('motion')) AS t(track)
  ON CONFLICT DO NOTHING;

ALTER TABLE public.bfcm_calibration_items
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'statics' CHECK (track IN ('statics','motion'));
UPDATE public.bfcm_calibration_items SET track = 'motion' WHERE media_type = 'video';

-- Each track is a subtask of the samples task, so it has its own people, status and due date.
ALTER TABLE public.bfcm_production_steps DROP CONSTRAINT IF EXISTS bfcm_production_steps_kind_check;
ALTER TABLE public.bfcm_production_steps ADD CONSTRAINT bfcm_production_steps_kind_check
  CHECK (kind IN ('review','samples','statics','motion','check','task','calibration_statics','calibration_motion'));
CREATE UNIQUE INDEX IF NOT EXISTS bfcm_production_steps_calibration_uniq
  ON public.bfcm_production_steps(parent_id, kind) WHERE kind IN ('calibration_statics','calibration_motion');
INSERT INTO public.bfcm_production_steps (plan_slug, parent_id, sort_order, kind, title, status, due_date)
  SELECT s.plan_slug, s.id, t.sort_order, t.kind, t.title, s.status, s.due_date
  FROM public.bfcm_production_steps s
  CROSS JOIN (VALUES (1, 'calibration_statics', 'Statics samples'), (2, 'calibration_motion', 'Motion samples')) AS t(sort_order, kind, title)
  WHERE s.kind = 'samples' AND s.parent_id IS NULL
  ON CONFLICT DO NOTHING;
-- People already on the samples task stay on both tracks until someone narrows it down.
INSERT INTO public.bfcm_step_assignees (step_id, profile_id)
  SELECT c.id, a.profile_id FROM public.bfcm_production_steps c
  JOIN public.bfcm_step_assignees a ON a.step_id = c.parent_id
  WHERE c.kind IN ('calibration_statics','calibration_motion')
  ON CONFLICT DO NOTHING;

COMMIT;
