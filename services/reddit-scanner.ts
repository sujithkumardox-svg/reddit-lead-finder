import "server-only";

import { buildSearchTerms } from "@/lib/reddit/build-search-terms";
import { dedupeById } from "@/lib/reddit/dedupe-reddit-items";
import { captureScrapedPostsForDiagnostics } from "@/lib/reddit/diagnostic-post-capture";
import { applyFreePlanTestLimits } from "@/lib/reddit/free-plan-test-limits";
import { createRedditPostSearchProvider } from "@/lib/reddit/providers/create-reddit-post-search-provider";
import {
  RedditProviderError,
  type RedditPostSearchProvider,
} from "@/lib/reddit/providers/reddit-post-search-provider";
import { createSubredditMetrics } from "@/lib/scans/scan-metrics";
import { getProjectScanData } from "@/services/projects";
import type { ScanRunMetrics } from "@/types/scan-metrics";
import type {
  RedditPostItem,
  RedditScanResult,
  RedditScanResultHandler,
} from "@/types/reddit-scan";

const POSTS_PER_QUERY = 25;

// MVP scan window: always the last 7 days. Not configurable by design.
// Providers should restrict retrieval to this window; this exact ISO
// filter is still applied on each mapped post's `createdAt` as a
// correctness safety net, not as a substitute for provider-side filtering.
const SCAN_WINDOW_DAYS = 7;
const SCAN_WINDOW_MS = SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Whether a Reddit-provided ISO timestamp falls within the last 7 days. */
function isWithinScanWindow(createdAtIso: string): boolean {
  return new Date(createdAtIso).getTime() >= Date.now() - SCAN_WINDOW_MS;
}

export type RedditScanOptions = {
  /** Search results requested per term. Defaults to 25. Passed through to the provider. */
  postsPerQuery?: number;
  /** Injected in tests. Production uses `createRedditPostSearchProvider()`. */
  provider?: RedditPostSearchProvider;
  /** Optional in-memory funnel accumulator for this scan. Mutated in place. */
  metrics?: ScanRunMetrics;
};

/**
 * Runs a full Reddit scan for a project.
 *
 * Loads the project's onboarding search data (keywords, hidden keyword
 * variations, intent/pain phrases, competitors, selected subreddits),
 * searches those subreddits using EVERY onboarding search term (one
 * provider call per subreddit, with the full term list), collects posts
 * from the last 7 days, deduplicates by Reddit id, then hands the
 * collected content to `resultHandler`. New scans are posts-only:
 * `comments` is always `[]`.
 *
 * This function deliberately does NOT match keywords, score candidates,
 * call Gemini, create leads, or persist scanned content to the database.
 * It only collects Reddit data and forwards it through `resultHandler`.
 */
export async function scanProjectReddit(
  userId: string,
  projectId: string,
  resultHandler: RedditScanResultHandler,
  options: RedditScanOptions = {},
): Promise<RedditScanResult> {
  const postsPerQuery = options.postsPerQuery ?? POSTS_PER_QUERY;
  const provider = options.provider ?? createRedditPostSearchProvider();
  const metrics = options.metrics;

  const scanData = await getProjectScanData(userId, projectId);
  if (!scanData) {
    throw new Error("Project not found.");
  }

  // Optional Free-plan test overlay: slices search input per category when
  // USE_FREE_PLAN_TEST_LIMITS=true. Stored project data is not mutated;
  // matching/Gemini reload the full lists independently via getProjectScanData.
  const searchInput = applyFreePlanTestLimits(scanData);

  const result: RedditScanResult = {
    projectId,
    scannedAt: new Date().toISOString(),
    subredditsScanned: searchInput.subreddits,
    posts: [],
    comments: [],
  };

  if (searchInput.subreddits.length === 0) {
    console.warn(
      `[reddit-scanner] Project ${projectId} has no subreddits configured; skipping scan.`,
    );
    await resultHandler.handleScanResult(result);
    return result;
  }

  // Priority-ordered, deduplicated - buildSearchTerms itself stays uncapped.
  // Any Free-plan test cap was already applied to searchInput above.
  const searchTerms = buildSearchTerms(searchInput);
  if (searchTerms.length === 0) {
    console.warn(
      `[reddit-scanner] Project ${projectId} has no search terms configured; skipping scan.`,
    );
    await resultHandler.handleScanResult(result);
    return result;
  }

  const collectedPosts: RedditPostItem[] = [];
  const seenPostIds = new Set<string>();

  for (const subreddit of searchInput.subreddits) {
    if (metrics) {
      metrics.subredditsAttempted++;
    }
    const subredditStartedMs = Date.now();
    const bucket = metrics ? createSubredditMetrics(subreddit, new Date().toISOString()) : null;
    if (metrics && bucket) {
      metrics.subreddits.push(bucket);
    }

    try {
      const apifyStartedMs = Date.now();
      let providerPosts: RedditPostItem[];
      try {
        providerPosts = await provider.searchPosts({
          subreddit,
          searchTerms,
          postsPerQuery,
        });
      } finally {
        if (metrics) {
          metrics.durationsMs.apifyTotal += Date.now() - apifyStartedMs;
        }
      }

      const filterStartedMs = Date.now();
      const withinWindow = providerPosts.filter((post) => isWithinScanWindow(post.createdAt));
      if (metrics) {
        metrics.durationsMs.filter += Date.now() - filterStartedMs;
      }
      const outOfWindowCount = providerPosts.length - withinWindow.length;

      // TEMPORARY diagnostic-only capture (see `lib/reddit/diagnostic-post-capture.ts`).
      // No-op unless ENABLE_SCAN_POST_CAPTURE_DIAGNOSTIC=true; fail-open by
      // design, so it can never affect `withinWindow`, `collectedPosts`, or
      // this scan's success/failure. Must be removed after the Leadverse
      // investigation concludes.
      await captureScrapedPostsForDiagnostics(withinWindow, {
        userId,
        projectId,
        syncLogId: metrics?.syncLogId,
        subreddit,
      });

      collectedPosts.push(...withinWindow);

      let postsAfterDedupe = 0;
      for (const post of withinWindow) {
        if (!seenPostIds.has(post.id)) {
          seenPostIds.add(post.id);
          postsAfterDedupe++;
        }
      }

      if (metrics && bucket) {
        metrics.rawPosts += providerPosts.length;
        metrics.inWindowPosts += withinWindow.length;
        metrics.outOfWindowPosts += outOfWindowCount;
        metrics.postsAfterDedupe = seenPostIds.size;
        metrics.duplicatesRemoved = collectedPosts.length - seenPostIds.size;
        metrics.subredditsSucceeded++;
        bucket.status = "succeeded";
        bucket.rawPosts = providerPosts.length;
        bucket.inWindowPosts = withinWindow.length;
        bucket.outOfWindowPosts = outOfWindowCount;
        bucket.postsAfterDedupe = postsAfterDedupe;
      }
    } catch (error) {
      if (metrics) {
        metrics.subredditsFailed++;
      }
      if (error instanceof RedditProviderError && error.fatal) {
        throw error;
      }
      logProviderError(`searching r/${subreddit}`, error);
    } finally {
      if (bucket) {
        bucket.completedAt = new Date().toISOString();
        bucket.durationMs = Date.now() - subredditStartedMs;
      }
    }
  }

  const dedupeStartedMs = Date.now();
  result.posts = dedupeById(collectedPosts);
  if (metrics) {
    metrics.durationsMs.dedupe += Date.now() - dedupeStartedMs;
    metrics.postsAfterDedupe = result.posts.length;
    metrics.duplicatesRemoved = collectedPosts.length - result.posts.length;
  }
  result.comments = [];

  await resultHandler.handleScanResult(result);

  return result;
}

function logProviderError(context: string, error: unknown): void {
  if (error instanceof RedditProviderError) {
    console.error(`[reddit-scanner] Provider error while ${context}: ${error.message}`);
    return;
  }
  console.error(`[reddit-scanner] Unexpected error while ${context}.`);
}
