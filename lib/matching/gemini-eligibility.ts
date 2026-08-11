import type { MatchingEngineResult } from "@/lib/matching/matching-engine";

/**
 * Gemini eligibility / keyword scoring (Phase 8).
 *
 * One decision module with TWO qualification paths, evaluated over a
 * SINGLE `MatchingEngineResult` (i.e. one scanned post's or one scanned
 * comment's already-matched terms - see `lib/matching/reddit-scan-matcher.ts`
 * for how each post/comment gets its own `MatchingEngineResult`):
 *
 *   PATH 1 - Intent/Pain direct trigger (highest priority, evaluated
 *     first): if at least one distinct intent phrase OR at least one
 *     distinct pain phrase matched, the candidate is Gemini-eligible
 *     outright. The numerical score is still computed (callers may find
 *     it useful for sorting/inspection) but it can NEVER be used to
 *     reject a candidate that has an intent/pain match.
 *
 *   PATH 2 - Numerical keyword scoring fallback, only used when there is
 *     NO intent/pain match: main keywords, competitors, and hidden
 *     keyword variations each contribute fixed points per distinct
 *     matched term (see the `*_MATCH_POINTS` constants below), plus a
 *     diversity bonus based on how many of those three categories have
 *     at least one match (see `DIVERSITY_BONUS_BY_CATEGORY_COUNT`). The
 *     candidate qualifies if the resulting total meets
 *     `GEMINI_SCORE_THRESHOLD`.
 *
 * This module does not modify or re-implement anything the Matching
 * Engine does - it only reads `MatchingEngineResult`, whose arrays are
 * already guaranteed (by `matching-engine.ts` and the individual matcher
 * modules it orchestrates) to contain each distinct matched term at most
 * once, no matter how many times that term occurs in the source text. No
 * further deduplication happens here - `result.<category>.length` IS the
 * distinct-match count.
 *
 * Pure function, no I/O: no database, Reddit API, Gemini API, or network
 * calls, and no side effects. Deliberately out of scope for Phase 8 (see
 * task spec): calling Gemini itself, the temporary database queue,
 * triggering the Scanner, and scheduling.
 */

/** Points awarded per distinct matched main keyword. */
const KEYWORD_MATCH_POINTS = 10;

/** Points awarded per distinct matched competitor. */
const COMPETITOR_MATCH_POINTS = 12;

/** Points awarded per distinct matched hidden keyword variation. */
const HIDDEN_KEYWORD_VARIATION_MATCH_POINTS = 10;

/**
 * Bonus awarded based on how many of the three numerical categories
 * (keywords, competitors, hiddenKeywordVariations) have at least one
 * match - NOT based on how many individual matches there are. There is
 * no separate "keyword variation" bucket in the current architecture, so
 * three is the maximum number of categories and +10 the maximum bonus.
 */
const DIVERSITY_BONUS_BY_CATEGORY_COUNT: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  2: 5,
  3: 10,
};

/**
 * Locked MVP Gemini threshold. Candidates with no intent/pain match only
 * qualify when `numericalScore + diversityBonus >= GEMINI_SCORE_THRESHOLD`.
 */
const GEMINI_SCORE_THRESHOLD = 25;

/** Why a candidate did or didn't qualify for Gemini. */
export type QualificationReason = "intent_or_pain" | "score_threshold" | "below_threshold";

/**
 * Everything later phases (the future database queue, Gemini
 * qualification step, etc.) need to know about one post's or comment's
 * Gemini eligibility.
 */
export type GeminiEligibilityResult = {
  /** Sum of `*_MATCH_POINTS` across keywords, competitors, and hidden keyword variations. Always computed, even on the Intent/Pain path. */
  numericalScore: number;
  /** How many of {keywords, competitors, hiddenKeywordVariations} have at least one match (0-3). */
  diversityCategoryCount: number;
  /** Bonus from `DIVERSITY_BONUS_BY_CATEGORY_COUNT` for `diversityCategoryCount`. */
  diversityBonus: number;
  /** `numericalScore + diversityBonus` - what gets compared against `GEMINI_SCORE_THRESHOLD` on Path 2. */
  finalScore: number;
  qualifiesForGemini: boolean;
  qualificationReason: QualificationReason;
};

/**
 * Sum of fixed per-category points across keywords, competitors, and
 * hidden keyword variations. Each array's `.length` is already the
 * distinct-match count - the Matching Engine guarantees no term is ever
 * repeated within a category.
 */
function calculateNumericalScore(result: MatchingEngineResult): number {
  return (
    result.keywords.length * KEYWORD_MATCH_POINTS +
    result.competitors.length * COMPETITOR_MATCH_POINTS +
    result.hiddenKeywordVariations.length * HIDDEN_KEYWORD_VARIATION_MATCH_POINTS
  );
}

/**
 * Counts how many of the three numerical categories have at least one
 * match - never how many individual matches exist across them.
 */
function countDiversityCategories(result: MatchingEngineResult): number {
  return [result.keywords, result.competitors, result.hiddenKeywordVariations].filter(
    (categoryMatches) => categoryMatches.length > 0,
  ).length;
}

/**
 * Evaluates Gemini eligibility for one `MatchingEngineResult` (one
 * post's or one comment's matches).
 *
 * PATH 1 (checked first): any intent phrase or pain phrase match makes
 * this an unconditional `qualifiesForGemini: true` with reason
 * `"intent_or_pain"` - the numerical score is computed for visibility but
 * never used to reject.
 *
 * PATH 2 (only reached when there is no intent/pain match): qualifies
 * when `finalScore >= GEMINI_SCORE_THRESHOLD`, with reason
 * `"score_threshold"` when it qualifies or `"below_threshold"` when it
 * doesn't.
 */
export function evaluateGeminiEligibility(result: MatchingEngineResult): GeminiEligibilityResult {
  const numericalScore = calculateNumericalScore(result);
  const diversityCategoryCount = countDiversityCategories(result);
  const diversityBonus = DIVERSITY_BONUS_BY_CATEGORY_COUNT[diversityCategoryCount] ?? 0;
  const finalScore = numericalScore + diversityBonus;

  const hasIntentOrPainMatch = result.intentPhrases.length > 0 || result.painPhrases.length > 0;

  if (hasIntentOrPainMatch) {
    return {
      numericalScore,
      diversityCategoryCount,
      diversityBonus,
      finalScore,
      qualifiesForGemini: true,
      qualificationReason: "intent_or_pain",
    };
  }

  const qualifiesForGemini = finalScore >= GEMINI_SCORE_THRESHOLD;

  return {
    numericalScore,
    diversityCategoryCount,
    diversityBonus,
    finalScore,
    qualifiesForGemini,
    qualificationReason: qualifiesForGemini ? "score_threshold" : "below_threshold",
  };
}
