/**
 * Shapes shared between the Reddit Scanner (this phase) and whatever
 * consumes its output next (keyword matching / candidate scoring, a later
 * phase). Kept separate from `types/project.ts` because these describe raw
 * scanned Reddit content, not project/onboarding data.
 */

/** A Reddit post found while searching a project's selected subreddits. */
export type RedditPostItem = {
  /** Reddit fullname, e.g. `t3_abc123`. Globally unique - used for dedup. */
  id: string;
  type: "post";
  subreddit: string;
  title: string;
  body: string;
  author: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdAt: string;
};

/** A Reddit comment found on one of the posts collected during a scan. */
export type RedditCommentItem = {
  /** Reddit fullname, e.g. `t1_abc123`. Globally unique - used for dedup. */
  id: string;
  type: "comment";
  subreddit: string;
  /** Fullname (`t3_...`) of the post this comment belongs to. */
  postId: string;
  body: string;
  author: string;
  permalink: string;
  score: number;
  createdAt: string;
};

/**
 * Everything the Reddit Scanner collected for a single project run.
 * Deliberately contains only raw Reddit content - no scoring, matching, or
 * qualification. That happens in later pipeline stages.
 */
export type RedditScanResult = {
  projectId: string;
  scannedAt: string;
  subredditsScanned: string[];
  posts: RedditPostItem[];
  comments: RedditCommentItem[];
};

/**
 * The contract the next pipeline stage (e.g. keyword matching) must
 * implement to receive scanned Reddit content. The scanner depends only on
 * this interface - it never imports or calls later-phase code directly, so
 * this phase stays independent of everything downstream.
 */
export interface RedditScanResultHandler {
  handleScanResult(result: RedditScanResult): Promise<void>;
}
