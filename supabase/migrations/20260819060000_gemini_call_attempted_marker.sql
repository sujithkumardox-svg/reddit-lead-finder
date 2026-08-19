-- ============================================================================
-- Gemini Call Attempted Marker (crash-safety hardening)
--
-- Closes the remaining crash window identified in the duplicate-Gemini-call
-- audit: `recordGeminiResult` (added previously) only commits AFTER
-- `qualifyRedditCandidate` resolves, so a process crash/OOM/SIGKILL/deploy
-- restart between Gemini's HTTP response returning and that write
-- committing left no durable evidence that Gemini had already been called
-- for that candidate - `status` stayed 'processing' with every `ai_*`
-- column null, indistinguishable from "never even attempted", so
-- `recoverStaleProcessing` would reset the row to 'pending' and it could be
-- sent to Gemini a second time.
--
-- `gemini_call_attempted_at` is written by the worker IMMEDIATELY after
-- claiming a fresh candidate, BEFORE calling qualifyRedditCandidate/Gemini
-- at all (see services/gemini-qualification-worker.ts). It durably records
-- "a Gemini call is about to be attempted for this exact row" - one write
-- earlier than any Gemini response could ever exist - so a stale
-- `processing` row now falls into one of three cases:
--
--   - gemini_call_attempted_at IS NULL -> Gemini was provably never
--     invoked for this attempt -> safe for recoverStaleProcessing to
--     auto-reset back to 'pending' for a normal retry.
--   - gemini_call_attempted_at IS NOT NULL AND no ai_* result recorded ->
--     Gemini may already have been called (and even succeeded) before the
--     crash - the outcome is unknown. recoverStaleProcessing no longer
--     silently resets these to 'pending'; they are moved to the existing
--     'failed' status instead, with a distinct error_message flagging them
--     for manual review. 'failed' rows are never reclaimed by
--     claimNextPending or recoverStaleProcessing, so this is a safe, inert
--     terminal state - no new status value/CHECK constraint change needed.
--   - gemini_call_attempted_at IS NOT NULL AND an ai_* result IS recorded
--     -> a full result was already durably checkpointed by
--     recordGeminiResult -> still safe to auto-reset; the worker's
--     candidateAlreadyHasGeminiResult check reuses that result instead of
--     calling Gemini again.
--
-- Purely additive: no existing column, constraint, or index is changed or
-- dropped. Applies identically to posts and comments - nothing here reads
-- or depends on item_type.
-- ============================================================================

alter table public.gemini_qualification_queue
  add column gemini_call_attempted_at timestamptz;

comment on column public.gemini_qualification_queue.gemini_call_attempted_at is
  'Set immediately after claiming a fresh candidate, BEFORE ever invoking Gemini for it. Durable pre-call marker used by recoverStaleProcessing to distinguish "never attempted" (safe to auto-reset to pending) from "may have already been sent to Gemini" (never auto-reset - flagged failed for manual review instead) when a stale processing row has no recorded ai_* result.';
