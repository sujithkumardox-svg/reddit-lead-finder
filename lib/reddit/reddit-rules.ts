import "server-only";

import { redditGet } from "@/lib/reddit/reddit-api-client";

/** Fields we use from Reddit's `/r/{subreddit}/about/rules` rule objects. */
export type RawSubredditRule = {
  short_name: string;
  description: string;
};

type RedditRulesResponse = {
  rules?: RawSubredditRule[];
};

/**
 * Fetches a subreddit's posted rules via the existing authenticated Reddit
 * client (`redditGet`) - the same OAuth/retry/rate-limit handling already
 * used by the scanner (`lib/reddit/reddit-listings.ts`); no new Reddit
 * client is introduced. Returns an empty array for a subreddit with no
 * rules at all (Reddit returns `rules: []` in that case), which
 * `classifySubredditSafety` treats as "Without Rules".
 */
export async function fetchSubredditRules(subreddit: string): Promise<RawSubredditRule[]> {
  const data = await redditGet<RedditRulesResponse>(`/r/${encodeURIComponent(subreddit)}/about/rules`);
  return data.rules ?? [];
}
