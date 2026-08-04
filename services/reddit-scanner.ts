import "server-only";

import { batchSearchTerms, buildSearchTerms, toRedditSearchQuery } from "@/lib/reddit/build-search-terms";
import { dedupeById } from "@/lib/reddit/dedupe-reddit-items";
import { RedditApiError } from "@/lib/reddit/reddit-api-client";
import { getPostComments, searchSubredditPosts } from "@/lib/reddit/reddit-listings";
import { mapRedditComment, mapRedditPost, toPostId36 } from "@/lib/reddit/reddit-mappers";
import { getProjectScanData } from "@/services/projects";
import type {
  RedditCommentItem,
  RedditPostItem,
  RedditScanResult,
  RedditScanResultHandler,
} from "@/types/reddit-scan";

const POSTS_PER_QUERY = 25;
const MAX_POSTS_PER_SUBREDDIT = 50;
const COMMENTS_PER_POST = 50;

// MVP scan window: always the last 7 days. Not configurable by design -
// requested via Reddit's built-in "week" time filter, then enforced exactly
// against each item's own `created_utc` below.
const SCAN_WINDOW_DAYS = 7;
const SCAN_WINDOW_MS = SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Whether a Reddit-provided ISO timestamp falls within the last 7 days. */
function isWithinScanWindow(createdAtIso: string): boolean {
  return new Date(createdAtIso).getTime() >= Date.now() - SCAN_WINDOW_MS;
}

// Rate-limit backoff for search terms. Reddit's own client (`redditGet`)
// already retries + backs off internally before ever surfacing a
// `RedditApiError` with `isRateLimited: true` - by the time we see one here,
// Reddit is telling us to slow down further. We never drop a rate-limited
// term: it's requeued into a later batch instead. `MAX_RATE_LIMIT_PASSES` is
// only a safety valve against looping forever if Reddit stays unreachable
// for the entire scan.
const RATE_LIMIT_BACKOFF_MS = 2_000;
const MAX_RATE_LIMIT_PASSES = 5;

export type RedditScanOptions = {
  /** Reddit search results requested per term. Defaults to 25. */
  postsPerQuery?: number;
  /** Cap on unique posts kept (for comment-fetching) per subreddit. Defaults to 50. Applied only after every search term has been searched - it never stops a term from being searched. */
  maxPostsPerSubreddit?: number;
  /** Comments fetched per post. Defaults to 50. */
  commentsPerPost?: number;
};

/**
 * Runs a full Reddit scan for a project.
 *
 * Loads the project's onboarding search data (keywords, hidden keyword
 * variations, intent/pain phrases, competitors, selected subreddits),
 * searches those subreddits using EVERY onboarding search term - each term
 * as its own independent Reddit request, never merged with others - fetches
 * both posts and comments from the last 7 days, deduplicates
 * everything by Reddit id, then hands the collected content to
 * `resultHandler` - the next pipeline stage (keyword matching, added in a
 * later phase).
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
  const commentsPerPost = options.commentsPerPost ?? COMMENTS_PER_POST;

  const scanData = await getProjectScanData(userId, projectId);
  if (!scanData) {
    throw new Error("Project not found.");
  }

  const result: RedditScanResult = {
    projectId,
    scannedAt: new Date().toISOString(),
    subredditsScanned: scanData.subreddits,
    posts: [],
    comments: [],
  };

  if (scanData.subreddits.length === 0) {
    console.warn(
      `[reddit-scanner] Project ${projectId} has no subreddits configured; skipping scan.`,
    );
    await resultHandler.handleScanResult(result);
    return result;
  }

  // Priority-ordered, deduplicated, uncapped - every keyword, intent phrase,
  // pain phrase, competitor, and hidden keyword variation is included.
  const searchTerms = buildSearchTerms(scanData);
  if (searchTerms.length === 0) {
    console.warn(
      `[reddit-scanner] Project ${projectId} has no search terms configured; skipping scan.`,
    );
    await resultHandler.handleScanResult(result);
    return result;
  }

  const collectedPosts: RedditPostItem[] = [];

  for (const subreddit of scanData.subreddits) {
    const subredditPosts = await searchSubredditForAllTerms(subreddit, searchTerms, postsPerQuery);
    // Every search term was executed above; this cap only bounds how many
    // of the resulting posts get their comments fetched next.
    collectedPosts.push(...subredditPosts.slice(0, maxPostsPerSubreddit));
  }

  const uniquePosts = dedupeById(collectedPosts);
  const collectedComments: RedditCommentItem[] = [];

  for (const post of uniquePosts) {
    try {
      const rawComments = await getPostComments(post.subreddit, toPostId36(post.id), commentsPerPost);
      const withinWindow = rawComments
        .map(mapRedditComment)
        .filter((comment) => isWithinScanWindow(comment.createdAt));
      collectedComments.push(...withinWindow);
    } catch (error) {
      logRedditError(`fetching comments for post ${post.id} in r/${post.subreddit}`, error);
      // Skip this post's comments and keep going - one post's comment
      // fetch failing (rate limit or otherwise) should not abandon the
      // remaining posts.
    }
  }

  result.posts = uniquePosts;
  result.comments = dedupeById(collectedComments);

  await resultHandler.handleScanResult(result);

  return result;
}

/**
 * Searches one subreddit for every term in `terms`, each as its own
 * independent Reddit request (no merging terms into a combined query).
 * Terms are processed in priority order, in batches of
 * `SEARCH_BATCH_SIZE`. A term that gets rate-limited is never dropped: it's
 * requeued to run in a later batch, after the rest of the current batch has
 * been attempted, with backoff if an entire batch was rate-limited.
 */
async function searchSubredditForAllTerms(
  subreddit: string,
  terms: string[],
  postsPerQuery: number,
): Promise<RedditPostItem[]> {
  const posts: RedditPostItem[] = [];
  // A queue of batches, in priority order. A rate-limited term is pushed
  // into a brand new batch appended to the end of this queue - it literally
  // runs "in a later batch" instead of being dropped.
  const batchQueue: string[][] = batchSearchTerms(terms);
  let consecutiveFullyRateLimitedPasses = 0;

  while (batchQueue.length > 0) {
    const batch = batchQueue.shift()!;
    const requeued: string[] = [];

    for (const term of batch) {
      try {
        const rawPosts = await searchSubredditPosts(
          subreddit,
          toRedditSearchQuery(term),
          postsPerQuery,
          "week",
        );
        const withinWindow = rawPosts
          .map(mapRedditPost)
          .filter((post) => isWithinScanWindow(post.createdAt));
        posts.push(...withinWindow);
      } catch (error) {
        logRedditError(`searching r/${subreddit} for "${term}"`, error);
        if (error instanceof RedditApiError && error.isRateLimited) {
          // Never silently drop a rate-limited term - retry it in a later batch.
          requeued.push(term);
        }
        // Non-rate-limit errors are a genuine per-term failure (already
        // logged above) and that term is skipped for this subreddit.
      }
    }

    if (requeued.length > 0) {
      batchQueue.push(requeued);
    }

    if (requeued.length === batch.length && batchQueue.length > 0) {
      consecutiveFullyRateLimitedPasses++;
      if (consecutiveFullyRateLimitedPasses >= MAX_RATE_LIMIT_PASSES) {
        const remaining = batchQueue.reduce((count, b) => count + b.length, 0);
        console.error(
          `[reddit-scanner] Giving up on ${remaining} remaining search term(s) for r/${subreddit} after ${MAX_RATE_LIMIT_PASSES} consecutive rate-limited passes.`,
        );
        break;
      }
      console.warn(
        `[reddit-scanner] All ${requeued.length} term(s) in this batch were rate-limited for r/${subreddit}; backing off before retrying them in a later batch.`,
      );
      await sleep(RATE_LIMIT_BACKOFF_MS * consecutiveFullyRateLimitedPasses);
    } else {
      consecutiveFullyRateLimitedPasses = 0;
    }
  }

  return posts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logRedditError(context: string, error: unknown): void {
  if (error instanceof RedditApiError) {
    console.error(
      `[reddit-scanner] Reddit API error while ${context}: ${error.message}` +
        (error.status ? ` (status ${error.status})` : ""),
    );
    return;
  }
  console.error(`[reddit-scanner] Unexpected error while ${context}:`, error);
}
