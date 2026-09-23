import type { MatchingEngineResult } from "@/lib/matching/matching-engine";
import type { ScanRunMetrics, ScanSubredditMetrics } from "@/types/scan-metrics";

/** Zeroed in-memory accumulator for one scan run. */
export function createScanMetrics(projectId: string, syncLogId: string): ScanRunMetrics {
  return {
    projectId,
    syncLogId,

    subredditsAttempted: 0,
    subredditsSucceeded: 0,
    subredditsFailed: 0,

    rawPosts: 0,
    inWindowPosts: 0,
    outOfWindowPosts: 0,

    postsAfterDedupe: 0,
    duplicatesRemoved: 0,

    postsEnteringMatching: 0,

    postsWithKeywordMatch: 0,
    postsWithCompetitorMatch: 0,
    postsWithHiddenMatch: 0,
    postsWithIntentMatch: 0,
    postsWithPainMatch: 0,

    keywordMatchTerms: 0,
    competitorMatchTerms: 0,
    hiddenMatchTerms: 0,
    intentMatchTerms: 0,
    painMatchTerms: 0,

    matchingCandidates: 0,

    phase8Passed: 0,
    phase8Failed: 0,
    phase8IntentOrPain: 0,
    phase8ScoreThreshold: 0,

    postsEnteringPhase7: 0,
    phase7Leads: 0,
    phase7NotALead: 0,
    phase7DedupSkipped: 0,
    phase7ConcurrentSkipped: 0,
    phase7Errors: 0,

    queueInserted: 0,
    queueDuplicateSkipped: 0,
    queueInsertFailed: 0,

    geminiCallsPerformed: 0,
    geminiDuplicateSkips: 0,
    geminiErrors: 0,

    strong8to10: 0,
    partial6to7: 0,
    notQualified0to5: 0,
    qualified: 0,

    leadsPersisted: 0,
    persistFailed: 0,

    leadsFound: 0,

    durationsMs: {
      apifyTotal: 0,
      filter: 0,
      dedupe: 0,
      matching: 0,
      phase8: 0,
      queue: 0,
      gemini: 0,
      persist: 0,
      phase7: 0,
      total: 0,
    },

    subreddits: [],
  };
}

export function createSubredditMetrics(name: string, startedAt: string): ScanSubredditMetrics {
  return {
    name,
    status: "failed",
    startedAt,
    completedAt: null,
    durationMs: 0,
    rawPosts: 0,
    inWindowPosts: 0,
    outOfWindowPosts: 0,
    postsAfterDedupe: 0,
    matchingCandidates: 0,
    phase8Passed: 0,
    queueInserted: 0,
    qualifiedLeads: 0,
  };
}

export function findSubredditMetrics(
  metrics: ScanRunMetrics,
  name: string,
): ScanSubredditMetrics | undefined {
  return metrics.subreddits.find((entry) => entry.name === name);
}

/** True when the existing matching result has at least one match category. */
export function hasAnyMatchCategory(result: MatchingEngineResult): boolean {
  return (
    result.keywords.length > 0 ||
    result.intentPhrases.length > 0 ||
    result.painPhrases.length > 0 ||
    result.competitors.length > 0 ||
    result.hiddenKeywordVariations.length > 0
  );
}

/** Bucket an existing Gemini `aiScore` (0-10) without changing qualification. */
export function recordGeminiScoreBucket(metrics: ScanRunMetrics, aiScore: number): void {
  if (aiScore >= 8) {
    metrics.strong8to10++;
  } else if (aiScore >= 6) {
    metrics.partial6to7++;
  } else {
    metrics.notQualified0to5++;
  }
}
