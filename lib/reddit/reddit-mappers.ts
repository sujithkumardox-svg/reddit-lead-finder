import type { RawRedditComment, RawRedditPost } from "@/lib/reddit/reddit-listings";
import type { RedditCommentItem, RedditPostItem } from "@/types/reddit-scan";

/** Maps a raw Reddit post listing into the scanner's internal shape. */
export function mapRedditPost(raw: RawRedditPost): RedditPostItem {
  return {
    id: raw.name,
    type: "post",
    subreddit: raw.subreddit,
    title: raw.title ?? "",
    body: raw.selftext ?? "",
    author: raw.author ?? "[deleted]",
    url: raw.url ?? "",
    permalink: toRedditUrl(raw.permalink),
    score: raw.score ?? 0,
    numComments: raw.num_comments ?? 0,
    createdAt: toIsoString(raw.created_utc),
  };
}

/** Maps a raw Reddit comment listing into the scanner's internal shape. */
export function mapRedditComment(raw: RawRedditComment): RedditCommentItem {
  return {
    id: raw.name,
    type: "comment",
    subreddit: raw.subreddit,
    postId: raw.link_id,
    body: raw.body ?? "",
    author: raw.author ?? "[deleted]",
    permalink: toRedditUrl(raw.permalink),
    score: raw.score ?? 0,
    createdAt: toIsoString(raw.created_utc),
  };
}

/** Strips the `t3_` fullname prefix so the id can be used in comment URLs. */
export function toPostId36(postFullname: string): string {
  return postFullname.replace(/^t3_/, "");
}

function toRedditUrl(permalink: string): string {
  if (!permalink) return "";
  return permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
}

function toIsoString(createdUtc: number): string {
  return new Date(createdUtc * 1000).toISOString();
}
