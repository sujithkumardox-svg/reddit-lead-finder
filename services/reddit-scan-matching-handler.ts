import "server-only";

import type { OnboardingSearchTerms } from "@/lib/matching/matching-engine";
import { matchRedditScanResult } from "@/lib/matching/reddit-scan-matcher";
import type { RedditScanMatchingResult } from "@/lib/matching/reddit-scan-matcher";
import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
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
 * Deliberately out of scope here (see task spec): Gemini qualification,
 * final keyword scoring, the AI qualification queue, persisting anything
 * to the database, the Leads UI, and scan scheduling.
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
