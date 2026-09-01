import "server-only";

import { buildSearchTerms } from "@/lib/reddit/build-search-terms";
import { dedupeById } from "@/lib/reddit/dedupe-reddit-items";
import { applyFreePlanTestLimits } from "@/lib/reddit/free-plan-test-limits";
import { createRedditPostSearchProvider } from "@/lib/reddit/providers/create-reddit-post-search-provider";
import {
  RedditProviderError,
  type RedditPostSearchProvider,
} from "@/lib/reddit/providers/reddit-post-search-provider";
import { getProjectScanData } from "@/services/projects";
import type {
  RedditPostItem,
  RedditScanResult,
  RedditScanResultHandler,
} from "@/types/reddit-scan";

const POSTS_PER_QUERY = 25;
const MAX_POSTS_PER_SUBREDDIT = 50;

// MVP scan window: always the last 7 days. Not configurable by design.
// The provider is asked for a week-scoped search; this exact ISO filter
// is still applied on each mapped post's `createdAt`.
const SCAN_WINDOW_DAYS = 7;
const SCAN_WINDOW_MS = SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Whether a Reddit-provided ISO timestamp falls within the last 7 days. */
function isWithinScanWindow(createdAtIso: string): boolean {
  return new Date(createdAtIso).getTime() >= Date.now() - SCAN_WINDOW_MS;
}

export type RedditScanOptions = {
  /** Search results requested per term. Defaults to 25. Passed through to the provider. */
  postsPerQuery?: number;
  /** Cap on unique posts kept per subreddit. Defaults to 50. Applied only after that subreddit's provider search returns. */
  maxPostsPerSubreddit?: number;
  /** Injected in tests. Production uses `createRedditPostSearchProvider()`. */
  provider?: RedditPostSearchProvider;
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
  const maxPostsPerSubreddit = options.maxPostsPerSubreddit ?? MAX_POSTS_PER_SUBREDDIT;
  const provider = options.provider ?? createRedditPostSearchProvider();

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

  for (const subreddit of searchInput.subreddits) {
    try {
      const providerPosts = await provider.searchPosts({
        subreddit,
        searchTerms,
        postsPerQuery,
      });
      const withinWindow = providerPosts.filter((post) => isWithinScanWindow(post.createdAt));
      collectedPosts.push(...withinWindow.slice(0, maxPostsPerSubreddit));
    } catch (error) {
      if (error instanceof RedditProviderError && error.fatal) {
        throw error;
      }
      logProviderError(`searching r/${subreddit}`, error);
    }
  }

  result.posts = dedupeById(collectedPosts);
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
