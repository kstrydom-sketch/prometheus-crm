-- BFCM production: subtasks, assignees, comments, client calibration, and brand contracts.
-- Additive: the code already deployed keeps working with this applied.
-- The follow-up 20261030b_bfcm_tasks_cleanup.sql runs AFTER the new code is live.
--
-- Same boundary as bfcm_plans for every new table: staff with can_edit read,
-- all writes go through the server (service role) after canEdit().
BEGIN;

-- ── Steps: subtasks and the "waiting on client" status ─────────────────────
ALTER TABLE public.bfcm_production_steps
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.bfcm_production_steps(id) ON DELETE CASCADE,
  -- 'category:phase' (e.g. 'textOffer:pre') for subtasks made from the plan's split.
  -- The count is read from the plan at render time, never stored, so it can't drift.
  ADD COLUMN IF NOT EXISTS plan_key text CHECK (plan_key IS NULL OR plan_key ~ '^[a-zA-Z]+:(pre|bf)$');
ALTER TABLE public.bfcm_production_steps DROP CONSTRAINT IF EXISTS bfcm_production_steps_kind_check;
ALTER TABLE public.bfcm_production_steps ADD CONSTRAINT bfcm_production_steps_kind_check
  CHECK (kind IN ('review','samples','statics','motion','check','task'));
ALTER TABLE public.bfcm_production_steps DROP CONSTRAINT IF EXISTS bfcm_production_steps_status_check;
ALTER TABLE public.bfcm_production_steps ADD CONSTRAINT bfcm_production_steps_status_check
  CHECK (status IN ('todo','in_progress','waiting_client','done'));
CREATE INDEX IF NOT EXISTS bfcm_production_steps_parent_idx ON public.bfcm_production_steps(parent_id);

-- ── Assignees: any number of people per task ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.bfcm_step_assignees (
  step_id uuid NOT NULL REFERENCES public.bfcm_production_steps(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (step_id, profile_id)
);
CREATE INDEX IF NOT EXISTS bfcm_step_assignees_profile_idx ON public.bfcm_step_assignees(profile_id);
-- Carry over anyone set through the old single-owner field.
INSERT INTO public.bfcm_step_assignees (step_id, profile_id)
  SELECT id, owner_id FROM public.bfcm_production_steps WHERE owner_id IS NOT NULL
  ON CONFLICT DO NOTHING;

-- ── Internal comments: per task, or brand-wide when step_id is null ────────
CREATE TABLE IF NOT EXISTS public.bfcm_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_slug text NOT NULL REFERENCES public.bfcm_plans(slug) ON DELETE CASCADE,
  step_id uuid REFERENCES public.bfcm_production_steps(id) ON DELETE CASCADE,
  author_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Display name at the time of posting, so the comment survives the person leaving.
  author_name text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bfcm_comments_plan_idx ON public.bfcm_comments(plan_slug, created_at);

-- ── Client calibration: one round of samples per brand ────────────────────
-- The token is kept (not hashed) like projects.share_token, so the team can
-- copy the link again at any time; it opens only this brand's samples.
CREATE TABLE IF NOT EXISTS public.bfcm_calibrations (
  plan_slug text PRIMARY KEY REFERENCES public.bfcm_plans(slug) ON DELETE CASCADE,
  share_token text NOT NULL UNIQUE CHECK (share_token ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','submitted')),
  sent_at timestamptz,
  submitted_at timestamptz,
  submitted_by_name text CHECK (submitted_by_name IS NULL OR length(submitted_by_name) <= 120),
  client_note text CHECK (client_note IS NULL OR length(client_note) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.bfcm_calibration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_slug text NOT NULL REFERENCES public.bfcm_calibrations(plan_slug) ON DELETE CASCADE,
  -- Object key in the public project-images bucket, under bfcm-calibration/<slug>/.
  storage_path text NOT NULL UNIQUE CHECK (storage_path LIKE 'bfcm-calibration/%'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (media_type IN ('image','video')),
  sort_order integer NOT NULL DEFAULT 0,
  client_status text NOT NULL DEFAULT 'pending' CHECK (client_status IN ('pending','approved','needs_changes')),
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bfcm_calibration_items_plan_idx ON public.bfcm_calibration_items(plan_slug, sort_order);
CREATE TABLE IF NOT EXISTS public.bfcm_calibration_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.bfcm_calibration_items(id) ON DELETE CASCADE,
  author_name text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  pin_x real CHECK (pin_x IS NULL OR pin_x BETWEEN 0 AND 100),
  pin_y real CHECK (pin_y IS NULL OR pin_y BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bfcm_calibration_feedback_item_idx ON public.bfcm_calibration_feedback(item_id, created_at);

-- ── Contracts: per brand, the signed file is a brand document ──────────────
CREATE TABLE IF NOT EXISTS public.brand_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  -- SET NULL: deleting the file from the brand's documents keeps the summary.
  document_id uuid REFERENCES public.brand_documents(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  signed_on date,
  deliverables text NOT NULL DEFAULT '' CHECK (length(deliverables) <= 5000),
  revisions text NOT NULL DEFAULT '' CHECK (length(revisions) <= 2000),
  special_terms text NOT NULL DEFAULT '' CHECK (length(special_terms) <= 5000),
  -- The AI only fills the form; a row exists only once a person has saved it.
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_contracts_brand_idx ON public.brand_contracts(brand_id, created_at DESC);

-- ── Access: staff read, server-only writes ─────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bfcm_step_assignees','bfcm_comments','bfcm_calibrations','bfcm_calibration_items','bfcm_calibration_feedback','brand_contracts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.can_edit))', t || '_staff_read', t);
  END LOOP;
END $$;

COMMIT;
