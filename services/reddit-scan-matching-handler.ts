import "server-only";

import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import { runPhase7RelevanceFilter } from "@/services/reddit-phase7-relevance-filter";
import type { Phase7ProjectContext } from "@/services/reddit-phase7-relevance-filter";
import type { RedditScanResult, RedditScanResultHandler } from "@/types/reddit-scan";
import type { ScanRunMetrics } from "@/types/scan-metrics";

/**
 * The Scanner -> NEW Phase 7 connection.
 *
 * The Reddit Scanner (`services/reddit-scanner.ts`) stays independent of
 * NEW Phase 7 (`services/reddit-phase7-relevance-filter.ts`) - it never
 * imports or calls it directly. Instead it only knows about the
 * `RedditScanResultHandler` contract (`types/reddit-scan.ts`).
 * `RedditScanMatchingHandler` is the minimal adapter that implements that
 * contract and wires the two together:
 *
 *   1. `scanProjectReddit` calls `handleScanResult(result)` once the scan
 *      completes.
 *   2. This handler loads the project's business context itself, via the
 *      existing `getProjectScanData` (`services/projects.ts`) - the
 *      handler contract only carries scanned Reddit content, not project
 *      context, so it's loaded here rather than threaded through the
 *      contract.
 *   3. Every scanned POST is run through NEW Phase 7
 *      (`runPhase7RelevanceFilter`): a lightweight AI relevance filter
 *      that decides `LEAD` or `NOT_A_LEAD` directly from the raw post
 *      (title+body combined) and the project's business context - no
 *      keyword matching or keyword scoring runs in this live path
 *      anymore. `LEAD` posts are hand off into the EXISTING Phase 9
 *      `enqueueCandidate()` queue by that module; `NOT_A_LEAD` posts stop
 *      there and are never sent to Phase 9. Comments are never passed to
 *      Phase 7 (Reddit comment scanning is out of scope - new scans are
 *      posts-only, `result.comments` is always `[]`).
 *
 * REPLACED HERE: this is the exact seam that used to run the OLD Phase 7
 * keyword matcher (`lib/matching/reddit-scan-matcher.ts`) and OLD Phase 8
 * keyword scoring (`lib/matching/gemini-eligibility.ts`) per post before
 * enqueueing. Neither OLD module is deleted or modified - they remain
 * fully intact (and independently tested) as a rollback/reference
 * checkpoint; this handler simply no longer calls them, per the approved
 * Phase 7 replacement plan. Legacy removal is a separate, later prompt.
 *
 * Deliberately out of scope here (see task spec): calling the Gemini API
 * (or any AI provider) directly, a Phase 9 worker/retry loop, persisting
 * anything to `reddit_leads` or the Leads UI, and scan scheduling - all of
 * that already lives in Phase 9/10 and scan orchestration, untouched by
 * this file.
 */
export class RedditScanMatchingHandler implements RedditScanResultHandler {
  private readonly userId: string;
  private readonly metrics: ScanRunMetrics | undefined;

  constructor(userId: string, metrics?: ScanRunMetrics) {
    this.userId = userId;
    this.metrics = metrics;
  }

  async handleScanResult(result: RedditScanResult): Promise<void> {
    const scanData = await getProjectScanData(this.userId, result.projectId);
    if (!scanData) {
      throw new Error("Project not found.");
    }

    await runPhase7RelevanceFilter(
      this.userId,
      result.projectId,
      buildPhase7ProjectContext(scanData),
      result.posts,
      this.metrics,
    );
  }
}

/**
 * Maps a project's onboarding search data (`ProjectScanData`, from
 * `getProjectScanData`) onto NEW Phase 7's business-context shape
 * (`Phase7ProjectContext`). Field names are an unmodified pass-through of
 * the project's existing, established fields - nothing is renamed or
 * reinterpreted. `hiddenKeywords`/`subreddits`/`isActive`/`id` are not
 * part of Phase 7's business context and are simply not carried over.
 */
export function buildPhase7ProjectContext(scanData: ProjectScanData): Phase7ProjectContext {
  return {
    description: scanData.description,
    keywords: scanData.keywords,
    intentPhrases: scanData.intentPhrases,
    painPhrases: scanData.painPhrases,
    competitors: scanData.competitors,
  };
}
