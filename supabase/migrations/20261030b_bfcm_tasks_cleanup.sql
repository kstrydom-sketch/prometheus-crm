-- Run AFTER the code from 20261030_bfcm_tasks_calibration_contracts.sql is live.
-- The old code relied on the (plan_slug, kind) unique and on owner_id; the new code uses neither.
BEGIN;
-- Subtasks share a kind ('task'), so the default steps are unique per brand only at the top level.
ALTER TABLE public.bfcm_production_steps DROP CONSTRAINT IF EXISTS bfcm_production_steps_plan_slug_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS bfcm_production_steps_top_kind_uniq
  ON public.bfcm_production_steps(plan_slug, kind) WHERE parent_id IS NULL AND kind <> 'task';
-- One plan-linked subtask per category and phase under a step.
CREATE UNIQUE INDEX IF NOT EXISTS bfcm_production_steps_plan_key_uniq
  ON public.bfcm_production_steps(parent_id, plan_key) WHERE plan_key IS NOT NULL;
-- Assignees now live in bfcm_step_assignees (copied over by the previous migration).
ALTER TABLE public.bfcm_production_steps DROP COLUMN IF EXISTS owner_id;
COMMIT;
