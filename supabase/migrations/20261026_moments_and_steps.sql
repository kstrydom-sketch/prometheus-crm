-- Moments & steps: one followable item per client moment, holding every step
-- from offer to launch, each with an owner, a due date and a status. Plus an
-- internal comment thread per step, followers, a personal inbox, and an audit
-- log that records every change automatically.
--
-- ADDITIVE ONLY. New tables; nothing existing is changed or dropped. Existing
-- offer cards and production cards link in through optional foreign keys, so
-- the old boards keep working while the new flow is tried out.
--
-- Safe to re-run.

BEGIN;

-- ── Moments ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.moments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       UUID NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- First day of the month the moment is for, e.g. 2026-11-01.
  target_month   DATE NOT NULL,
  slot           SMALLINT NOT NULL DEFAULT 1 CHECK (slot BETWEEN 1 AND 4),
  -- Day 0 of the cycle; step due dates are counted from here in working days.
  start_date     DATE NOT NULL,
  launch_date    DATE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'launched', 'on_hold', 'cancelled')),
  owner_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  offer_card_id  UUID REFERENCES public.offer_cards(id) ON DELETE SET NULL,
  project_id     UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moments_brand ON public.moments (brand_id, target_month DESC);
CREATE INDEX IF NOT EXISTS idx_moments_status ON public.moments (status, launch_date);

-- ── Steps ───────────────────────────────────────────────────────────────────
-- A step is one piece of work with one owner and one due date. Groups
-- ("Landing page", "Creatives") are steps with is_group = true; their children
-- point at them through parent_id.
CREATE TABLE IF NOT EXISTS public.moment_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id      UUID NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  parent_id      UUID REFERENCES public.moment_steps(id) ON DELETE CASCADE,
  -- Template key ('offer_draft', 'lp_build', ...). NULL for steps added by hand.
  key            TEXT,
  title          TEXT NOT NULL CHECK (btrim(title) <> ''),
  is_group       BOOLEAN NOT NULL DEFAULT false,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  assignee_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  due_date       DATE,
  status         TEXT NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'waiting_client', 'blocked', 'done', 'skipped')),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moment_steps_moment ON public.moment_steps (moment_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_moment_steps_assignee ON public.moment_steps (assignee_id, status, due_date);

-- ── Comments ────────────────────────────────────────────────────────────────
-- Internal only. kind: 'needs_action' asks someone to do something, 'fyi' just
-- informs, 'note' is plain discussion.
CREATE TABLE IF NOT EXISTS public.step_comments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id      UUID NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  step_id        UUID REFERENCES public.moment_steps(id) ON DELETE CASCADE,
  author_id      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  body           TEXT NOT NULL CHECK (btrim(body) <> ''),
  kind           TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'fyi', 'needs_action')),
  mentions       UUID[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_step_comments_step ON public.step_comments (step_id, created_at);
CREATE INDEX IF NOT EXISTS idx_step_comments_moment ON public.step_comments (moment_id, created_at);

-- ── Followers ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.moment_followers (
  moment_id      UUID NOT NULL REFERENCES public.moments(id) ON DELETE CASCADE,
  profile_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, profile_id)
);

-- ── Inbox ───────────────────────────────────────────────────────────────────
-- One row per thing a person should see. 'needs_action' stays until they clear
-- it after doing the work; 'fyi' is read and cleared quickly.
CREATE TABLE IF NOT EXISTS public.inbox_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  moment_id      UUID REFERENCES public.moments(id) ON DELETE CASCADE,
  step_id        UUID REFERENCES public.moment_steps(id) ON DELETE CASCADE,
  comment_id     UUID REFERENCES public.step_comments(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('needs_action', 'fyi')),
  reason         TEXT NOT NULL CHECK (reason IN ('assigned', 'mentioned', 'following', 'comment_on_my_step')),
  actor_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  body           TEXT,
  cleared_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbox_open ON public.inbox_items (recipient_id, cleared_at, created_at DESC);

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Written only by triggers, so every change is recorded whichever screen or
-- script made it. Append-only.
-- moment_id has no foreign key on purpose: deleting a moment must not delete
-- (or be blocked by) its history.
CREATE TABLE IF NOT EXISTS public.activity_log (
  id             BIGSERIAL PRIMARY KEY,
  moment_id      UUID,
  step_id        UUID,
  entity         TEXT NOT NULL,          -- 'moment' | 'step' | 'comment'
  action         TEXT NOT NULL,          -- 'created' | 'updated' | 'deleted' | 'commented'
  field          TEXT,                   -- which column changed, for 'updated'
  old_value      TEXT,
  new_value      TEXT,
  actor_id       UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_moment ON public.activity_log (moment_id, created_at DESC);
ALTER TABLE public.activity_log DROP CONSTRAINT IF EXISTS activity_log_moment_id_fkey;

CREATE OR REPLACE FUNCTION public.activity_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only (%).', TG_OP;
END $$;

DROP TRIGGER IF EXISTS activity_log_no_mutation ON public.activity_log;
CREATE TRIGGER activity_log_no_mutation BEFORE UPDATE OR DELETE ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.activity_log_append_only();

-- Logs inserts, deletes, and one row per changed column on update. Columns
-- that change on every write (updated_at) are skipped.
CREATE OR REPLACE FUNCTION public.log_moment_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  entity  TEXT := CASE TG_TABLE_NAME WHEN 'moments' THEN 'moment' WHEN 'moment_steps' THEN 'step' ELSE 'comment' END;
  rec     JSONB;
  old_rec JSONB;
  m_id    UUID;
  s_id    UUID;
  k       TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  m_id := CASE WHEN entity = 'moment' THEN (rec->>'id')::uuid ELSE (rec->>'moment_id')::uuid END;
  s_id := CASE WHEN entity = 'step' THEN (rec->>'id')::uuid WHEN entity = 'comment' THEN (rec->>'step_id')::uuid ELSE NULL END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO activity_log (moment_id, step_id, entity, action, new_value, actor_id)
    VALUES (m_id, s_id, entity, CASE WHEN entity = 'comment' THEN 'commented' ELSE 'created' END,
            CASE WHEN entity = 'comment' THEN rec->>'body' ELSE rec->>CASE WHEN entity = 'moment' THEN 'name' ELSE 'title' END END,
            auth.uid());
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO activity_log (moment_id, step_id, entity, action, old_value, actor_id)
    VALUES (m_id, s_id, entity, 'deleted', rec->>CASE WHEN entity = 'moment' THEN 'name' WHEN entity = 'step' THEN 'title' ELSE 'body' END, auth.uid());
  ELSE
    old_rec := to_jsonb(OLD);
    FOR k IN SELECT jsonb_object_keys(rec) LOOP
      CONTINUE WHEN k IN ('updated_at', 'edited_at', 'started_at', 'completed_at');
      IF (old_rec->k) IS DISTINCT FROM (rec->k) THEN
        INSERT INTO activity_log (moment_id, step_id, entity, action, field, old_value, new_value, actor_id)
        VALUES (m_id, s_id, entity, 'updated', k, old_rec->>k, rec->>k, auth.uid());
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS moments_activity ON public.moments;
CREATE TRIGGER moments_activity AFTER INSERT OR UPDATE OR DELETE ON public.moments
  FOR EACH ROW EXECUTE FUNCTION public.log_moment_activity();
DROP TRIGGER IF EXISTS moment_steps_activity ON public.moment_steps;
CREATE TRIGGER moment_steps_activity AFTER INSERT OR UPDATE OR DELETE ON public.moment_steps
  FOR EACH ROW EXECUTE FUNCTION public.log_moment_activity();
DROP TRIGGER IF EXISTS step_comments_activity ON public.step_comments;
CREATE TRIGGER step_comments_activity AFTER INSERT OR DELETE ON public.step_comments
  FOR EACH ROW EXECUTE FUNCTION public.log_moment_activity();

-- Keep updated_at / started_at / completed_at honest.
CREATE OR REPLACE FUNCTION public.touch_moment_step()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_TABLE_NAME = 'moment_steps' THEN
    IF NEW.status = 'in_progress' AND NEW.started_at IS NULL THEN NEW.started_at := now(); END IF;
    IF NEW.status IN ('done', 'skipped') AND (OLD.status IS DISTINCT FROM NEW.status) THEN NEW.completed_at := now(); END IF;
    IF NEW.status NOT IN ('done', 'skipped') THEN NEW.completed_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS moments_touch ON public.moments;
CREATE TRIGGER moments_touch BEFORE UPDATE ON public.moments
  FOR EACH ROW EXECUTE FUNCTION public.touch_moment_step();
DROP TRIGGER IF EXISTS moment_steps_touch ON public.moment_steps;
CREATE TRIGGER moment_steps_touch BEFORE UPDATE ON public.moment_steps
  FOR EACH ROW EXECUTE FUNCTION public.touch_moment_step();

-- ── Row level security ──────────────────────────────────────────────────────
-- Same model as the rest of the CRM: signed-in staff can read and write;
-- canEdit() in the app is the real gate. Inbox rows are private to their owner.
ALTER TABLE public.moments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moment_steps     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.step_comments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moment_followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log     ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'moments' AND policyname = 'moments_staff') THEN
    CREATE POLICY moments_staff ON public.moments FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'moment_steps' AND policyname = 'moment_steps_staff') THEN
    CREATE POLICY moment_steps_staff ON public.moment_steps FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'step_comments' AND policyname = 'step_comments_staff') THEN
    CREATE POLICY step_comments_staff ON public.step_comments FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'moment_followers' AND policyname = 'moment_followers_staff') THEN
    CREATE POLICY moment_followers_staff ON public.moment_followers FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'inbox_items' AND policyname = 'inbox_items_insert') THEN
    CREATE POLICY inbox_items_insert ON public.inbox_items FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'inbox_items' AND policyname = 'inbox_items_own') THEN
    CREATE POLICY inbox_items_own ON public.inbox_items FOR SELECT TO authenticated USING (recipient_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'inbox_items' AND policyname = 'inbox_items_clear_own') THEN
    CREATE POLICY inbox_items_clear_own ON public.inbox_items FOR UPDATE TO authenticated
      USING (recipient_id = auth.uid()) WITH CHECK (recipient_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'activity_log' AND policyname = 'activity_log_read') THEN
    CREATE POLICY activity_log_read ON public.activity_log FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

COMMIT;
