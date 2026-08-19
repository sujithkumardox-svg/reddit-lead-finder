import type { GeminiQueueItemType } from "@/types/gemini-qualification-queue";

/**
 * Shapes for the Phase 10 qualified-lead persistence layer:
 * `gemini_qualification_queue` rows with `status = 'completed'` and
 * `ai_qualified = true` are persisted here, into `reddit_leads` - the
 * final, customer-facing table Phase 11's dashboard will read. See
 * `supabase/migrations/20260818120000_phase10_lead_processing.sql` for the
 * underlying table.
 */

/**
 * Rule-based (no AI) subreddit safety classification. Computed from a
 * subreddit's actual posted rules by `lib/safety/subreddit-safety.ts`.
 */
export type SubredditSafetyBadge = "without_rules" | "promo_conditional" | "promo_not_safe";

/** The result of classifying a subreddit's rules: the badge plus a free-text explanation of the rule(s) behind it. */
export type SubredditSafetyResult = {
  badge: SubredditSafetyBadge;
  explanation: string;
};

/** The pre-existing user-facing lead lifecycle status on `reddit_leads` - untouched by Phase 10. */
export type RedditLeadStatus = "new" | "reviewed" | "contacted" | "ignored";

/** A row of `reddit_leads`, in camelCase. */
export type RedditLeadRow = {
  id: string;
  projectId: string;
  userId: string;
  redditItemId: string;
  itemType: GeminiQueueItemType;
  /** Fullname (`t3_...`) of the parent post. Comments only; `null` for posts. */
  parentPostId: string | null;
  subreddit: string;
  /** Posts only; `null` for comments. */
  title: string | null;
  content: string;
  author: string;
  /** Reddit author fullname (`t2_...`). `null` when Reddit does not report one. */
  authorId: string | null;
  permalink: string;
  score: number;
  /** Reddit comment count. Posts only - `null` for comments. */
  numComments: number | null;
  itemCreatedAt: string;
  aiScore: number;
  aiMatchType: string;
  aiLeadSummary: string;
  aiMatchReason: string;
  aiPossibleCompetitor: string | null;
  /**
   * AI's explanation of specifically why `aiPossibleCompetitor` was
   * flagged. Must stay hidden by default in the UI (Phase 11) and only be
   * shown via a tooltip/interaction on the Possible Competitor badge.
   */
  aiPossibleCompetitorReason: string | null;
  safetyBadge: SubredditSafetyBadge;
  safetyExplanation: string;
  status: RedditLeadStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Everything `persistQualifiedLead` needs to upsert one Gemini-qualified
 * (`ai_qualified = true`) candidate into `reddit_leads`. Deliberately
 * excludes `status` - an upsert must never reset a lead a customer has
 * already reviewed/contacted back to `'new'`, so `persistQualifiedLead`
 * never writes that column.
 */
export type PersistQualifiedLeadInput = {
  projectId: string;
  userId: string;
  redditItemId: string;
  itemType: GeminiQueueItemType;
  parentPostId: string | null;
  subreddit: string;
  title: string | null;
  content: string;
  author: string;
  authorId: string | null;
  permalink: string;
  score: number;
  numComments: number | null;
  itemCreatedAt: string;
  aiScore: number;
  aiMatchType: string;
  aiLeadSummary: string;
  aiMatchReason: string;
  aiPossibleCompetitor: string | null;
  aiPossibleCompetitorReason: string | null;
  safetyBadge: SubredditSafetyBadge;
  safetyExplanation: string;
};
