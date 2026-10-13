-- LP review flow: pre-submission checklist, internal review loop, discount
-- creation, and Liquid-file hand-ins. Landing-page track only.
--
-- ADDITIVE ONLY. Five new nullable columns on projects and one new table.
-- Nothing is dropped, rewritten or backfilled; every existing row reads NULL in
-- the new columns, which the app treats as "nothing recorded yet".
--
-- ── Why a sub-step column and not new lp_stage values ─────────────────────
-- Internal Revisions and Discount Creation sit between Internal Review and
-- Client Review, on the LP track only. Making them real Stage values would
-- mean replacing the lp_stage CHECK constraint (a DROP), adding columns the
-- creatives track can never use to the shared kanban, and changing a value
-- other readers of this database (creative-generator) may switch on. Instead
-- lp_stage stays 'internal_review' for the whole internal loop and
-- lp_internal_step says where in that loop the page is:
--
--   review     Omkar is reviewing it (NULL reads the same)
--   revisions  feedback was sent back; the team is fixing it
--   discount   approved internally; the discount is being created
--
-- The app clears lp_internal_step and lp_submission whenever lp_stage leaves
-- 'internal_review', so a value is only ever about the current stay.
--
-- Safe to re-run.
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/mhizyjlvqrhwzjqywiwz/sql/new

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS lp_internal_step TEXT
    CHECK (lp_internal_step IN ('review', 'revisions', 'discount')),
  -- The current round's pre-submission ticks: { "<item key>": { "at", "by" } }.
  -- Emptied when the page is submitted, so every round is re-tested.
  ADD COLUMN IF NOT EXISTS lp_checklist JSONB,
  -- The submission that opened this internal-review stay: who, when, which
  -- checks were confirmed, and the review history since (changes requested,
  -- resubmitted, approved).
  ADD COLUMN IF NOT EXISTS lp_submission JSONB,
  -- How the page's discount was created: by us, by the client, or none needed.
  -- Kept across rounds — the discount is a fact about the page, not a round.
  ADD COLUMN IF NOT EXISTS lp_discount JSONB,
  -- Why the page was handed in as Liquid files instead of a URL. Liquid is the
  -- last resort for clients whose store we cannot access.
  ADD COLUMN IF NOT EXISTS lp_liquid_reason TEXT;

-- Liquid files handed in for a page. A table rather than a JSONB list for the
-- reasons in 20260906_add_brand_documents.sql: uploads are concurrent and the
-- bytes live in storage, so a last-write-wins list can lose a file. The bytes
-- go in the existing private brand-docs bucket (under lp-liquid/<project id>/),
-- which already allows text/plain and has authenticated-only policies — no
-- bucket change is needed.
CREATE TABLE IF NOT EXISTS public.lp_liquid_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  storage_path     TEXT NOT NULL UNIQUE,
  file_name        TEXT NOT NULL CHECK (btrim(file_name) <> ''),
  byte_size        BIGINT NOT NULL CHECK (byte_size > 0),
  uploaded_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_by_name TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_liquid_files_project_created
  ON public.lp_liquid_files (project_id, created_at DESC);

-- Same policy shape as brand_documents: authenticated staff only, canEdit() in
-- the app is the real boundary. No anon policy — the client review link must
-- never be able to list these. Guarded instead of DROP + CREATE so a re-run
-- never drops anything.
ALTER TABLE public.lp_liquid_files ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'lp_liquid_files'
      AND policyname = 'lp_liquid_files_rw_auth'
  ) THEN
    CREATE POLICY lp_liquid_files_rw_auth ON public.lp_liquid_files
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- CHECK (read-only). Run before and after; one result table.
-- Before: new_columns = 0, liquid_table = false.
-- After:  new_columns = 5, liquid_table = true, liquid_policy = 1,
--         projects_total unchanged, steps_set = 0.
--
-- SELECT
--   (SELECT count(*) FROM information_schema.columns
--     WHERE table_schema = 'public' AND table_name = 'projects'
--       AND column_name IN ('lp_internal_step', 'lp_checklist', 'lp_submission',
--                           'lp_discount', 'lp_liquid_reason'))         AS new_columns,
--   (SELECT to_regclass('public.lp_liquid_files') IS NOT NULL)          AS liquid_table,
--   (SELECT count(*) FROM pg_policies
--     WHERE schemaname = 'public' AND tablename = 'lp_liquid_files')    AS liquid_policy,
--   (SELECT count(*) FROM public.projects)                              AS projects_total;
--
-- After only (errors before, because the column does not exist yet):
--   SELECT count(*) AS steps_set FROM public.projects WHERE lp_internal_step IS NOT NULL;
