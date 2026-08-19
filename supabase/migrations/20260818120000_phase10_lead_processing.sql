-- ============================================================================
-- Phase 10: Lead Processing
--
-- Persists Gemini-qualified (ai_qualified = true) rows from
-- `gemini_qualification_queue` into `reddit_leads` - the final,
-- customer-facing qualified lead table Phase 11's dashboard will read.
-- Does not touch Phase 8 eligibility scoring or Phase 9 qualification
-- logic in any way; only adds storage for data that logic already
-- produces (plus two small upstream capture columns on the queue: author
-- fullname and comment count) and a new rule-based subreddit safety badge.
--
-- Two parts:
--   1. `gemini_qualification_queue` - additive only. `author_id` and
--      `num_comments` are captured at enqueue time (Phase 8) so they are
--      available on the row when Phase 10 later persists it to
--      `reddit_leads`. `ai_possible_competitor_reason` is Gemini's (Phase
--      9B) explanation of why `ai_possible_competitor` was flagged -
--      additive alongside the existing, untouched `ai_*` result fields.
--   2. `reddit_leads` - extended in place to support posts AND comments,
--      the full AI qualification result, engagement, author, and a
--      subreddit safety badge/explanation.
--
-- LOCKED per the approved Phase 10 plan: `reddit_leads`'s legacy Phase 5
-- columns (`reddit_post_id`, `matched_keywords`, `url`, `post_created_at`)
-- are KEPT for compatibility, not dropped. They are simply no longer
-- populated by Phase 10 onward - `reddit_item_id`, `permalink`, and
-- `item_created_at` are their Phase 10 replacements. The pre-existing
-- `reddit_leads_project_post_unique` constraint on `(project_id,
-- reddit_post_id)` is left untouched: since `reddit_post_id` is always
-- null on every Phase 10 row, and Postgres treats every null as distinct
-- from every other null for uniqueness purposes, that legacy constraint
-- can never be violated by new rows.
-- ============================================================================

alter table public.gemini_qualification_queue
  add column author_id text,
  add column num_comments integer,
  add column ai_possible_competitor_reason text;

comment on column public.gemini_qualification_queue.author_id is
  'Reddit author fullname (t2_...), captured alongside the display username (author). Null when Reddit does not report one (e.g. a deleted author).';

comment on column public.gemini_qualification_queue.num_comments is
  'Reddit comment count. Posts only - always null for comments, which have no such metric.';

comment on column public.gemini_qualification_queue.ai_possible_competitor_reason is
  'Phase 10: Gemini''s explanation of specifically why ai_possible_competitor was flagged, independent of ai_match_reason (which explains the overall aiMatchType/aiScore classification). Null whenever ai_possible_competitor is null.';

alter table public.reddit_leads
  -- Comments have no title, and Phase 10 never populates the legacy
  -- reddit_post_id column - both must become nullable to allow that.
  alter column title drop not null,
  alter column reddit_post_id drop not null,
  add column reddit_item_id text not null,
  add column item_type text not null,
  add column parent_post_id text,
  add column permalink text not null,
  add column item_created_at timestamptz not null,
  add column author_id text,
  add column num_comments integer,
  add column ai_score integer not null,
  add column ai_match_type text not null,
  add column ai_lead_summary text not null,
  add column ai_match_reason text not null,
  add column ai_possible_competitor text,
  add column ai_possible_competitor_reason text,
  add column safety_badge text,
  add column safety_explanation text,
  add constraint reddit_leads_project_reddit_item_unique unique (project_id, reddit_item_id),
  add constraint reddit_leads_item_type_check check (item_type in ('post', 'comment')),
  add constraint reddit_leads_safety_badge_check check (
    safety_badge is null or safety_badge in ('without_rules', 'promo_conditional', 'promo_not_safe')
  );

comment on column public.reddit_leads.reddit_post_id is
  'Deprecated Phase 5 column, kept for compatibility. Not populated by Phase 10 onward - use reddit_item_id (which covers both posts and comments) instead.';

comment on column public.reddit_leads.matched_keywords is
  'Deprecated Phase 5 column, kept for compatibility. Not populated by Phase 10 onward.';

comment on column public.reddit_leads.url is
  'Deprecated Phase 5 column, kept for compatibility. Not populated by Phase 10 onward - use permalink instead.';

comment on column public.reddit_leads.post_created_at is
  'Deprecated Phase 5 column, kept for compatibility. Not populated by Phase 10 onward - use item_created_at instead.';

comment on column public.reddit_leads.reddit_item_id is
  'Reddit fullname: t3_... for posts, t1_... for comments. Phase 10 dedup key together with project_id - mirrors gemini_qualification_queue.reddit_item_id.';

comment on column public.reddit_leads.item_type is 'post or comment.';

comment on column public.reddit_leads.parent_post_id is 'Fullname (t3_...) of the parent post. Comments only; null for posts.';

comment on column public.reddit_leads.permalink is 'Full clickable Reddit URL (https://www.reddit.com/...).';

comment on column public.reddit_leads.item_created_at is 'When the Reddit post/comment itself was created (not when this lead row was persisted).';

comment on column public.reddit_leads.author_id is 'Reddit author fullname (t2_...). Null when Reddit does not report one.';

comment on column public.reddit_leads.num_comments is 'Reddit comment count. Posts only - null for comments.';

comment on column public.reddit_leads.ai_score is 'AI-produced qualification score (Phase 9). Customer-facing. Unrelated to Phase 8''s internal score column above.';

comment on column public.reddit_leads.ai_match_type is 'AI''s classification of this lead. Taxonomy owned by the Phase 9 AI prompt/schema, not constrained at the database layer.';

comment on column public.reddit_leads.ai_lead_summary is 'AI-generated short summary of this lead, for customer-facing display.';

comment on column public.reddit_leads.ai_match_reason is 'AI''s explanation of why this candidate was classified/scored the way it was.';

comment on column public.reddit_leads.ai_possible_competitor is 'Competitor name the AI identified in this lead''s content, if any. Null when none identified.';

comment on column public.reddit_leads.ai_possible_competitor_reason is
  'AI''s explanation of specifically why ai_possible_competitor was flagged. Phase 11 must keep this hidden by default and show it only via a tooltip/interaction on the Possible Competitor badge - never displayed directly on the lead card.';

comment on column public.reddit_leads.safety_badge is
  'Rule-based subreddit safety classification: without_rules, promo_conditional, or promo_not_safe. Computed from the subreddit''s actual rules (see lib/safety/subreddit-safety.ts) - not an AI judgment.';

comment on column public.reddit_leads.safety_explanation is 'Free-text explanation of the subreddit rule(s) behind safety_badge, for display alongside the badge.';

comment on constraint reddit_leads_project_reddit_item_unique on public.reddit_leads is
  'Prevents the same Reddit post/comment being persisted as a lead twice for the same project. Project-scoped: the same Reddit item independently qualifying for a different project is not a duplicate.';

create index reddit_leads_project_item_created_idx on public.reddit_leads (project_id, item_created_at desc);
