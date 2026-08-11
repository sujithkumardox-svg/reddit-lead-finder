import "server-only";

import { evaluateGeminiEligibility } from "@/lib/matching/gemini-eligibility";
import type { GeminiEligibilityResult, QualificationReason } from "@/lib/matching/gemini-eligibility";
import type { OnboardingSearchTerms } from "@/lib/matching/matching-engine";
import { matchRedditScanResult } from "@/lib/matching/reddit-scan-matcher";
import type {
  MatchedRedditComment,
  MatchedRedditPost,
  RedditScanMatchingResult,
} from "@/lib/matching/reddit-scan-matcher";
import { enqueueCandidate } from "@/services/gemini-qualification-queue";
import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import type { EnqueueGeminiCandidateInput, GeminiQueueQualificationReason } from "@/types/gemini-qualification-queue";
import type { RedditScanResult, RedditScanResultHandler } from "@/types/reddit-scan";

/**
 * The pending Scanner -> Matching Engine connection.
 *
 * The Reddit Scanner (`services/reddit-scanner.ts`) stays independent of
 * the Matching Engine (`lib/matching/matching-engine.ts`) - it never
 * imports or calls `runMatchingEngine` directly. Instead it only knows
 * about the `RedditScanResultHandler` contract (`types/reddit-scan.ts`).
 * `RedditScanMatchingHandler` is the minimal adapter that implements that
 * contract and wires the two together:
 *
 *   1. `scanProjectReddit` calls `handleScanResult(result)` once the scan
 *      completes.
 *   2. This handler loads the project's onboarding terms itself, via the
 *      existing `getProjectScanData` (`services/projects.ts`) - the
 *      handler contract only carries scanned Reddit content, not terms, so
 *      they're loaded here rather than threaded through the contract.
 *   3. Those terms are mapped onto the Matching Engine's
 *      `OnboardingSearchTerms` shape (`mapProjectScanDataToOnboardingTerms`
 *      below), in the locked conceptual order: keywords, intent phrases,
 *      pain phrases, competitors, hidden keyword variations. That order
 *      only affects mapping/readability - it does not lower hidden keyword
 *      variations' matching importance (the Matching Engine treats every
 *      category as independently and fully as documented in
 *      `matching-engine.ts`).
 *   4. Every post (title + body combined) and every comment (body alone)
 *      is matched via `matchRedditScanResult`
 *      (`lib/matching/reddit-scan-matcher.ts`).
 *   5. Every matched post/comment is run through Phase 8's
 *      `evaluateGeminiEligibility` (`lib/matching/gemini-eligibility.ts`).
 *      Candidates with `qualifiesForGemini: true` are immediately persisted
 *      to the `gemini_qualification_queue` database table via
 *      `enqueueCandidate` (`services/gemini-qualification-queue.ts`) -
 *      BEFORE any future Gemini processing - so a crash after this point
 *      can never lose a qualifying candidate. Non-qualifying candidates are
 *      never enqueued. This handler never talks to Supabase directly for
 *      the queue; all persistence goes through that dedicated service. A
 *      genuine DB insertion error for one candidate is caught and logged
 *      (not retried) rather than aborting the rest of the scan's
 *      candidates - see `safelyEnqueueCandidate` below.
 *
 * `scanProjectReddit`'s return type (`Promise<RedditScanResult>`) is left
 * untouched - the collected Matching Engine results are exposed
 * separately, via `getMatchingResult()`, after the scan completes:
 *
 * ```ts
 * const handler = new RedditScanMatchingHandler(userId);
 * const scanResult = await scanProjectReddit(userId, projectId, handler);
 * const matchingResult = handler.getMatchingResult();
 * ```
 *
 * Deliberately out of scope here (see task spec): calling the Gemini API
 * (or any fallback AI provider), a Gemini worker/retry loop, persisting
 * anything to `reddit_leads` or the Leads UI, and scan scheduling.
 */
export class RedditScanMatchingHandler implements RedditScanResultHandler {
  private readonly userId: string;
  private matchingResult: RedditScanMatchingResult | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  async handleScanResult(result: RedditScanResult): Promise<void> {
    const scanData = await getProjectScanData(this.userId, result.projectId);
    if (!scanData) {
      throw new Error("Project not found.");
    }

    const terms = mapProjectScanDataToOnboardingTerms(scanData);
    this.matchingResult = matchRedditScanResult(result, terms);

    await enqueueGeminiEligibleCandidates(this.userId, result.projectId, this.matchingResult);
  }

  /**
   * Every post's and comment's Matching Engine result from the most
   * recently handled scan. `null` until `handleScanResult` has run at
   * least once.
   */
  getMatchingResult(): RedditScanMatchingResult | null {
    return this.matchingResult;
  }
}

/**
 * Maps a project's onboarding search data (`ProjectScanData`, from
 * `getProjectScanData`) onto the Matching Engine's `OnboardingSearchTerms`
 * shape. `hiddenKeywords` (the Scanner/DB name) becomes
 * `hiddenKeywordVariations` (the Matching Engine's name) - every other
 * category is a direct, unmodified pass-through of the same array.
 */
export function mapProjectScanDataToOnboardingTerms(scanData: ProjectScanData): OnboardingSearchTerms {
  return {
    keywords: scanData.keywords,
    intentPhrases: scanData.intentPhrases,
    painPhrases: scanData.painPhrases,
    competitors: scanData.competitors,
    hiddenKeywordVariations: scanData.hiddenKeywords,
  };
}

/**
 * Runs Phase 8 eligibility over every matched post/comment and persists
 * the Gemini-eligible ones to the database queue. Each candidate is
 * enqueued independently via `safelyEnqueueCandidate` - one candidate
 * failing to persist never stops the rest from being evaluated/queued,
 * since a scan should surface as many crash-safe candidates as possible.
 */
async function enqueueGeminiEligibleCandidates(
  userId: string,
  projectId: string,
  matchingResult: RedditScanMatchingResult,
): Promise<void> {
  for (const matchedPost of matchingResult.posts) {
    const eligibility = evaluateGeminiEligibility(matchedPost.result);
    if (!eligibility.qualifiesForGemini) {
      continue;
    }
    await safelyEnqueueCandidate(buildPostCandidateInput(userId, projectId, matchedPost, eligibility));
  }

  for (const matchedComment of matchingResult.comments) {
    const eligibility = evaluateGeminiEligibility(matchedComment.result);
    if (!eligibility.qualifiesForGemini) {
      continue;
    }
    await safelyEnqueueCandidate(buildCommentCandidateInput(userId, projectId, matchedComment, eligibility));
  }
}

/**
 * Calls `enqueueCandidate` and swallows any error it throws, logging it
 * instead. `enqueueCandidate` already treats a duplicate (Postgres `23505`)
 * as an expected, non-throwing outcome on its own - that handling is
 * untouched and lives entirely in `services/gemini-qualification-queue.ts`.
 * This wrapper only guards against a *genuine* DB insertion error (e.g. a
 * connectivity or permissions failure), so that one candidate's failure
 * can never abort the rest of the scan's candidates. Never retried here -
 * a single attempt per candidate per scan.
 */
async function safelyEnqueueCandidate(input: EnqueueGeminiCandidateInput): Promise<void> {
  try {
    await enqueueCandidate(input);
  } catch (error) {
    console.error(
      `[reddit-scan-matching-handler] Failed to queue Gemini candidate ${input.redditItemId} for project ${input.projectId}:`,
      error,
    );
  }
}

/** Only ever called for a candidate with `qualifiesForGemini: true`, so the reason can never be `"below_threshold"`. */
function toQueueQualificationReason(reason: QualificationReason): GeminiQueueQualificationReason {
  if (reason === "below_threshold") {
    throw new Error("Cannot queue a candidate that did not qualify for Gemini.");
  }
  return reason;
}

function buildPostCandidateInput(
  userId: string,
  projectId: string,
  matchedPost: MatchedRedditPost,
  eligibility: GeminiEligibilityResult,
): EnqueueGeminiCandidateInput {
  const { post } = matchedPost;

  return {
    projectId,
    userId,
    redditItemId: post.id,
    itemType: "post",
    parentPostId: null,
    subreddit: post.subreddit,
    title: post.title,
    body: post.body,
    matchedText: matchedPost.text,
    author: post.author,
    permalink: post.permalink,
    redditScore: post.score,
    itemCreatedAt: post.createdAt,
    matchedTerms: matchedPost.result,
    numericalScore: eligibility.numericalScore,
    diversityBonus: eligibility.diversityBonus,
    finalScore: eligibility.finalScore,
    qualificationReason: toQueueQualificationReason(eligibility.qualificationReason),
  };
}

function buildCommentCandidateInput(
  userId: string,
  projectId: string,
  matchedComment: MatchedRedditComment,
  eligibility: GeminiEligibilityResult,
): EnqueueGeminiCandidateInput {
  const { comment } = matchedComment;

  return {
    projectId,
    userId,
    redditItemId: comment.id,
    itemType: "comment",
    parentPostId: comment.postId,
    subreddit: comment.subreddit,
    title: null,
    body: comment.body,
    matchedText: matchedComment.text,
    author: comment.author,
    permalink: comment.permalink,
    redditScore: comment.score,
    itemCreatedAt: comment.createdAt,
    matchedTerms: matchedComment.result,
    numericalScore: eligibility.numericalScore,
    diversityBonus: eligibility.diversityBonus,
    finalScore: eligibility.finalScore,
    qualificationReason: toQueueQualificationReason(eligibility.qualificationReason),
  };
}
