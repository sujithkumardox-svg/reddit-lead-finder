/**
 * Temporary Free-plan testing configuration for Reddit search volume.
 *
 * When `USE_FREE_PLAN_TEST_LIMITS=true`, the scanner slices its *search
 * input* per category before `buildSearchTerms()` runs. Stored project
 * rows, matching, scoring, and Gemini are untouched - this helper never
 * mutates its argument, and the default (flag unset/false) is a no-op
 * that returns the original object.
 *
 * `buildSearchTerms()` itself stays uncapped. This is a scan-time overlay
 * only, so production generation limits (UI + AI prompts) stay as they are.
 */

export const FREE_PLAN_TEST_LIMITS = {
  keywords: 10,
  intentPhrases: 8,
  painPhrases: 8,
  competitors: 5,
  hiddenKeywords: 8,
  subreddits: 4,
} as const;

export type FreePlanTestLimitSource = {
  keywords: string[];
  hiddenKeywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
  subreddits: string[];
};

export function isFreePlanTestLimitsEnabled(): boolean {
  return process.env.USE_FREE_PLAN_TEST_LIMITS === "true";
}

/**
 * Returns a per-category sliced copy of `source` when the Free-plan test
 * flag is on; otherwise returns `source` unchanged (same reference).
 * Never mutates the original arrays.
 */
export function applyFreePlanTestLimits<T extends FreePlanTestLimitSource>(source: T): T {
  if (!isFreePlanTestLimitsEnabled()) {
    return source;
  }

  return {
    ...source,
    keywords: source.keywords.slice(0, FREE_PLAN_TEST_LIMITS.keywords),
    intentPhrases: source.intentPhrases.slice(0, FREE_PLAN_TEST_LIMITS.intentPhrases),
    painPhrases: source.painPhrases.slice(0, FREE_PLAN_TEST_LIMITS.painPhrases),
    competitors: source.competitors.slice(0, FREE_PLAN_TEST_LIMITS.competitors),
    hiddenKeywords: source.hiddenKeywords.slice(0, FREE_PLAN_TEST_LIMITS.hiddenKeywords),
    subreddits: source.subreddits.slice(0, FREE_PLAN_TEST_LIMITS.subreddits),
  };
}
