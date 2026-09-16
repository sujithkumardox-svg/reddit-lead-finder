-- ============================================================================
-- TEMPORARY DIAGNOSTIC TABLE - NOT AN MVP FEATURE
--
-- Added solely to investigate the Leadverse zero-match incident: capture the
-- actual scraped Reddit post title/body text from one controlled 4-subreddit
-- test scan so it can be manually compared against the project's real stored
-- search terms (keywords, intent phrases, pain phrases, competitors, hidden
-- keyword variations).
--
-- This table is intentionally isolated from every existing MVP table and
-- pipeline stage:
--   - Never read by matching (`lib/matching/*`), Phase 8
--     (`lib/matching/gemini-eligibility.ts`), the Gemini worker
--     (`services/gemini-qualification-worker.ts`), lead persistence
--     (`services/reddit-leads.ts`), or any dashboard route/page.
--   - Not joined, referenced, or selected by any existing service.
--   - Written to only when `ENABLE_SCAN_POST_CAPTURE_DIAGNOSTIC=true`, a
--     brand-new env flag independent of every other flag in the codebase,
--     defaulting to OFF.
--
-- MUST BE DROPPED once the investigation concludes:
--   drop table if exists public.diagnostic_scraped_posts_temp;
-- along with removing `lib/reddit/diagnostic-post-capture.ts` and its single
-- call site in `services/reddit-scanner.ts`.
-- ============================================================================

create table public.diagnostic_scraped_posts_temp (
  id uuid primary key default gen_random_uuid(),
  -- Owner for RLS purposes only - no FK to keep this table fully decoupled
  -- and trivially droppable with no dependency risk.
  user_id uuid not null,
  project_id uuid not null,
  -- Correlates rows back to the specific sync_logs run, when available.
  sync_log_id uuid,
  subreddit text not null,
  -- RedditPostItem.id (Reddit fullname, e.g. t3_...).
  reddit_post_id text not null,
  title text not null,
  body text not null default '',
  -- RedditPostItem.createdAt (the Reddit post's own creation time).
  item_created_at timestamptz,
  captured_at timestamptz not null default now()
);

comment on table public.diagnostic_scraped_posts_temp is
  'TEMPORARY diagnostic-only capture of scraped Reddit post title/body text for the Leadverse zero-match investigation. Not part of the MVP. Never read by matching/Phase 8/Gemini/leads/dashboard. Must be dropped (with its capture helper and call site) once the investigation concludes.';

comment on column public.diagnostic_scraped_posts_temp.sync_log_id is
  'Correlates this diagnostic row to the sync_logs row for the run that captured it. No FK constraint - diagnostic-only, intentionally decoupled.';

alter table public.diagnostic_scraped_posts_temp enable row level security;

-- Minimal, owner-scoped policies only - no broad grants. No update/delete
-- policy is defined: cleanup happens via a service-role DELETE or the table
-- drop above, never through the application.
create policy diagnostic_scraped_posts_temp_select_own
  on public.diagnostic_scraped_posts_temp for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy diagnostic_scraped_posts_temp_insert_own
  on public.diagnostic_scraped_posts_temp for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
