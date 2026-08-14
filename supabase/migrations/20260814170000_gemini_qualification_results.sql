-- ============================================================================
-- Phase 9A: AI Qualification Results (schema only)
--
-- Adds the minimum columns needed to later store Phase 9 AI qualification
-- output and AI provenance on the existing `gemini_qualification_queue`
-- table. Purely additive - no table rename, no column drops, no
-- constraint/index/RLS changes, no new table.
--
-- Provider-neutral naming: Gemini is the current AI provider, but a
-- fallback/different provider may be used in the future. The table itself
-- keeps its existing name (`gemini_qualification_queue` - a Phase 8
-- decision, not revisited here), but every column added by THIS migration
-- uses an `ai_` prefix rather than `gemini_`, so a future fallback
-- provider's results are never mislabeled as Gemini's:
--   - `ai_qualified`, `ai_score`, `ai_match_type`, `ai_lead_summary`,
--     `ai_match_reason`, `ai_possible_competitor` are qualification RESULT
--     fields - whatever provider produced them.
--   - `ai_provider` / `ai_model` are PROVENANCE fields recording which
--     provider/model produced the result fields above (e.g. `'google'` /
--     `'gemini-3.5-flash'` today; a different value if a fallback provider
--     is ever used).
--
-- LOCKED ARCHITECTURE:
--   - `gemini_qualification_queue` remains THE Phase 9 processing queue.
--   - `reddit_leads` remains the final customer-facing qualified lead
--     source of truth. Not touched by this migration - a later phase is
--     responsible for writing AI-qualified candidates there.
--   - No separate AI-results table was created; results are stored on
--     this table per the locked design.
--   - `gemini_qualification_queue_project_reddit_item_unique` (project_id,
--     reddit_item_id) is untouched and still the sole dedup mechanism.
--   - Every Phase 8 column (numerical_score, diversity_bonus, final_score,
--     qualification_reason) and all Phase 8 logic are untouched. Phase 8's
--     `final_score` is an internal pre-AI gating score and must never be
--     confused with `ai_score` below, which is the AI's own, future,
--     customer-facing qualification score.
--   - No Target Customer/ICP column. No hidden keyword variation/subreddit
--     columns. Reddit content columns (title/body/matched_text/etc.) are
--     untouched - no trimming/truncation logic is introduced here.
--
-- Deliberately NOT added here:
--   - Any new processing-status or error column. `status`
--     ('pending'/'processing'/'completed'/'failed'), `error_message`,
--     `processing_started_at`, and `attempt_count` were already added by
--     the Phase 8 queue migration specifically to model "the Gemini
--     processing lifecycle" (see that migration's comments) - they already
--     cover AI processing status/error/attempt/timestamp needs, so
--     duplicating them here would just create confusing, redundant columns.
--     `ai_qualified` is a distinct concept from `status`: `status` says
--     whether the worker's call succeeded/failed; `ai_qualified` says
--     whether the AI's verdict was yes/no. A row can be `status =
--     'completed'` with `ai_qualified = false` (call succeeded, AI said
--     not a lead).
--   - Any CHECK constraint on `ai_match_type`: its taxonomy is owned by
--     the Phase 9 AI prompt/schema (a later phase, explicitly out of
--     scope for this schema-only change), not by the database.
--   - The AI service/worker/retry loop and any fallback AI provider
--     itself - `ai_provider`/`ai_model` are added now only as storage so
--     this table does not need another migration just to record which
--     provider/model produced a result once that phase is built.
-- ============================================================================

alter table public.gemini_qualification_queue
  add column ai_qualified boolean,
  add column ai_score integer,
  add column ai_match_type text,
  add column ai_lead_summary text,
  add column ai_match_reason text,
  add column ai_possible_competitor text,
  add column ai_provider text,
  add column ai_model text;

comment on column public.gemini_qualification_queue.ai_qualified is
  'Explicit AI qualification verdict for this candidate: true/false once processed. Null until a future AI worker processes this row. Distinct from status (worker call succeeded/failed) - a completed call can still resolve to false here.';

comment on column public.gemini_qualification_queue.ai_score is
  'AI-produced qualification score for this candidate. Customer-facing (future Leads UI). Not related to final_score (Phase 8''s internal pre-AI gating score) - the two must never be conflated. Null until a future AI worker processes this row.';

comment on column public.gemini_qualification_queue.ai_match_type is
  'AI''s classification of how this candidate relates to the project (e.g. direct lead, competitor mention, pain point). Taxonomy is owned by the Phase 9 AI prompt/schema, intentionally not constrained at the database layer.';

comment on column public.gemini_qualification_queue.ai_lead_summary is
  'AI-generated short summary of this candidate as a lead, for customer-facing display.';

comment on column public.gemini_qualification_queue.ai_match_reason is
  'AI''s explanation of why (or why not) this candidate qualifies, for customer-facing display.';

comment on column public.gemini_qualification_queue.ai_possible_competitor is
  'Competitor name the AI identified in this candidate''s content, if any. Null when none identified.';

comment on column public.gemini_qualification_queue.ai_provider is
  'AI provider that produced the ai_* result fields above (e.g. ''google''). Provenance only - the current provider is Gemini, but this column exists so a future fallback/different provider is never mislabeled.';

comment on column public.gemini_qualification_queue.ai_model is
  'AI model identifier that produced the ai_* result fields above (e.g. ''gemini-3.5-flash''). Provenance only.';
