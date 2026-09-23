-- ============================================================================
-- Reddit Phase 7 Processing: Atomic Claim / In-Flight Processing Support
--
-- Prompt 1 (`20260920100000_reddit_phase7_processing.sql`) created
-- `reddit_phase7_processing` with only a terminal `outcome`
-- (`lead`/`not_a_lead`) and its authoritative `(project_id,
-- reddit_item_id)` uniqueness constraint. That is insufficient for safe
-- concurrent workers: two workers could both pass the "not yet processed"
-- check and both call the lightweight AI provider before the unique
-- constraint ever rejects one of their inserts - so the AI could be
-- called twice for the same Reddit post/project, and a transient AI
-- failure had nowhere durable to be recorded without either fabricating a
-- terminal outcome or losing the row.
--
-- This migration ADDITIVELY closes that gap by giving this table an
-- explicit in-flight "claim" state, following the same
-- pending/processing/completed shape already proven by
-- `gemini_qualification_queue` (Phase 9's queue) - adapted for Phase 7's
-- simpler shape, where the row itself (guarded by the existing unique
-- constraint) IS the claim, so there is no separate "pending" status:
--
--   - INSERT with status = 'processing', outcome = null -> the insert
--     either succeeds (this caller now atomically owns the claim) or hits
--     the existing `reddit_phase7_processing_project_reddit_item_unique`
--     constraint (someone else already has - or already finished - this
--     exact (project_id, reddit_item_id) pair).
--   - status = 'completed' -> terminal `outcome` (`lead`/`not_a_lead`) is
--     set; never reclaimed again.
--   - status = 'processing' with a stale `processing_started_at` (older
--     than the caller's visibility timeout) -> safely reclaimable via a
--     guarded UPDATE (see `services/reddit-phase7-processing.ts`'s
--     `claimPhase7Processing`), incrementing `attempt_count` - never a
--     second inserted row for the same pair.
--   - `last_error`/`last_error_at` durably record why the most recent
--     attempt did not reach a terminal outcome, without ever flipping
--     `status` to `completed` or fabricating an `outcome` - a row that
--     never successfully got an AI answer simply stays `processing` and
--     remains retryable/reclaimable.
--
-- The database's `(project_id, reddit_item_id)` uniqueness constraint
-- remains the sole source of truth for "has this pair already been
-- claimed" - it is NOT touched, weakened, or replaced by this migration.
-- No new table is created; no existing row is deleted; every row Prompt 1
-- already wrote (all of which have a non-null terminal `outcome`) is
-- backward-safely represented as `status = 'completed'` by this
-- migration's column default below, with no data migration/backfill
-- statement required.
--
-- Out of scope here (this is a schema-only migration): the AI
-- provider/prompt, the Phase 7 orchestrator, and the scan pipeline wiring
-- - all implemented in application code that uses this schema, not here.
-- ============================================================================

-- `outcome` must become nullable: a freshly claimed, still-`processing`
-- row has no outcome yet. Its CHECK constraint is recreated to allow that.
alter table public.reddit_phase7_processing
  alter column outcome drop not null;

alter table public.reddit_phase7_processing
  drop constraint reddit_phase7_processing_outcome_check;

alter table public.reddit_phase7_processing
  add constraint reddit_phase7_processing_outcome_check check (
    outcome is null or outcome in ('lead', 'not_a_lead')
  );

-- Explicit in-flight/processing lifecycle, distinct from `outcome` itself
-- (the same separation `gemini_qualification_queue.status` already makes
-- from its own `ai_qualified`). Every row Prompt 1 already inserted has a
-- non-null `outcome`, so defaulting new rows created by ALTER to
-- 'completed' is the correct, backward-safe representation for that
-- existing data with no explicit UPDATE needed.
alter table public.reddit_phase7_processing
  add column status text not null default 'completed';

alter table public.reddit_phase7_processing
  add constraint reddit_phase7_processing_status_check check (status in ('processing', 'completed'));

-- Enforces the two valid shapes: a completed row always has its terminal
-- outcome; a still-processing row never has one yet (no fabricated
-- outcome is ever possible at the database layer).
alter table public.reddit_phase7_processing
  add constraint reddit_phase7_processing_status_shape_check check (
    (status = 'completed' and outcome is not null)
    or
    (status = 'processing' and outcome is null)
  );

-- Set by `claimPhase7Processing` when a row is first claimed or a stale
-- claim is reclaimed. Compared against a visibility timeout to detect a
-- claim abandoned by a crashed/killed worker - the same convention
-- `gemini_qualification_queue.processing_started_at` already uses.
-- Nullable: historical Prompt 1 rows (status = 'completed' by the default
-- above) never had a claim in this sense, so they are left null.
alter table public.reddit_phase7_processing
  add column processing_started_at timestamptz;

-- How many times this exact (project_id, reddit_item_id) row has been
-- claimed (the initial claim counts as 1; each stale reclaim increments
-- it). Defaulting existing rows to 1 is accurate enough for Prompt 1 data
-- (each was written by exactly one successful attempt) without requiring
-- a real historical count no longer available.
alter table public.reddit_phase7_processing
  add column attempt_count integer not null default 1;

alter table public.reddit_phase7_processing
  add constraint reddit_phase7_processing_attempt_count_check check (attempt_count >= 0);

-- Diagnostic error information for the most recent attempt that did not
-- reach a terminal outcome (a transient AI failure, a malformed AI
-- response, etc.). Cleared whenever a row is (re)claimed or completed -
-- never left stale/misleading once cleared.
alter table public.reddit_phase7_processing
  add column last_error text;

alter table public.reddit_phase7_processing
  add column last_error_at timestamptz;

comment on column public.reddit_phase7_processing.status is 'Phase 7 in-flight lifecycle: processing (claimed, no terminal outcome yet - may be stale and safely reclaimable) or completed (terminal outcome set, never reclaimed again). Distinct from outcome itself, mirroring how gemini_qualification_queue.status is distinct from its ai_qualified.';
comment on column public.reddit_phase7_processing.processing_started_at is 'Set when a worker claims (or reclaims a stale claim on) this row. Compared against a visibility timeout to detect an abandoned claim, the same convention gemini_qualification_queue.processing_started_at already uses.';
comment on column public.reddit_phase7_processing.attempt_count is 'How many times this (project_id, reddit_item_id) row has been claimed. The initial claim is 1; each safe reclaim of a stale processing row increments it. Never creates a duplicate row - the existing unique constraint remains the sole dedup mechanism.';
comment on column public.reddit_phase7_processing.last_error is 'Diagnostic error message from the most recent attempt that did not reach a terminal outcome (transient AI failure, malformed AI output, etc.). Cleared on (re)claim and on completion. A non-null value here with status still processing means the row is retryable, not permanently stuck and not silently defaulted to any outcome.';
comment on column public.reddit_phase7_processing.last_error_at is 'When last_error was recorded. Null whenever last_error is null.';

-- Supports the stale-processing reclaim scan (status = 'processing' and
-- processing_started_at < cutoff) - the same index shape
-- gemini_qualification_queue already has for the analogous query.
create index reddit_phase7_processing_status_idx on public.reddit_phase7_processing (status);
create index reddit_phase7_processing_status_processing_started_idx
  on public.reddit_phase7_processing (status, processing_started_at);
