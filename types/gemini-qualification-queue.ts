import type { MatchingEngineResult } from "@/lib/matching/matching-engine";

/**
 * Shapes for the Gemini qualification queue: crash-safe persistence of
 * Phase 8-qualified Reddit posts/comments, inserted right after
 * `evaluateGeminiEligibility` returns `qualifiesForGemini: true` and before
 * any future Gemini processing. See
 * `supabase/migrations/20260811100000_gemini_qualification_queue.sql` for
 * the underlying table.
 *
 * Kept separate from `types/project.ts`/`types/reddit-scan.ts` - this
 * describes queue rows, not project/onboarding data or raw scanned Reddit
 * content.
 */

export type GeminiQueueItemType = "post" | "comment";

/** The Gemini processing lifecycle - distinct from `reddit_leads`'s user-facing lead status. */
export type GeminiQueueStatus = "pending" | "processing" | "completed" | "failed";

/**
 * The only two reasons a candidate can actually reach the queue.
 * `evaluateGeminiEligibility`'s third reason, `"below_threshold"`, is never
 * persisted here because non-qualifying candidates are never enqueued.
 */
export type GeminiQueueQualificationReason = "intent_or_pain" | "score_threshold";

/** A row of `gemini_qualification_queue`, in camelCase. */
export type GeminiQualificationQueueRow = {
  id: string;
  projectId: string;
  userId: string;
  /** Reddit fullname: `t3_...` for posts, `t1_...` for comments. */
  redditItemId: string;
  itemType: GeminiQueueItemType;
  /** Fullname (`t3_...`) of the parent post. Comments only; `null` for posts. */
  parentPostId: string | null;
  subreddit: string;
  /** Posts only; `null` for comments. */
  title: string | null;
  body: string;
  /** The exact text the Matching Engine matched against (post title+body combined, or the comment body alone). */
  matchedText: string;
  author: string;
  permalink: string;
  redditScore: number;
  itemCreatedAt: string;
  /** Complete Phase 7 `MatchingEngineResult` for this candidate. */
  matchedTerms: MatchingEngineResult;
  numericalScore: number;
  diversityBonus: number;
  finalScore: number;
  qualificationReason: GeminiQueueQualificationReason;
  status: GeminiQueueStatus;
  processingStartedAt: string | null;
  attemptCount: number;
  errorMessage: string | null;
  /**
   * Explicit AI qualification verdict (Phase 9): `true`/`false` once
   * processed, `null` until a future AI worker processes this row.
   * Distinct from `status` (worker call succeeded/failed) - a `"completed"`
   * row can still resolve to `false` here.
   */
  aiQualified: boolean | null;
  /**
   * AI-produced qualification score (Phase 9). Customer-facing.
   * Unrelated to `finalScore` (Phase 8's internal pre-AI gating score) -
   * the two must never be conflated. `null` until a future AI worker
   * processes this row.
   */
  aiScore: number | null;
  /** AI's classification of this candidate. Taxonomy owned by the Phase 9 AI prompt/schema, not this type. */
  aiMatchType: string | null;
  /** AI-generated short summary of this candidate as a lead. */
  aiLeadSummary: string | null;
  /** AI's explanation of why (or why not) this candidate qualifies. */
  aiMatchReason: string | null;
  /** Competitor name the AI identified in this candidate's content, if any. */
  aiPossibleCompetitor: string | null;
  /** Provenance: AI provider that produced the `ai*` result fields above (e.g. `"google"`). Current provider is Gemini; may differ if a fallback provider is ever used. */
  aiProvider: string | null;
  /** Provenance: AI model identifier that produced the `ai*` result fields above (e.g. `"gemini-3.5-flash"`). */
  aiModel: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Everything `enqueueCandidate` needs to persist one Phase 8-qualified post or comment. */
export type EnqueueGeminiCandidateInput = {
  projectId: string;
  userId: string;
  redditItemId: string;
  itemType: GeminiQueueItemType;
  parentPostId: string | null;
  subreddit: string;
  title: string | null;
  body: string;
  matchedText: string;
  author: string;
  permalink: string;
  redditScore: number;
  itemCreatedAt: string;
  matchedTerms: MatchingEngineResult;
  numericalScore: number;
  diversityBonus: number;
  finalScore: number;
  qualificationReason: GeminiQueueQualificationReason;
};
