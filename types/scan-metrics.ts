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
  matching: number;
  phase8: number;
  queue: number;
  gemini: number;
  persist: number;
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
