-- Review rounds: the offer, landing page and creatives each move through
--
--   building → internal review ⇄ internal revisions requested
--            → client review   ⇄ client revisions requested → approved
--
-- and every trip around a loop is one numbered round (who sent it, who decided,
-- what they decided, their note). Client edits go straight back to the client.
--
-- The offer card and production card stay where the work and the gates live
-- (checklist, discount, approvals, client links). Their job's steps now follow
-- them: a database trigger turns every card move, from any screen, script or
-- client link, into rounds and step statuses. People set owners and dates on
-- those steps, never their status.
--
-- Linked step keys (any workflow template can use them):
--   offer     offer_draft · offer_internal_review · offer_client_approval · offer_revisions
--   lp        lp_build · lp_internal_review · lp_discount · lp_client_review · lp_revisions
--   creative  cr_drafts · cr_internal_review · cr_client_review · cr_revisions
--   brief, launch
--
-- Also: offers point at their job (offer_cards.job_id, several allowed; the
-- job's offer_card_id is the one that drives the steps), and the old
-- pipeline_events history is replayed into rounds once.
--
-- Safe to re-run.

BEGIN;

-- ── Step status: changes requested ──────────────────────────────────────────
ALTER TABLE public.job_steps DROP CONSTRAINT IF EXISTS moment_steps_status_check;
ALTER TABLE public.job_steps DROP CONSTRAINT IF EXISTS job_steps_status_check;
ALTER TABLE public.job_steps ADD CONSTRAINT job_steps_status_check
  CHECK (status IN ('todo', 'in_progress', 'waiting_client', 'changes_requested', 'blocked', 'done', 'skipped'));

ALTER TABLE public.inbox_items DROP CONSTRAINT IF EXISTS inbox_items_reason_check;
ALTER TABLE public.inbox_items ADD CONSTRAINT inbox_items_reason_check
  CHECK (reason IN ('assigned', 'mentioned', 'following', 'comment_on_my_step', 'reply', 'review'));

-- ── Offers belong to a job ──────────────────────────────────────────────────
ALTER TABLE public.offer_cards ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_offer_cards_job ON public.offer_cards (job_id);

-- ── Rounds ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.review_rounds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  deliverable   TEXT NOT NULL CHECK (deliverable IN ('offer', 'lp', 'creative')),
  phase         TEXT NOT NULL CHECK (phase IN ('internal', 'client')),
  round_no      INTEGER NOT NULL CHECK (round_no > 0),
  -- NULL when the round's start predates this table (replayed history).
  opened_at     TIMESTAMPTZ,
  opened_by     UUID,
  opened_label  TEXT,
  closed_at     TIMESTAMPTZ,
  outcome       TEXT CHECK (outcome IN ('approved', 'changes')),
  decided_by    UUID,
  -- Free text: clients and Profit Engineers are not profiles.
  decided_label TEXT,
  note          TEXT,
  source        TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'history')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, deliverable, phase, round_no),
  CHECK ((closed_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_review_rounds_job ON public.review_rounds (job_id, deliverable, phase, round_no);

ALTER TABLE public.review_rounds ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'review_rounds' AND policyname = 'review_rounds_staff') THEN
    CREATE POLICY review_rounds_staff ON public.review_rounds FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Where a deliverable is, from its card ───────────────────────────────────
-- not_started · building · internal_review · internal_revisions · discount ·
-- client_review · client_revisions · approved
CREATE OR REPLACE FUNCTION public.offer_review_state(stage TEXT, changes_at TIMESTAMPTZ, client_changes_at TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stage
    WHEN 'offer_draft' THEN CASE WHEN changes_at IS NOT NULL THEN 'internal_revisions' ELSE 'building' END
    WHEN 'internal_offer_review' THEN 'internal_review'
    WHEN 'client_review' THEN CASE WHEN client_changes_at IS NOT NULL THEN 'client_revisions' ELSE 'client_review' END
    WHEN 'offer_approved' THEN 'approved'
    ELSE 'not_started'
  END
$$;

-- A track of the production card. lp_stage 'revisions' only ever means client
-- revisions: the LP's internal loop lives in lp_internal_step.
CREATE OR REPLACE FUNCTION public.track_review_state(stage TEXT, internal_step TEXT, approved BOOLEAN)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN coalesce(approved, false) OR stage IN ('ready', 'live') THEN 'approved'
    WHEN stage = 'in_progress' THEN 'building'
    WHEN stage = 'internal_review' THEN CASE internal_step WHEN 'revisions' THEN 'internal_revisions' WHEN 'discount' THEN 'discount' ELSE 'internal_review' END
    WHEN stage = 'client_review' THEN 'client_review'
    WHEN stage = 'revisions' THEN 'client_revisions'
    ELSE 'not_started'
  END
$$;

CREATE OR REPLACE FUNCTION public.review_step_key(deliverable TEXT, role TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE deliverable
    WHEN 'offer' THEN CASE role WHEN 'build' THEN 'offer_draft' WHEN 'internal' THEN 'offer_internal_review' WHEN 'client' THEN 'offer_client_approval' WHEN 'revisions' THEN 'offer_revisions' END
    WHEN 'lp' THEN CASE role WHEN 'build' THEN 'lp_build' WHEN 'internal' THEN 'lp_internal_review' WHEN 'discount' THEN 'lp_discount' WHEN 'client' THEN 'lp_client_review' WHEN 'revisions' THEN 'lp_revisions' END
    WHEN 'creative' THEN CASE role WHEN 'build' THEN 'cr_drafts' WHEN 'internal' THEN 'cr_internal_review' WHEN 'client' THEN 'cr_client_review' WHEN 'revisions' THEN 'cr_revisions' END
  END
$$;

CREATE OR REPLACE FUNCTION public.profile_label(p UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(nullif(btrim(full_name), ''), split_part(email, '@', 1)) FROM profiles WHERE id = p
$$;

-- ── Rounds from a state change ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.review_notify(p_job UUID, p_deliv TEXT, p_role TEXT, p_kind TEXT, p_title TEXT, p_body TEXT, p_actor UUID, p_to_owner BOOLEAN)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec   RECORD;
  label TEXT := CASE p_deliv WHEN 'offer' THEN 'Offer' WHEN 'lp' THEN 'Landing page' ELSE 'Creatives' END;
BEGIN
  FOR rec IN
    SELECT DISTINCT ON (who) who, step_id, job_name FROM (
      SELECT s.assignee_id AS who, s.id AS step_id, j.name AS job_name, 1 AS pri
        FROM job_steps s JOIN jobs j ON j.id = s.job_id
       WHERE s.job_id = p_job AND s.key = review_step_key(p_deliv, p_role) AND s.assignee_id IS NOT NULL
      UNION ALL
      SELECT j.owner_id, NULL, j.name, 2 FROM jobs j WHERE p_to_owner AND j.id = p_job AND j.owner_id IS NOT NULL
    ) x
    WHERE who IS DISTINCT FROM p_actor
    ORDER BY who, pri
  LOOP
    INSERT INTO inbox_items (recipient_id, job_id, step_id, kind, reason, actor_id, title, body)
    VALUES (rec.who, p_job, rec.step_id, p_kind, 'review', p_actor, format('%s · %s: %s', label, p_title, rec.job_name), p_body);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.review_close_round(
  p_job UUID, p_deliv TEXT, p_phase TEXT, p_outcome TEXT,
  p_actor UUID, p_label TEXT, p_note TEXT, p_at TIMESTAMPTZ, p_source TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r_id UUID;
  n    INTEGER;
BEGIN
  SELECT id, round_no INTO r_id, n FROM review_rounds
   WHERE job_id = p_job AND deliverable = p_deliv AND phase = p_phase AND closed_at IS NULL
   ORDER BY round_no DESC LIMIT 1;
  IF r_id IS NOT NULL THEN
    UPDATE review_rounds SET closed_at = p_at, outcome = p_outcome, decided_by = p_actor, decided_label = p_label,
           note = coalesce(p_note, note), source = p_source
     WHERE id = r_id;
    RETURN n;
  END IF;
  -- No open round (it started before rounds were recorded): record it closed.
  SELECT coalesce(max(round_no), 0) + 1 INTO n FROM review_rounds WHERE job_id = p_job AND deliverable = p_deliv AND phase = p_phase;
  INSERT INTO review_rounds (job_id, deliverable, phase, round_no, closed_at, outcome, decided_by, decided_label, note, source)
  VALUES (p_job, p_deliv, p_phase, n, p_at, p_outcome, p_actor, p_label, p_note, p_source);
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.review_open_round(
  p_job UUID, p_deliv TEXT, p_phase TEXT, p_actor UUID, p_label TEXT, p_at TIMESTAMPTZ, p_source TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n INTEGER;
BEGIN
  SELECT round_no INTO n FROM review_rounds
   WHERE job_id = p_job AND deliverable = p_deliv AND phase = p_phase AND closed_at IS NULL LIMIT 1;
  IF n IS NOT NULL THEN RETURN n; END IF;
  SELECT coalesce(max(round_no), 0) + 1 INTO n FROM review_rounds WHERE job_id = p_job AND deliverable = p_deliv AND phase = p_phase;
  INSERT INTO review_rounds (job_id, deliverable, phase, round_no, opened_at, opened_by, opened_label, source)
  VALUES (p_job, p_deliv, p_phase, n, p_at, p_actor, p_label, p_source);
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.record_review_transition(
  p_job UUID, p_deliv TEXT, p_old TEXT, p_new TEXT,
  p_actor UUID, p_label TEXT, p_note TEXT,
  p_at TIMESTAMPTZ DEFAULT now(), p_source TEXT DEFAULT 'live'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  live  BOOLEAN := p_source = 'live';
  n     INTEGER;
  past_internal BOOLEAN := p_new IN ('discount', 'client_review', 'client_revisions', 'approved');
BEGIN
  IF p_old IS NOT DISTINCT FROM p_new THEN RETURN; END IF;

  -- Leaving a review closes its round.
  IF p_old = 'internal_review' THEN
    n := review_close_round(p_job, p_deliv, 'internal', CASE WHEN past_internal THEN 'approved' ELSE 'changes' END, p_actor, p_label, p_note, p_at, p_source);
    IF live AND NOT past_internal THEN
      PERFORM review_notify(p_job, p_deliv, 'build', 'needs_action', format('internal changes requested (round %s)', n), p_note, p_actor, false);
    END IF;
  ELSIF p_old = 'internal_revisions' AND past_internal THEN
    -- Approved on the spot once the fixes were in, without a formal resubmit.
    PERFORM review_close_round(p_job, p_deliv, 'internal', 'approved', p_actor, p_label, NULL, p_at, p_source);
  END IF;

  IF p_old = 'client_review' THEN
    n := review_close_round(p_job, p_deliv, 'client', CASE WHEN p_new = 'approved' THEN 'approved' ELSE 'changes' END, p_actor, p_label, p_note, p_at, p_source);
    IF live THEN
      IF p_new = 'approved' THEN
        PERFORM review_notify(p_job, p_deliv, 'build', 'fyi', format('client approved (round %s)', n), p_note, p_actor, true);
      ELSE
        PERFORM review_notify(p_job, p_deliv, 'revisions', 'needs_action', format('client revisions requested (round %s)', n), p_note, p_actor, true);
      END IF;
    END IF;
  ELSIF p_old = 'client_revisions' AND p_new = 'approved' THEN
    PERFORM review_close_round(p_job, p_deliv, 'client', 'approved', p_actor, p_label, NULL, p_at, p_source);
  END IF;

  -- Entering a review opens the next round.
  IF p_new = 'internal_review' THEN
    n := review_open_round(p_job, p_deliv, 'internal', p_actor, p_label, p_at, p_source);
    IF live THEN
      PERFORM review_notify(p_job, p_deliv, 'internal', 'needs_action', format('ready for internal review (round %s)', n), NULL, p_actor, false);
    END IF;
  ELSIF p_new = 'client_review' THEN
    n := review_open_round(p_job, p_deliv, 'client', p_actor, p_label, p_at, p_source);
    IF live THEN
      PERFORM review_notify(p_job, p_deliv, 'client', 'fyi', format('with the client (round %s)', n), NULL, p_actor, false);
    END IF;
  END IF;
END $$;

-- A reason typed on the job page, for moves whose card has nowhere to keep one
-- (landing page and creatives): saved on the round just closed and on the
-- notices that move sent, so the person fixing it reads why.
CREATE OR REPLACE FUNCTION public.annotate_review_round(p_job UUID, p_deliv TEXT, p_note TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r_id UUID;
BEGIN
  IF auth.uid() IS NULL OR coalesce(btrim(p_note), '') = '' THEN RETURN; END IF;
  SELECT id INTO r_id FROM review_rounds
   WHERE job_id = p_job AND deliverable = p_deliv AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1;
  UPDATE review_rounds SET note = p_note WHERE id = r_id AND note IS NULL;
  UPDATE inbox_items SET body = p_note
   WHERE job_id = p_job AND reason = 'review' AND body IS NULL AND actor_id = auth.uid() AND created_at > now() - interval '1 minute';
END $$;

-- ── Steps from the cards ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_review_step(p_job UUID, p_key TEXT, p_status TEXT)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE job_steps SET status = p_status
   WHERE job_id = p_job AND key = p_key AND NOT is_group AND p_status IS NOT NULL AND status IS DISTINCT FROM p_status
$$;

CREATE OR REPLACE FUNCTION public.apply_review_state(p_job UUID, p_deliv TEXT, p_state TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  had BOOLEAN;
  b TEXT; i TEXT; d TEXT; c TEXT; r TEXT;
BEGIN
  had := EXISTS (SELECT 1 FROM review_rounds WHERE job_id = p_job AND deliverable = p_deliv AND outcome = 'changes');
  -- build, internal, discount, client, revisions
  SELECT x.b, x.i, x.d, x.c, x.r INTO b, i, d, c, r FROM (VALUES
    ('not_started',        NULL,                                          'todo',              'todo',        'todo',              'todo'),
    ('building',           CASE WHEN had THEN 'done' ELSE 'in_progress' END, 'todo',           'todo',        'todo',              CASE WHEN had THEN 'in_progress' ELSE 'todo' END),
    ('internal_review',    'done',                                        'in_progress',       'todo',        'todo',              CASE WHEN had THEN 'done' ELSE 'todo' END),
    ('internal_revisions', 'done',                                        'changes_requested', 'todo',        'todo',              'in_progress'),
    ('discount',           'done',                                        'done',              'in_progress', 'todo',              CASE WHEN had THEN 'done' ELSE 'todo' END),
    ('client_review',      'done',                                        'done',              'done',        'waiting_client',    CASE WHEN had THEN 'done' ELSE 'todo' END),
    ('client_revisions',   'done',                                        'done',              'done',        'changes_requested', 'in_progress'),
    ('approved',           'done',                                        'done',              'done',        'done',              CASE WHEN had THEN 'done' ELSE 'skipped' END)
  ) AS x(state, b, i, d, c, r) WHERE x.state = p_state;

  PERFORM set_review_step(p_job, review_step_key(p_deliv, 'build'), b);
  PERFORM set_review_step(p_job, review_step_key(p_deliv, 'internal'), i);
  IF p_deliv = 'lp' THEN PERFORM set_review_step(p_job, 'lp_discount', d); END IF;
  PERFORM set_review_step(p_job, review_step_key(p_deliv, 'client'), c);
  PERFORM set_review_step(p_job, review_step_key(p_deliv, 'revisions'), r);
END $$;

-- Creatives have no stage for "internal changes requested": they go back to In
-- Progress. The rounds tell the two apart.
CREATE OR REPLACE FUNCTION public.creative_review_state(p_job UUID, p_stage TEXT, p_approved BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  st TEXT := track_review_state(p_stage, NULL, p_approved);
  last_outcome TEXT;
BEGIN
  IF st <> 'building' THEN RETURN st; END IF;
  SELECT outcome INTO last_outcome FROM review_rounds
   WHERE job_id = p_job AND deliverable = 'creative' AND phase = 'internal' ORDER BY round_no DESC LIMIT 1;
  IF last_outcome = 'changes' AND NOT EXISTS (SELECT 1 FROM review_rounds WHERE job_id = p_job AND deliverable = 'creative' AND phase = 'client') THEN
    RETURN 'internal_revisions';
  END IF;
  RETURN st;
END $$;

CREATE OR REPLACE FUNCTION public.sync_job_steps(p_job UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j  RECORD;
  o  RECORD;
  p  RECORD;
  lp TEXT;
  cr TEXT;
BEGIN
  SELECT id, offer_card_id, project_id INTO j FROM jobs WHERE id = p_job;
  IF NOT FOUND THEN RETURN; END IF;

  IF j.offer_card_id IS NOT NULL THEN
    SELECT stage, changes_requested_at, client_changes_requested_at INTO o FROM offer_cards WHERE id = j.offer_card_id;
    IF FOUND THEN
      PERFORM apply_review_state(p_job, 'offer', offer_review_state(o.stage, o.changes_requested_at, o.client_changes_requested_at));
      IF j.project_id IS NULL AND o.stage = 'offer_approved' THEN
        UPDATE job_steps SET status = 'in_progress' WHERE job_id = p_job AND key = 'brief' AND status = 'todo';
      END IF;
    END IF;
  END IF;

  IF j.project_id IS NOT NULL THEN
    SELECT lp_stage, lp_internal_step, lp_approved, creatives_stage, creatives_approved INTO p FROM projects WHERE id = j.project_id;
    IF FOUND THEN
      lp := track_review_state(p.lp_stage, p.lp_internal_step, p.lp_approved);
      cr := creative_review_state(p_job, p.creatives_stage, p.creatives_approved);
      PERFORM apply_review_state(p_job, 'lp', lp);
      PERFORM apply_review_state(p_job, 'creative', cr);
      PERFORM set_review_step(p_job, 'brief', CASE WHEN lp = 'not_started' AND cr = 'not_started' THEN 'in_progress' ELSE 'done' END);
      PERFORM set_review_step(p_job, 'launch', CASE
        WHEN p.lp_stage = 'live' AND p.creatives_stage = 'live' THEN 'done'
        WHEN lp = 'approved' AND cr = 'approved' THEN 'in_progress'
        ELSE 'todo' END);
    END IF;
  END IF;
END $$;

-- ── Triggers on the cards ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.offer_card_review_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  primary_id UUID;
  old_st TEXT;
  new_st TEXT;
  who    TEXT;
  note   TEXT;
BEGIN
  IF NEW.job_id IS NULL THEN RETURN NULL; END IF;

  -- The job's driving offer: the first one linked, until another is approved.
  UPDATE jobs SET offer_card_id = NEW.id
   WHERE id = NEW.job_id AND offer_card_id IS DISTINCT FROM NEW.id
     AND (offer_card_id IS NULL OR NEW.stage = 'offer_approved');
  SELECT offer_card_id INTO primary_id FROM jobs WHERE id = NEW.job_id;
  IF primary_id IS DISTINCT FROM NEW.id THEN RETURN NULL; END IF;

  IF TG_OP = 'UPDATE' AND OLD.job_id IS NOT DISTINCT FROM NEW.job_id THEN
    old_st := offer_review_state(OLD.stage, OLD.changes_requested_at, OLD.client_changes_requested_at);
    new_st := offer_review_state(NEW.stage, NEW.changes_requested_at, NEW.client_changes_requested_at);
    IF old_st IS DISTINCT FROM new_st THEN
      who := CASE
        WHEN new_st = 'approved' AND NEW.client_approved_by IS NOT NULL AND NEW.client_approved_at IS DISTINCT FROM OLD.client_approved_at THEN NEW.client_approved_by
        WHEN new_st = 'client_revisions' THEN NEW.client_changes_requested_by
        WHEN new_st = 'internal_revisions' THEN NEW.changes_requested_by
        WHEN old_st = 'internal_review' AND new_st = 'client_review' THEN nullif(concat_ws(' + ', NEW.strategist_approved_by, NEW.engineer_approved_by), '')
      END;
      note := CASE new_st WHEN 'internal_revisions' THEN NEW.changes_requested_note WHEN 'client_revisions' THEN NEW.client_changes_requested_note END;
      PERFORM record_review_transition(NEW.job_id, 'offer', old_st, new_st, auth.uid(),
        coalesce(who, profile_label(auth.uid()), 'Client'), note);
    END IF;
  END IF;

  PERFORM sync_job_steps(NEW.job_id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS offer_cards_review_sync ON public.offer_cards;
CREATE TRIGGER offer_cards_review_sync AFTER INSERT OR UPDATE ON public.offer_cards
  FOR EACH ROW EXECUTE FUNCTION public.offer_card_review_sync();

CREATE OR REPLACE FUNCTION public.project_review_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j_id   UUID;
  old_st TEXT;
  new_st TEXT;
  who    TEXT := coalesce(profile_label(auth.uid()), 'Client');
  note   TEXT;
BEGIN
  -- A production card made from an offer joins that offer's job.
  IF TG_OP = 'INSERT' AND NEW.source_offer_card_id IS NOT NULL THEN
    UPDATE jobs SET project_id = NEW.id
     WHERE project_id IS NULL AND id = (SELECT job_id FROM offer_cards WHERE id = NEW.source_offer_card_id);
  END IF;

  FOR j_id IN SELECT id FROM jobs WHERE project_id = NEW.id LOOP
    IF TG_OP = 'UPDATE' THEN
      old_st := track_review_state(OLD.lp_stage, OLD.lp_internal_step, OLD.lp_approved);
      new_st := track_review_state(NEW.lp_stage, NEW.lp_internal_step, NEW.lp_approved);
      IF old_st IS DISTINCT FROM new_st THEN
        note := CASE WHEN new_st = 'client_revisions' AND auth.uid() IS NULL THEN
          (SELECT content FROM project_comments WHERE project_id = NEW.id AND track = 'lp' AND audience = 'client' ORDER BY created_at DESC LIMIT 1) END;
        PERFORM record_review_transition(j_id, 'lp', old_st, new_st, auth.uid(), who, note);
      END IF;

      old_st := creative_review_state(j_id, OLD.creatives_stage, OLD.creatives_approved);
      new_st := track_review_state(NEW.creatives_stage, NULL, NEW.creatives_approved);
      IF old_st IS DISTINCT FROM new_st AND NOT (old_st = 'internal_revisions' AND new_st = 'building') THEN
        note := CASE WHEN new_st = 'client_revisions' AND auth.uid() IS NULL THEN
          (SELECT content FROM project_comments WHERE project_id = NEW.id AND track = 'image' AND audience = 'client' ORDER BY created_at DESC LIMIT 1) END;
        PERFORM record_review_transition(j_id, 'creative', old_st, new_st, auth.uid(), who, note);
      END IF;
    END IF;
    PERFORM sync_job_steps(j_id);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS projects_review_sync ON public.projects;
CREATE TRIGGER projects_review_sync AFTER INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.project_review_sync();

-- Linking a card to a job by hand brings its steps up to date.
CREATE OR REPLACE FUNCTION public.job_links_review_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.offer_card_id IS NOT NULL THEN
    UPDATE offer_cards SET job_id = NEW.id WHERE id = NEW.offer_card_id AND job_id IS NULL;
  END IF;
  PERFORM sync_job_steps(NEW.id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS jobs_links_review_sync ON public.jobs;
CREATE TRIGGER jobs_links_review_sync AFTER UPDATE OF offer_card_id, project_id ON public.jobs
  FOR EACH ROW WHEN (OLD.offer_card_id IS DISTINCT FROM NEW.offer_card_id OR OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION public.job_links_review_sync();

-- ── Templates: revisions loops and the discount step ───────────────────────
-- "Apply client edits" becomes "Make revisions" (every round, internal or
-- client), and the offer gets one too. The LP gets Discount creation between
-- internal review and the client.
CREATE OR REPLACE FUNCTION public.review_template_steps(steps JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out JSONB := '[]';
  s   JSONB;
  has_offer_rev BOOLEAN := steps @> '[{"key":"offer_revisions"}]';
  has_discount  BOOLEAN := steps @> '[{"key":"lp_discount"}]';
BEGIN
  FOR s IN SELECT value FROM jsonb_array_elements(steps) LOOP
    IF s->>'key' = 'lp_client_edits' THEN s := s || '{"key":"lp_revisions","title":"Make revisions"}'; END IF;
    IF s->>'key' = 'cr_client_edits' THEN s := s || '{"key":"cr_revisions","title":"Make revisions"}'; END IF;
    out := out || jsonb_build_array(s);
    IF s->>'key' = 'offer_client_approval' AND NOT has_offer_rev THEN
      out := out || jsonb_build_array(s || '{"key":"offer_revisions","title":"Make offer revisions"}');
    END IF;
    IF s->>'key' = 'lp_internal_review' AND NOT has_discount THEN
      out := out || jsonb_build_array(s || jsonb_build_object('key', 'lp_discount', 'title', 'Discount creation', 'day', (s->>'day')::int + 1));
    END IF;
  END LOOP;
  RETURN out;
END $$;

UPDATE public.workflow_templates SET steps = review_template_steps(steps) WHERE steps IS DISTINCT FROM review_template_steps(steps);
UPDATE public.workflow_templates
   SET stages = (SELECT jsonb_agg(CASE WHEN st->>'key' = 'client_edits' THEN st || '{"label":"Revisions"}' ELSE st END ORDER BY ord)
                 FROM jsonb_array_elements(stages) WITH ORDINALITY AS e(st, ord))
 WHERE stages @> '[{"key":"client_edits","label":"Client edits"}]';
UPDATE public.jobs
   SET stages = (SELECT jsonb_agg(CASE WHEN st->>'key' = 'client_edits' THEN st || '{"label":"Revisions"}' ELSE st END ORDER BY ord)
                 FROM jsonb_array_elements(stages) WITH ORDINALITY AS e(st, ord))
 WHERE stages @> '[{"key":"client_edits","label":"Client edits"}]';

-- ── Bring existing jobs and their history over ──────────────────────────────
-- Callable again after a reseed (prototype-env/seed-jobs.mjs). Jobs whose
-- deliverable already has rounds are left alone, so it never doubles up.
CREATE OR REPLACE FUNCTION public.backfill_review_rounds()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  j      RECORD;
  a      RECORD;
  e      RECORD;
  st     TEXT;
  nst    TEXT;
  cur    TEXT;
  rounds INTEGER;
  anchor RECORD;
BEGIN
  UPDATE offer_cards o SET job_id = jb.id FROM jobs jb WHERE jb.offer_card_id = o.id AND o.job_id IS NULL;
  UPDATE job_steps SET key = 'lp_revisions', title = 'Make revisions' WHERE key = 'lp_client_edits';
  UPDATE job_steps SET key = 'cr_revisions', title = 'Make revisions' WHERE key = 'cr_client_edits';

  -- Missing linked steps, placed right after the step they follow.
  FOR anchor IN
    SELECT s.*, 'offer_revisions' AS new_key, 'Make offer revisions' AS new_title, 0 AS extra_days FROM job_steps s
     WHERE s.key = 'offer_client_approval' AND NOT EXISTS (SELECT 1 FROM job_steps x WHERE x.job_id = s.job_id AND x.key = 'offer_revisions')
    UNION ALL
    SELECT s.*, 'lp_discount', 'Discount creation', 1 FROM job_steps s
     WHERE s.key = 'lp_internal_review' AND NOT EXISTS (SELECT 1 FROM job_steps x WHERE x.job_id = s.job_id AND x.key = 'lp_discount')
  LOOP
    UPDATE job_steps SET sort_order = sort_order + 1
     WHERE job_id = anchor.job_id AND parent_id IS NOT DISTINCT FROM anchor.parent_id AND sort_order > anchor.sort_order;
    INSERT INTO job_steps (job_id, parent_id, key, title, is_group, sort_order, assignee_id, due_date, status, stage, day_offset)
    VALUES (anchor.job_id, anchor.parent_id, anchor.new_key, anchor.new_title, false, anchor.sort_order + 1,
            anchor.assignee_id, anchor.due_date, 'todo', anchor.stage, anchor.day_offset + anchor.extra_days);
  END LOOP;

  -- Replay the old event log into rounds.
  FOR j IN SELECT id, offer_card_id, project_id FROM jobs WHERE offer_card_id IS NOT NULL OR project_id IS NOT NULL LOOP
    FOR a IN
      SELECT 'offer' AS deliv, 'offer' AS kind, NULL::text AS track, j.offer_card_id AS card WHERE j.offer_card_id IS NOT NULL
      UNION ALL SELECT 'lp', 'production', 'lp', j.project_id WHERE j.project_id IS NOT NULL
      UNION ALL SELECT 'creative', 'production', 'creative', j.project_id WHERE j.project_id IS NOT NULL
    LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM review_rounds WHERE job_id = j.id AND deliverable = a.deliv);
      st := 'not_started';
      FOR e IN
        SELECT * FROM pipeline_events
         WHERE card_id = a.card AND card_kind = a.kind AND track IS NOT DISTINCT FROM a.track
           AND event_type IN ('stage_changed', 'client_responded')
         ORDER BY created_at, id
      LOOP
        IF e.event_type = 'stage_changed' THEN
          nst := CASE WHEN a.deliv = 'offer'
            THEN offer_review_state(e.to_stage, CASE WHEN e.from_stage = 'internal_offer_review' AND e.to_stage = 'offer_draft' THEN e.created_at END, NULL)
            ELSE track_review_state(e.to_stage, NULL, false) END;
        ELSIF e.payload->>'response_type' = 'revision_requested' AND st = 'client_review' THEN
          nst := 'client_revisions';
        ELSIF e.payload->>'response_type' = 'approved' AND st = 'client_review' THEN
          nst := 'approved';
        ELSE
          CONTINUE;
        END IF;
        PERFORM record_review_transition(j.id, a.deliv, st, nst, e.actor_id,
          CASE WHEN e.actor_label LIKE 'client:%' THEN substr(e.actor_label, 8) WHEN e.actor_label = 'client' THEN 'Client'
               ELSE coalesce(profile_label(e.actor_id), e.actor_label) END,
          NULL, e.created_at, 'history');
        st := nst;
      END LOOP;

      -- Catch up with where the card actually is now.
      IF a.deliv = 'offer' THEN
        SELECT offer_review_state(stage, changes_requested_at, client_changes_requested_at) INTO cur FROM offer_cards WHERE id = a.card;
      ELSIF a.deliv = 'lp' THEN
        SELECT track_review_state(lp_stage, lp_internal_step, lp_approved) INTO cur FROM projects WHERE id = a.card;
      ELSE
        SELECT track_review_state(creatives_stage, NULL, creatives_approved) INTO cur FROM projects WHERE id = a.card;
      END IF;
      IF cur IS DISTINCT FROM st AND NOT (st = 'internal_revisions' AND cur = 'building') THEN
        PERFORM record_review_transition(j.id, a.deliv, st, cur, NULL, 'System', NULL, now(), 'history');
      END IF;
    END LOOP;
    PERFORM sync_job_steps(j.id);
  END LOOP;

  SELECT count(*) INTO rounds FROM review_rounds;
  RETURN format('%s rounds', rounds);
END $$;

SELECT public.backfill_review_rounds();

-- Names, not emails, on rounds replayed by an earlier run of the above.
UPDATE public.review_rounds SET opened_label = public.profile_label(opened_by) WHERE opened_label LIKE '%@%' AND public.profile_label(opened_by) IS NOT NULL;
UPDATE public.review_rounds SET decided_label = public.profile_label(decided_by) WHERE decided_label LIKE '%@%' AND public.profile_label(decided_by) IS NOT NULL;

-- ── Activity log: skip bookkeeping columns ──────────────────────────────────
-- A step's key and sort order change when templates gain steps; nobody needs
-- "System changed sort order" in a job's history.
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
      CONTINUE WHEN k IN ('updated_at', 'edited_at', 'started_at', 'completed_at', 'stages', 'key', 'sort_order');
      IF (old_rec->k) IS DISTINCT FROM (rec->k) THEN
        INSERT INTO activity_log (job_id, step_id, entity, action, field, old_value, new_value, actor_id)
        VALUES (j_id, s_id, entity, 'updated', k, old_rec->>k, rec->>k, auth.uid());
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE public.activity_log DISABLE TRIGGER activity_log_no_mutation;
DELETE FROM public.activity_log WHERE field IN ('key', 'sort_order');
ALTER TABLE public.activity_log ENABLE TRIGGER activity_log_no_mutation;

COMMIT;
