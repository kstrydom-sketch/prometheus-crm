-- Raise the brand-docs upload ceiling from 50MB to 100MB, for PDF brand books.
--
-- Print-ready brand books with full-bleed photography pass 50MB. The app keeps
-- other file types at 50MB (src/lib/brand-docs.ts maxBrandDocBytes); the
-- bucket's limit is per bucket, so it carries the higher PDF ceiling.
--
-- PREREQUISITE: Supabase's project-wide upload limit (Dashboard -> Project
-- Settings -> Storage -> Upload file size limit) must be at least 100MB. Below
-- that, Storage refuses both this bucket setting and any file over the global
-- limit — checked 15 Oct: updateBucket to 100MB was refused at a 50MB global.
--
-- Safe to re-run.

update storage.buckets
set file_size_limit = 104857600
where id = 'brand-docs';
