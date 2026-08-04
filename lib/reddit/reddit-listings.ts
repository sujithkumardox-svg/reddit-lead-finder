import "server-only";

import { redditGet } from "@/lib/reddit/reddit-api-client";

const DEFAULT_SEARCH_LIMIT = 25;
const DEFAULT_COMMENT_LIMIT = 50;

type RedditListingChild<T> = { kind: string; data: T };
type RedditListing<T> = { kind: "Listing"; data: { children: RedditListingChild<T>[] } };

/** Fields we use from Reddit's post ("link") listing objects. */
export type RawRedditPost = {
  id: string;
  name: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string;
  url: string;
  permalink: string;
  score: number;
  num_comments: number;
  created_utc: number;
};

/** Fields we use from Reddit's comment ("t1") listing objects. */
export type RawRedditComment = {
  id: string;
  name: string;
  link_id: string;
  subreddit: string;
  body: string;
  author: string;
  permalink: string;
  score: number;
  created_utc: number;
};

/** Reddit's search `t` (time) param. Used to narrow results to roughly the configured scan window before exact client-side filtering. */
export type RedditTimeFilter = "hour" | "day" | "week" | "month" | "year" | "all";

/**
 * Searches a single subreddit for posts matching `query`. Search is
 * restricted to the given subreddit (`restrict_sr=1`) - this never searches
 * all of Reddit. `timeFilter` narrows results to Reddit's nearest built-in
 * time window; callers still apply exact scan-window filtering on the
 * returned `created_utc` since Reddit only supports coarse buckets.
 */
export async function searchSubredditPosts(
  subreddit: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  timeFilter: RedditTimeFilter = "all",
): Promise<RawRedditPost[]> {
  const data = await redditGet<RedditListing<RawRedditPost>>(
    `/r/${encodeURIComponent(subreddit)}/search`,
    {
      q: query,
      restrict_sr: "1",
      sort: "new",
      type: "link",
      limit: String(Math.min(Math.max(limit, 1), 100)),
      t: timeFilter,
    },
  );

  return data.data.children
    .filter((child) => child.kind === "t3")
    .map((child) => child.data);
}

/**
 * Fetches top-level comments for a single post. `postId` must be the post's
 * base36 id without the `t3_` fullname prefix.
 */
export async function getPostComments(
  subreddit: string,
  postId: string,
  limit: number = DEFAULT_COMMENT_LIMIT,
): Promise<RawRedditComment[]> {
  const data = await redditGet<[RedditListing<RawRedditPost>, RedditListing<RawRedditComment>]>(
    `/r/${encodeURIComponent(subreddit)}/comments/${postId}`,
    {
      limit: String(Math.min(Math.max(limit, 1), 100)),
      depth: "1",
    },
  );

  const commentListing = data[1];
  if (!commentListing) return [];

  return commentListing.data.children
    .filter((child) => child.kind === "t1")
    .map((child) => child.data);
}
