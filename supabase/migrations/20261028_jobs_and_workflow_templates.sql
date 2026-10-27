-- Jobs & workflow templates: moments become one kind of job.
--
-- A workflow template is a named list of steps (title, day offset, optional
-- group, stage) plus its ordered stages. Management edits templates in the app.
-- A job is created from a template and COPIES its steps and stages, so changing
-- a template only affects jobs created afterwards. A one-off task is a job with
-- no template and a single step.
--
-- Renames the prototype-only moments tables (added 20261026, never in live):
--   moments → jobs, moment_steps → job_steps, moment_followers → job_followers,
--   moment_id → job_id everywhere, moments.launch_date → jobs.due_date,
--   job status 'launched' → 'done'.
--
-- Safe to re-run.

BEGIN;

-- ── Renames ─────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.moments') IS NOT NULL THEN ALTER TABLE public.moments RENAME TO jobs; END IF;
  IF to_regclass('public.moment_steps') IS NOT NULL THEN ALTER TABLE public.moment_steps RENAME TO job_steps; END IF;
  IF to_regclass('public.moment_followers') IS NOT NULL THEN ALTER TABLE public.moment_followers RENAME TO job_followers; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_steps' AND column_name = 'moment_id') THEN
    ALTER TABLE public.job_steps RENAME COLUMN moment_id TO job_id; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'step_comments' AND column_name = 'moment_id') THEN
    ALTER TABLE public.step_comments RENAME COLUMN moment_id TO job_id; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_followers' AND column_name = 'moment_id') THEN
    ALTER TABLE public.job_followers RENAME COLUMN moment_id TO job_id; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inbox_items' AND column_name = 'moment_id') THEN
    ALTER TABLE public.inbox_items RENAME COLUMN moment_id TO job_id; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'activity_log' AND column_name = 'moment_id') THEN
    ALTER TABLE public.activity_log RENAME COLUMN moment_id TO job_id; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'launch_date') THEN
    ALTER TABLE public.jobs RENAME COLUMN launch_date TO due_date; END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'jobs' AND policyname = 'moments_staff') THEN
    ALTER POLICY moments_staff ON public.jobs RENAME TO jobs_staff; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'job_steps' AND policyname = 'moment_steps_staff') THEN
    ALTER POLICY moment_steps_staff ON public.job_steps RENAME TO job_steps_staff; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'job_followers' AND policyname = 'moment_followers_staff') THEN
    ALTER POLICY moment_followers_staff ON public.job_followers RENAME TO job_followers_staff; END IF;
END $$;

ALTER INDEX IF EXISTS idx_moments_brand RENAME TO idx_jobs_brand;
ALTER INDEX IF EXISTS idx_moments_status RENAME TO idx_jobs_status;
ALTER INDEX IF EXISTS idx_moment_steps_moment RENAME TO idx_job_steps_job;
ALTER INDEX IF EXISTS idx_moment_steps_assignee RENAME TO idx_job_steps_assignee;
ALTER INDEX IF EXISTS idx_step_comments_moment RENAME TO idx_step_comments_job;
ALTER INDEX IF EXISTS idx_activity_moment RENAME TO idx_activity_job;

-- The old log triggers write moment_id; drop them before any row changes below.
-- New ones are created at the end.
DROP TRIGGER IF EXISTS moments_activity ON public.jobs;
DROP TRIGGER IF EXISTS moment_steps_activity ON public.job_steps;
DROP TRIGGER IF EXISTS step_comments_activity ON public.step_comments;
DROP TRIGGER IF EXISTS moments_touch ON public.jobs;
DROP TRIGGER IF EXISTS moment_steps_touch ON public.job_steps;
DROP TRIGGER IF EXISTS jobs_activity ON public.jobs;
DROP TRIGGER IF EXISTS job_steps_activity ON public.job_steps;
DROP TRIGGER IF EXISTS jobs_touch ON public.jobs;
DROP TRIGGER IF EXISTS job_steps_touch ON public.job_steps;
DROP FUNCTION IF EXISTS public.log_moment_activity();
DROP FUNCTION IF EXISTS public.touch_moment_step();

-- ── Workflow templates ──────────────────────────────────────────────────────
-- stages: [{ "key": "offer", "label": "Offer" }, ...] in order.
-- steps:  [{ "key": "offer_draft", "title": "Write the offer", "day": 1,
--            "group": "Landing page" | null, "stage": "offer" | null }, ...]
CREATE TABLE IF NOT EXISTS public.workflow_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  description      TEXT,
  -- Moment-type work: the job is for a month and an M1/M2 slot.
  uses_month_slot  BOOLEAN NOT NULL DEFAULT false,
  -- What a job of this kind is called once every step is closed.
  done_label       TEXT NOT NULL DEFAULT 'Done',
  -- What the job's end date is called ('Launch', 'Due', 'Kickoff').
  due_label        TEXT NOT NULL DEFAULT 'Due',
  stages           JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(stages) = 'array'),
  steps            JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.workflow_templates ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_templates' AND policyname = 'workflow_templates_staff') THEN
    CREATE POLICY workflow_templates_staff ON public.workflow_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

INSERT INTO public.workflow_templates (name, description, uses_month_slot, done_label, due_label, sort_order, stages, steps)
VALUES (
  'Moments',
  'One client moment, from offer to launch.',
  true, 'Launched', 'Launch', 0,
  '[{"key":"offer","label":"Offer"},{"key":"offer_approval","label":"Offer approval"},{"key":"brief","label":"Brief"},
    {"key":"production","label":"In production"},{"key":"client_review","label":"Client review"},
    {"key":"client_edits","label":"Client edits"},{"key":"launch","label":"Ready to launch"}]',
  '[{"key":"offer_draft","title":"Write the offer","day":1,"group":null,"stage":"offer"},
    {"key":"offer_internal_review","title":"Offer internal review","day":1,"group":null,"stage":"offer"},
    {"key":"offer_client_approval","title":"Client approves the offer","day":4,"group":null,"stage":"offer_approval"},
    {"key":"brief","title":"Compile the brief","day":4,"group":null,"stage":"brief"},
    {"key":"lp_build","title":"Build the landing page","day":7,"group":"Landing page","stage":"production"},
    {"key":"lp_internal_review","title":"Internal review","day":8,"group":"Landing page","stage":"production"},
    {"key":"lp_client_review","title":"Client review","day":10,"group":"Landing page","stage":"client_review"},
    {"key":"lp_client_edits","title":"Apply client edits","day":13,"group":"Landing page","stage":"client_edits"},
    {"key":"cr_drafts","title":"First drafts","day":7,"group":"Creatives","stage":"production"},
    {"key":"cr_internal_review","title":"Internal review","day":8,"group":"Creatives","stage":"production"},
    {"key":"cr_client_review","title":"Client review","day":10,"group":"Creatives","stage":"client_review"},
    {"key":"cr_client_edits","title":"Apply client edits","day":13,"group":"Creatives","stage":"client_edits"},
    {"key":"launch","title":"Launch","day":15,"group":null,"stage":"launch"}]'
)
ON CONFLICT (name) DO NOTHING;

-- ── Jobs ────────────────────────────────────────────────────────────────────
-- kind: 'workflow' (made from a template) or 'task' (one-off, single step).
-- stages / done_label / due_label are copied from the template at creation.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'workflow';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES public.workflow_templates(id) ON DELETE SET NULL;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS stages JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS done_label TEXT NOT NULL DEFAULT 'Done';
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS due_label TEXT NOT NULL DEFAULT 'Due';
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('workflow', 'task'));

-- Month and slot only apply to moment-type work; internal work has no client.
ALTER TABLE public.jobs ALTER COLUMN target_month DROP NOT NULL;
ALTER TABLE public.jobs ALTER COLUMN slot DROP NOT NULL;
ALTER TABLE public.jobs ALTER COLUMN slot DROP DEFAULT;
ALTER TABLE public.jobs ALTER COLUMN brand_id DROP NOT NULL;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS moments_status_check;
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
UPDATE public.jobs SET status = 'done' WHERE status = 'launched';
ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('active', 'done', 'on_hold', 'cancelled'));
CREATE INDEX IF NOT EXISTS idx_jobs_template ON public.jobs (template_id, status);

-- ── Steps ───────────────────────────────────────────────────────────────────
-- stage: which of the job's stages the step counts towards (NULL = none, e.g.
-- steps added by hand). day_offset: working days from the job's start, used
-- when the job is re-planned (NULL = not re-planned).
ALTER TABLE public.job_steps ADD COLUMN IF NOT EXISTS stage TEXT;
ALTER TABLE public.job_steps ADD COLUMN IF NOT EXISTS day_offset INTEGER;

-- Existing moments: attach to the Moments template and copy its stages, and
-- give their steps the stage and day they had in the hard-coded template.
WITH t AS (SELECT * FROM public.workflow_templates WHERE name = 'Moments')
UPDATE public.jobs j SET template_id = t.id, stages = t.stages, done_label = t.done_label, due_label = t.due_label
FROM t WHERE j.template_id IS NULL AND j.kind = 'workflow';

WITH s AS (
  SELECT x->>'key' AS key, x->>'stage' AS stage, (x->>'day')::int AS day
  FROM public.workflow_templates, jsonb_array_elements(steps) x WHERE name = 'Moments'
)
UPDATE public.job_steps js SET stage = s.stage, day_offset = s.day
FROM s WHERE js.key = s.key AND js.stage IS NULL AND NOT js.is_group;

-- ── Activity log: 'moment' → 'job' ──────────────────────────────────────────
ALTER TABLE public.activity_log DISABLE TRIGGER activity_log_no_mutation;
UPDATE public.activity_log SET entity = 'job' WHERE entity = 'moment';
UPDATE public.activity_log SET field = 'due_date' WHERE field = 'launch_date';
ALTER TABLE public.activity_log ENABLE TRIGGER activity_log_no_mutation;

CREATE OR REPLACE FUNCTION public.log_job_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  entity  TEXT := CASE TG_TABLE_NAME WHEN 'jobs' THEN 'job' WHEN 'job_steps' THEN 'step' ELSE 'comment' END;
  rec     JSONB;
  old_rec JSONB;
  j_id    UUID;
  s_id    UUID;
  k       TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  j_id := CASE WHEN entity = 'job' THEN (rec->>'id')::uuid ELSE (rec->>'job_id')::uuid END;
  s_id := CASE WHEN entity = 'step' THEN (rec->>'id')::uuid WHEN entity = 'comment' THEN (rec->>'step_id')::uuid ELSE NULL END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO activity_log (job_id, step_id, entity, action, new_value, actor_id)
    VALUES (j_id, s_id, entity, CASE WHEN entity = 'comment' THEN 'commented' ELSE 'created' END,
            CASE WHEN entity = 'comment' THEN rec->>'body' ELSE rec->>CASE WHEN entity = 'job' THEN 'name' ELSE 'title' END END,
            auth.uid());
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO activity_log (job_id, step_id, entity, action, old_value, actor_id)
    VALUES (j_id, s_id, entity, 'deleted', rec->>CASE WHEN entity = 'job' THEN 'name' WHEN entity = 'step' THEN 'title' ELSE 'body' END, auth.uid());
  ELSE
    old_rec := to_jsonb(OLD);
    FOR k IN SELECT jsonb_object_keys(rec) LOOP
      CONTINUE WHEN k IN ('updated_at', 'edited_at', 'started_at', 'completed_at', 'stages');
      IF (old_rec->k) IS DISTINCT FROM (rec->k) THEN
        INSERT INTO activity_log (job_id, step_id, entity, action, field, old_value, new_value, actor_id)
        VALUES (j_id, s_id, entity, 'updated', k, old_rec->>k, rec->>k, auth.uid());
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.touch_job_step()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_TABLE_NAME = 'job_steps' THEN
    IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN NEW.started_at := now(); END IF;
    IF NEW.status IN ('done', 'skipped') AND (OLD.status IS DISTINCT FROM NEW.status) THEN NEW.completed_at := now(); END IF;
    IF NEW.status NOT IN ('done', 'skipped') THEN NEW.completed_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;


CREATE TRIGGER jobs_activity AFTER INSERT OR UPDATE OR DELETE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.log_job_activity();
CREATE TRIGGER job_steps_activity AFTER INSERT OR UPDATE OR DELETE ON public.job_steps
  FOR EACH ROW EXECUTE FUNCTION public.log_job_activity();
CREATE TRIGGER step_comments_activity AFTER INSERT OR DELETE ON public.step_comments
  FOR EACH ROW EXECUTE FUNCTION public.log_job_activity();
CREATE TRIGGER jobs_touch BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_job_step();
CREATE TRIGGER job_steps_touch BEFORE UPDATE ON public.job_steps
  FOR EACH ROW EXECUTE FUNCTION public.touch_job_step();

DROP TRIGGER IF EXISTS workflow_templates_touch ON public.workflow_templates;
CREATE TRIGGER workflow_templates_touch BEFORE UPDATE ON public.workflow_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_job_step();

COMMIT;
