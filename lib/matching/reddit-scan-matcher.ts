import { runMatchingEngine } from "@/lib/matching/matching-engine";
import type { MatchingEngineResult, OnboardingSearchTerms } from "@/lib/matching/matching-engine";
import type { RedditCommentItem, RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

/**
 * Pure Scanner -> Matching Engine adapter logic (no I/O, no database, no
 * scanner/handler wiring - see `services/reddit-scan-matching-handler.ts`
 * for that). Kept separate so it can be unit tested directly against
 * `RedditScanResult` fixtures without touching Supabase or Reddit.
 *
 * Locked behavior (see task spec):
 *   - Each scanned POST has its `title` and `body` combined into ONE text
 *     string before being matched - the Matching Engine only ever sees one
 *     combined string per post, never title and body separately.
 *   - Each scanned COMMENT is matched independently, using only its own
 *     `body` - comments are never combined with their parent post or with
 *     each other.
 *   - This module never imports/calls anything from `services/` - it only
 *     depends on `lib/matching/matching-engine.ts` (Matching Engine) and
 *     `types/reddit-scan.ts` (Scanner's output shape), keeping the
 *     dependency direction the same as the rest of the codebase (services
 *     depend on lib, not the other way around).
 */

/** Signature of the function used to match one piece of Reddit text against a project's onboarding terms. Defaults to the real `runMatchingEngine` - overridable so tests can assert exactly which text/terms are passed without re-testing the Matching Engine itself. */
export type RedditTextMatcher = (text: string, terms: OnboardingSearchTerms) => MatchingEngineResult;

/** One scanned post's combined text plus its Matching Engine result. */
export type MatchedRedditPost = {
  post: RedditPostItem;
  /** `post.title` + `post.body` combined into the single string that was actually matched. */
  text: string;
  result: MatchingEngineResult;
};

/** One scanned comment's text plus its Matching Engine result. */
export type MatchedRedditComment = {
  comment: RedditCommentItem;
  /** Always exactly `comment.body` - comments are matched on their own, never combined with anything else. */
  text: string;
  result: MatchingEngineResult;
};

/** The Matching Engine's output for every post and comment from one Reddit scan, keyed the same way as `RedditScanResult`. */
export type RedditScanMatchingResult = {
  posts: MatchedRedditPost[];
  comments: MatchedRedditComment[];
};

/**
 * Combines a Reddit post's title and body into the single text string the
 * Matching Engine evaluates. Never mutates `post`.
 *
 * Link posts (no selftext) have `body === ""` - in that case the combined
 * text is just the title, so no empty second paragraph is introduced.
 */
export function combineRedditPostText(post: RedditPostItem): string {
  return post.body ? `${post.title}\n\n${post.body}` : post.title;
}

/**
 * Runs the Matching Engine over every post and comment in one Reddit scan
 * result against one project's onboarding terms.
 *
 * - Every post's title + body are combined (via `combineRedditPostText`)
 *   into one string and matched once.
 * - Every comment's body is matched on its own, independently of every
 *   other comment and of its parent post.
 * - Never mutates `result` or `terms`.
 */
export function matchRedditScanResult(
  result: RedditScanResult,
  terms: OnboardingSearchTerms,
  matchText: RedditTextMatcher = runMatchingEngine,
): RedditScanMatchingResult {
  const posts: MatchedRedditPost[] = result.posts.map((post) => {
    const text = combineRedditPostText(post);
    return { post, text, result: matchText(text, terms) };
  });

  const comments: MatchedRedditComment[] = result.comments.map((comment) => {
    const text = comment.body;
    return { comment, text, result: matchText(text, terms) };
  });

  return { posts, comments };
}
