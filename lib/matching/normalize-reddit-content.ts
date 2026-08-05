import { normalizeText } from "@/lib/matching/normalize-text";
import type { RedditCommentItem, RedditPostItem } from "@/types/reddit-scan";

/**
 * A Reddit post plus a TEMPORARY, in-memory normalized copy of its text.
 * `title`/`body` are untouched originals - Gemini and anything else that
 * needs the real Reddit text must read those, never the `normalized*`
 * fields.
 */
export type NormalizedRedditPost = RedditPostItem & {
  normalizedTitle: string;
  normalizedBody: string;
};

/** A Reddit comment plus a TEMPORARY, in-memory normalized copy of its text. */
export type NormalizedRedditComment = RedditCommentItem & {
  normalizedBody: string;
};

/**
 * Returns a NEW object carrying the post's original fields untouched plus
 * normalized copies of `title`/`body` for matching. Never mutates `post`.
 */
export function toNormalizedRedditPost(post: RedditPostItem): NormalizedRedditPost {
  return {
    ...post,
    normalizedTitle: normalizeText(post.title),
    normalizedBody: normalizeText(post.body),
  };
}

/**
 * Returns a NEW object carrying the comment's original fields untouched
 * plus a normalized copy of `body` for matching. Never mutates `comment`.
 */
export function toNormalizedRedditComment(comment: RedditCommentItem): NormalizedRedditComment {
  return {
    ...comment,
    normalizedBody: normalizeText(comment.body),
  };
}
