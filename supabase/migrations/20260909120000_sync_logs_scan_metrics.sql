-- ============================================================================
-- Scan observability: per-run forensic metrics on sync_logs
--
-- Adds a single nullable JSONB column for the in-memory funnel report
-- written by runProjectScan on success or failure. Purely additive: no
-- other table, column, constraint, index, or RLS policy is changed.
-- error_message remains the user-facing failure string and is never used
-- to store metrics.
-- ============================================================================

alter table public.sync_logs
  add column metrics jsonb;

comment on column public.sync_logs.metrics is
  'Optional per-run forensic funnel metrics (counts, durations, per-subreddit breakdown). Written onto this same scan row; never stored in error_message.';
