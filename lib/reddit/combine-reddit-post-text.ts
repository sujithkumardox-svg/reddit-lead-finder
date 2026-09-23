import type { RedditPostItem } from "@/types/reddit-scan";

/**
 * Combines a Reddit post's title and body into the single text string
 * downstream consumers evaluate.
 *
 * Relocated here (from `lib/matching/reddit-scan-matcher.ts`, the OLD
 * Phase 7 keyword matcher) so it lives in a shared, non-legacy location
 * both the OLD matcher and the NEW Phase 7 lightweight AI relevance
 * filter (`services/reddit-phase7-relevance-filter.ts`) can depend on.
 * `lib/matching/reddit-scan-matcher.ts` now imports and re-exports this
 * exact function (unchanged behavior, same export path) so nothing that
 * already imports `combineRedditPostText` from there breaks.
 *
 * Never mutates `post`. Link posts (no selftext) have `body === ""` - in
 * that case the combined text is just the title, so no empty second
 * paragraph is introduced.
 */
export function combineRedditPostText(post: RedditPostItem): string {
  return post.body ? `${post.title}\n\n${post.body}` : post.title;
}
