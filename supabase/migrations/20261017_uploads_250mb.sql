-- Brand documents and project briefs: 250MB per file (17 Oct 2026).
-- Supabase's project-wide upload limit (Dashboard -> Project Settings ->
-- Storage) must be at least 250MB first, or these updates are refused.
-- project-images (creatives, videos) has no bucket limit and follows the
-- project-wide one.
update storage.buckets set file_size_limit = 262144000 where id in ('brand-docs', 'project-briefs');
