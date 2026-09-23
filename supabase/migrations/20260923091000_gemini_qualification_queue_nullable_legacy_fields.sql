-- ============================================================================
-- Gemini Qualification Queue: Make Legacy OLD Phase 7/8 Columns Nullable
--
-- `gemini_qualification_queue` was created (`20260811100000_...`) when the
-- only thing that could ever enqueue a candidate was the OLD Phase 7
-- keyword matcher (`lib/matching/reddit-scan-matcher.ts`) feeding OLD
-- Phase 8 keyword scoring (`lib/matching/gemini-eligibility.ts`), so five
-- columns were made `not null` (four of them also `jsonb`/integer, one
-- with a CHECK constraint):
--
--   - matched_terms       (OLD Phase 7's complete MatchingEngineResult)
--   - numerical_score     (OLD Phase 8's keyword point total)
--   - diversity_bonus     (OLD Phase 8's category-diversity bonus)
--   - final_score         (OLD Phase 8's numerical_score + diversity_bonus)
--   - qualification_reason (OLD Phase 8's 'intent_or_pain' | 'score_threshold')
--
-- NEW Phase 7 (`services/reddit-phase7-relevance-filter.ts`) enqueues a
-- `LEAD` candidate directly from a raw Reddit post plus a lightweight AI
-- verdict - it never runs the OLD keyword matcher or OLD keyword scoring,
-- so it has no real matched terms, no real keyword score, and no real
-- OLD Phase 8 qualification reason to report. Per the approved plan, NEW
-- Phase 7 must never fabricate fake keyword matches, fake scores, or fake
-- qualification reasons just to satisfy an old schema requirement - so
-- these five columns must become nullable.
--
-- This is purely additive/relaxing:
--   - No column is dropped or renamed.
--   - No existing row's data changes (every row enqueued by the OLD
--     Phase 7/8 path already has non-null values here and is completely
--     unaffected).
--   - `qualification_reason`'s CHECK constraint keeps its exact existing
--     two allowed values (`'intent_or_pain'`, `'score_threshold'`) -
--     only `NULL` is newly permitted alongside them, which is the minimum
--     change required by PostgreSQL semantics for a CHECK constraint to
--     remain satisfied by a null value.
--   - Phase 9 (`lib/ai/qualify-reddit-candidate.ts`,
--     `lib/ai/providers/gemini-qualification-provider.ts`,
--     `services/gemini-qualification-worker.ts`) already never reads any
--     of these five columns for its qualification decision (Phase 9B-1
--     deliberately excludes matchedTerms/numericalScore/diversityBonus/
--     finalScore/qualificationReason from what is sent to Gemini) - so
--     this change has zero effect on Phase 9's business logic, prompts,
--     scoring, or enrichment behavior.
--   - The `gemini_qualification_queue_item_type_shape_check` constraint
--     (title/parent_post_id shape per item_type) is untouched and still
--     fully enforced.
-- ============================================================================

alter table public.gemini_qualification_queue
  alter column matched_terms drop not null;

alter table public.gemini_qualification_queue
  alter column numerical_score drop not null;

alter table public.gemini_qualification_queue
  alter column diversity_bonus drop not null;

alter table public.gemini_qualification_queue
  alter column final_score drop not null;

alter table public.gemini_qualification_queue
  alter column qualification_reason drop not null;

alter table public.gemini_qualification_queue
  drop constraint gemini_qualification_queue_qualification_reason_check;

alter table public.gemini_qualification_queue
  add constraint gemini_qualification_queue_qualification_reason_check check (
    qualification_reason is null or qualification_reason in ('intent_or_pain', 'score_threshold')
  );

comment on column public.gemini_qualification_queue.matched_terms is 'Complete MatchingEngineResult (keywords, intentPhrases, painPhrases, competitors, hiddenKeywordVariations) for this candidate, as JSONB - only ever populated by the OLD Phase 7 keyword matcher. Null for candidates enqueued by NEW Phase 7 (the lightweight AI relevance filter), which never runs keyword matching and must never fabricate a fake matched_terms value.';
comment on column public.gemini_qualification_queue.qualification_reason is 'Why this candidate qualified per OLD Phase 8 keyword scoring (intent_or_pain or score_threshold) - only ever populated by that OLD path. Null for candidates enqueued by NEW Phase 7, which decides LEAD/NOT_A_LEAD via a lightweight AI verdict, not OLD Phase 8 scoring, and must never fabricate a fake reason.';
