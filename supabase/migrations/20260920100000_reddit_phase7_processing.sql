-- ============================================================================
-- Reddit Phase 7 Processing (Lightweight AI Relevance Filtering)
--
-- STORAGE/DEDUP FOUNDATION ONLY. This table is Phase 7's processing-history
-- record: it answers exactly one question - "has this project already run
-- this Reddit post through Phase 7?" - so a future Phase 7 worker never
-- re-sends the same (project, reddit post) pair to the lightweight AI on a
-- later scan. A 'not_a_lead' outcome counts as processed just as much as a
-- 'lead' outcome does.
--
-- Deliberately a NEW, dedicated table - NOT a repurposing of any existing
-- table:
--   - gemini_qualification_queue: Phase 9's crash-safe Gemini processing
--     queue (pending/processing/completed/failed lifecycle, full candidate
--     payload, AI qualification result columns). This table has none of
--     that - it is a minimal outcome record, untouched by this migration.
--   - reddit_leads: the customer-facing lead list. This table's outcome
--     can be 'not_a_lead', which is never customer-facing.
--   - Not a qualification/scoring/dashboard table: no score, no AI
--     reasoning, no candidate content is stored here - only the binary
--     Phase 7 verdict.
--
-- Out of scope here (future phases): the Phase 7 AI provider/prompt, the
-- Phase 7 orchestrator, and wiring this table into the Reddit scan
-- pipeline (services/reddit-scan-matching-handler.ts). This migration only
-- adds the table, its authoritative dedup constraint, its indexes, and its
-- RLS policies.
-- ============================================================================

create table public.reddit_phase7_processing (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Reddit fullname (t3_... for posts, t1_... for comments). Unique per
  -- project below - the same Reddit item is allowed to be processed
  -- independently by two different projects.
  reddit_item_id text not null,

  -- The Phase 7 verdict for this (project, reddit item) pair. This is the
  -- ONLY classification data stored here - no score, no AI reasoning, no
  -- candidate content.
  outcome text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Authoritative Phase 7 dedup mechanism - see comment below. Concurrent
  -- scans race safely on this: only one insert for the same pair can ever
  -- succeed, the loser gets a 23505 it treats as "already processed".
  constraint reddit_phase7_processing_project_reddit_item_unique unique (project_id, reddit_item_id),
  constraint reddit_phase7_processing_outcome_check check (outcome in ('lead', 'not_a_lead'))
);

comment on table public.reddit_phase7_processing is 'Phase 7 processing-history record: has this project already run this Reddit post through Phase 7, and with what outcome (lead / not_a_lead)? Not a lead table, not the Gemini queue, not a qualification/scoring table. Storage/dedup foundation only - no AI logic lives here.';
comment on constraint reddit_phase7_processing_project_reddit_item_unique on public.reddit_phase7_processing is 'Authoritative Phase 7 dedup key: prevents the same Reddit post/comment being processed twice for the same project. A 23505 violation here is treated as an expected "already processed" outcome, not an error - the same convention used by gemini_qualification_queue.';
comment on column public.reddit_phase7_processing.outcome is 'Phase 7 verdict for this (project_id, reddit_item_id) pair: lead or not_a_lead. Both outcomes count as "already processed" - a not_a_lead result must never be silently reprocessed.';

create index reddit_phase7_processing_project_id_idx on public.reddit_phase7_processing (project_id);
create index reddit_phase7_processing_user_id_idx on public.reddit_phase7_processing (user_id);
-- Supports a future Phase 9 handoff step that will need to find this
-- project's 'lead' outcomes.
create index reddit_phase7_processing_outcome_idx on public.reddit_phase7_processing (outcome);

create trigger set_reddit_phase7_processing_updated_at
  before update on public.reddit_phase7_processing
  for each row
  execute function public.set_updated_at();

alter table public.reddit_phase7_processing enable row level security;

create policy reddit_phase7_processing_select_own
  on public.reddit_phase7_processing for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy reddit_phase7_processing_insert_own
  on public.reddit_phase7_processing for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy reddit_phase7_processing_update_own
  on public.reddit_phase7_processing for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy reddit_phase7_processing_delete_own
  on public.reddit_phase7_processing for delete
  to authenticated
  using ((select auth.uid()) = user_id);
