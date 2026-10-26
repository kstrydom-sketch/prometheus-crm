-- Comment threads: a comment can reply to another comment. One level deep:
-- replies always point at the thread's first comment, so threads stay readable.
--
-- ADDITIVE ONLY. Safe to re-run.

BEGIN;

ALTER TABLE public.step_comments
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.step_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_step_comments_parent ON public.step_comments (parent_id, created_at);

-- Replies notify the people already in the thread.
ALTER TABLE public.inbox_items DROP CONSTRAINT IF EXISTS inbox_items_reason_check;
ALTER TABLE public.inbox_items ADD CONSTRAINT inbox_items_reason_check
  CHECK (reason IN ('assigned', 'mentioned', 'following', 'comment_on_my_step', 'reply'));

COMMIT;
