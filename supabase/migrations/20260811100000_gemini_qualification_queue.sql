-- ============================================================================
-- Gemini Qualification Queue
--
-- Crash-safe persistence for Reddit posts/comments that Phase 8
-- (`lib/matching/gemini-eligibility.ts`) has determined qualify for Gemini
-- processing. Inserted immediately after `evaluateGeminiEligibility` returns
-- `qualifiesForGemini: true` - BEFORE any Gemini API call is ever made - so a
-- server crash after Phase 8 can never lose a qualifying candidate.
--
-- Deliberately separate from `reddit_leads`:
--   - `reddit_leads` has no concept of posts vs. comments, no Phase 8 score
--     fields, and its `status` models the user-facing lead lifecycle, not
--     the Gemini processing lifecycle.
--   - This table's `status` models ONLY the Gemini processing lifecycle
--     (pending -> processing -> completed/failed) and is never shown to
--     end users.
--
-- Out of scope here (future phases): the Gemini worker/API call itself, the
-- fallback AI provider, retry/backoff scheduling, and retention/cleanup of
-- completed/failed rows (kept indefinitely for now as an audit trail).
-- ============================================================================

create table public.gemini_qualification_queue (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Reddit fullname (t3_... for posts, t1_... for comments). Globally unique
  -- on Reddit's side; unique per-project below to allow the same Reddit item
  -- to be queued independently for two different projects.
  reddit_item_id text not null,
  item_type text not null,
  -- Fullname (t3_...) of the parent post. Comments only.
  parent_post_id text,
  subreddit text not null,
  -- Posts only. Comments have no title.
  title text,
  body text not null,
  -- The exact text Phase 7's Matching Engine matched against: post
  -- title+body combined, or the comment body alone.
  matched_text text not null,
  author text not null,
  permalink text not null,
  reddit_score integer not null default 0,
  item_created_at timestamptz not null,

  -- Complete `MatchingEngineResult` (keywords, intentPhrases, painPhrases,
  -- competitors, hiddenKeywordVariations - each a MatchedTerm[]) as JSONB,
  -- rather than separate columns per matching category.
  matched_terms jsonb not null,

  -- Phase 8 (`evaluateGeminiEligibility`) result.
  numerical_score integer not null,
  diversity_bonus integer not null,
  final_score integer not null,
  qualification_reason text not null,

  -- Gemini processing lifecycle - distinct from any user-facing lead status.
  status text not null default 'pending',
  -- Set when a worker claims this row (pending -> processing); cleared when
  -- a stale claim is recovered back to pending. Combined with a visibility
  -- timeout, this lets a recovery process identify rows abandoned by a
  -- crashed worker/server and reset them to pending without losing them.
  processing_started_at timestamptz,
  attempt_count integer not null default 0,
  error_message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gemini_qualification_queue_project_reddit_item_unique unique (project_id, reddit_item_id),
  constraint gemini_qualification_queue_item_type_check check (item_type in ('post', 'comment')),
  constraint gemini_qualification_queue_qualification_reason_check check (
    qualification_reason in ('intent_or_pain', 'score_threshold')
  ),
  constraint gemini_qualification_queue_status_check check (
    status in ('pending', 'processing', 'completed', 'failed')
  ),
  constraint gemini_qualification_queue_attempt_count_check check (attempt_count >= 0),
  -- Enforces "title nullable, posts only" / "parent_post_id nullable,
  -- comments only" from the item_type each row actually has.
  constraint gemini_qualification_queue_item_type_shape_check check (
    (item_type = 'post' and parent_post_id is null and title is not null)
    or
    (item_type = 'comment' and parent_post_id is not null and title is null)
  )
);

comment on table public.gemini_qualification_queue is 'Phase 8-qualified Reddit posts/comments queued for future Gemini processing. Processing/audit table - never deletes rows, distinct lifecycle from reddit_leads.';
comment on constraint gemini_qualification_queue_project_reddit_item_unique on public.gemini_qualification_queue is 'Prevents the same Reddit post/comment being queued twice for the same project; a 23505 violation here is treated as an expected "already queued" outcome, not an error.';
comment on column public.gemini_qualification_queue.matched_terms is 'Complete MatchingEngineResult (keywords, intentPhrases, painPhrases, competitors, hiddenKeywordVariations) for this candidate, as JSONB.';
comment on column public.gemini_qualification_queue.processing_started_at is 'Set when a worker claims this row (status -> processing). A recovery process compares this against a visibility timeout to reset abandoned claims back to pending.';

create index gemini_qualification_queue_project_id_idx on public.gemini_qualification_queue (project_id);
create index gemini_qualification_queue_user_id_idx on public.gemini_qualification_queue (user_id);
create index gemini_qualification_queue_status_idx on public.gemini_qualification_queue (status);
create index gemini_qualification_queue_project_status_idx on public.gemini_qualification_queue (project_id, status);
-- Supports the stale-processing recovery scan (status = 'processing' and processing_started_at < cutoff).
create index gemini_qualification_queue_status_processing_started_idx
  on public.gemini_qualification_queue (status, processing_started_at);

create trigger set_gemini_qualification_queue_updated_at
  before update on public.gemini_qualification_queue
  for each row
  execute function public.set_updated_at();

alter table public.gemini_qualification_queue enable row level security;

create policy gemini_qualification_queue_select_own
  on public.gemini_qualification_queue for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy gemini_qualification_queue_insert_own
  on public.gemini_qualification_queue for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy gemini_qualification_queue_update_own
  on public.gemini_qualification_queue for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy gemini_qualification_queue_delete_own
  on public.gemini_qualification_queue for delete
  to authenticated
  using ((select auth.uid()) = user_id);
