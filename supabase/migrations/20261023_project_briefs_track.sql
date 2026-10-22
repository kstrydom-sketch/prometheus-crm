-- LP briefs: a brief file belongs to the Creatives tab ('creative', every
-- existing row) or to the Landing Page tab's own "LP brief" ('lp').
alter table public.project_briefs
  add column if not exists track text not null default 'creative'
  check (track in ('creative', 'lp'));

-- Landing-page-only projects have no creative work, so their brief files are
-- the page's copy: move them to the LP brief.
update public.project_briefs b
set track = 'lp'
from public.projects p
where p.id = b.project_id
  and p.creatives_notes like 'NOT IN SCOPE%';
