/**
 * Per-run forensic funnel metrics persisted on `sync_logs.metrics`.
 * Counts and durations only - no post bodies, search terms, tokens, or
 * raw Reddit payloads.
 */

export type ScanSubredditMetricsStatus = "succeeded" | "failed";

export type ScanSubredditMetrics = {
  name: string;
  status: ScanSubredditMetricsStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  rawPosts: number;
  inWindowPosts: number;
  outOfWindowPosts: number;
  postsAfterDedupe: number;
  matchingCandidates: number;
  phase8Passed: number;
  queueInserted: number;
  qualifiedLeads: number;
};

export type ScanMetricsDurationsMs = {
  apifyTotal: number;
  filter: number;
  dedupe: number;
  /** OLD Phase 7 keyword matching duration. No longer accumulated by the live scan pipeline (NEW Phase 7 replaced this seam) - kept so historical `sync_logs.metrics` JSON and this type stay compatible; always `0` for new scans. */
  matching: number;
  /** OLD Phase 8 keyword scoring duration. No longer accumulated by the live scan pipeline - see `matching` above; always `0` for new scans. */
  phase8: number;
  queue: number;
  gemini: number;
  persist: number;
  /** NEW Phase 7 lightweight AI relevance filter duration (claim + AI call, excluding the Phase 9 handoff itself, which is tracked separately by `queue` above). */
  phase7: number;
  total: number;
};

/**
 * Complete per-run funnel report. All numeric fields are counters
 * (including *MatchTerms, which are distinct matched-term counts, not
 * the term strings themselves).
 */
export type ScanRunMetrics = {
  projectId: string;
  syncLogId: string;

  subredditsAttempted: number;
  subredditsSucceeded: number;
  subredditsFailed: number;

  rawPosts: number;
  inWindowPosts: number;
  outOfWindowPosts: number;

  postsAfterDedupe: number;
  duplicatesRemoved: number;

  /**
   * OLD Phase 7/8 counters below (`postsEnteringMatching` through
   * `phase8ScoreThreshold`) existed only for the OLD keyword
   * matching/scoring seam this scan no longer runs (NEW Phase 7 replaced
   * it - see `postsEnteringPhase7` and the `phase7*` counters). Left
   * defined (always `0` going forward) rather than removed, so historical
   * `sync_logs.metrics` JSON and this type stay compatible; not read by
   * any dashboard/UI code.
   */
  postsEnteringMatching: number;

  postsWithKeywordMatch: number;
  postsWithCompetitorMatch: number;
  postsWithHiddenMatch: number;
  postsWithIntentMatch: number;
  postsWithPainMatch: number;

  keywordMatchTerms: number;
  competitorMatchTerms: number;
  hiddenMatchTerms: number;
  intentMatchTerms: number;
  painMatchTerms: number;

  matchingCandidates: number;

  phase8Passed: number;
  phase8Failed: number;
  phase8IntentOrPain: number;
  phase8ScoreThreshold: number;

  /** How many scanned posts NEW Phase 7 (the lightweight AI relevance filter) evaluated this run. */
  postsEnteringPhase7: number;
  /** NEW Phase 7 verdicts: `LEAD` - handed off to the existing Phase 9 `enqueueCandidate()` path (see `queueInserted`/`queueDuplicateSkipped`/`queueInsertFailed` below for that outcome). */
  phase7Leads: number;
  /** NEW Phase 7 verdicts: `NOT_A_LEAD` - never reaches Phase 9. */
  phase7NotALead: number;
  /** Skipped because this `(project, reddit item)` pair already has a completed Phase 7 outcome (`lead` or `not_a_lead`) from a previous scan. */
  phase7DedupSkipped: number;
  /** Skipped because another (non-stale) worker currently owns the Phase 7 claim for this `(project, reddit item)` pair. */
  phase7ConcurrentSkipped: number;
  /** Claim failures, exhausted-retry AI failures, or persistence failures during Phase 7 - never counted as a `lead`/`not_a_lead` verdict. */
  phase7Errors: number;

  queueInserted: number;
  queueDuplicateSkipped: number;
  queueInsertFailed: number;

  geminiCallsPerformed: number;
  geminiDuplicateSkips: number;
  geminiErrors: number;

  strong8to10: number;
  partial6to7: number;
  notQualified0to5: number;
  qualified: number;

  leadsPersisted: number;
  persistFailed: number;

  leadsFound: number;

  durationsMs: ScanMetricsDurationsMs;

  subreddits: ScanSubredditMetrics[];
};
