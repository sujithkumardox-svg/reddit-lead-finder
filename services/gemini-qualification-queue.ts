import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { QualifyRedditCandidateResult } from "@/lib/ai/qualify-reddit-candidate";
import type { MatchingEngineResult } from "@/lib/matching/matching-engine";
import type {
  EnqueueGeminiCandidateInput,
  GeminiQualificationQueueRow,
} from "@/types/gemini-qualification-queue";

/**
 * Data access layer for `gemini_qualification_queue` - the crash-safe
 * database queue Phase 8-qualified Reddit posts/comments are persisted to
 * BEFORE any future Gemini processing. This is the only module allowed to
 * query/mutate that table directly.
 *
 * Deliberately out of scope here: calling Gemini (or any AI provider), and
 * a scheduler/worker loop that repeatedly calls `claimNextPending` -
 * this module only provides the persistence primitives a future worker and
 * recovery process will use.
 */

const QUEUE_COLUMNS =
  "id, project_id, user_id, reddit_item_id, item_type, parent_post_id, subreddit, title, body, matched_text, author, permalink, reddit_score, item_created_at, matched_terms, numerical_score, diversity_bonus, final_score, qualification_reason, status, processing_started_at, attempt_count, error_message, ai_qualified, ai_score, ai_match_type, ai_lead_summary, ai_match_reason, ai_possible_competitor, ai_provider, ai_model, created_at, updated_at";

/** Visibility timeout `recoverStaleProcessing` uses when the caller doesn't pass one. */
const DEFAULT_VISIBILITY_TIMEOUT_MS = 15 * 60 * 1000;

type QueueRowRecord = {
  id: unknown;
  project_id: unknown;
  user_id: unknown;
  reddit_item_id: unknown;
  item_type: unknown;
  parent_post_id: unknown;
  subreddit: unknown;
  title: unknown;
  body: unknown;
  matched_text: unknown;
  author: unknown;
  permalink: unknown;
  reddit_score: unknown;
  item_created_at: unknown;
  matched_terms: unknown;
  numerical_score: unknown;
  diversity_bonus: unknown;
  final_score: unknown;
  qualification_reason: unknown;
  status: unknown;
  processing_started_at: unknown;
  attempt_count: unknown;
  error_message: unknown;
  ai_qualified: unknown;
  ai_score: unknown;
  ai_match_type: unknown;
  ai_lead_summary: unknown;
  ai_match_reason: unknown;
  ai_possible_competitor: unknown;
  ai_provider: unknown;
  ai_model: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function mapRowToQueueRow(row: QueueRowRecord): GeminiQualificationQueueRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    redditItemId: row.reddit_item_id as string,
    itemType: row.item_type as GeminiQualificationQueueRow["itemType"],
    parentPostId: row.parent_post_id as string | null,
    subreddit: row.subreddit as string,
    title: row.title as string | null,
    body: row.body as string,
    matchedText: row.matched_text as string,
    author: row.author as string,
    permalink: row.permalink as string,
    redditScore: row.reddit_score as number,
    itemCreatedAt: row.item_created_at as string,
    matchedTerms: row.matched_terms as MatchingEngineResult,
    numericalScore: row.numerical_score as number,
    diversityBonus: row.diversity_bonus as number,
    finalScore: row.final_score as number,
    qualificationReason: row.qualification_reason as GeminiQualificationQueueRow["qualificationReason"],
    status: row.status as GeminiQualificationQueueRow["status"],
    processingStartedAt: row.processing_started_at as string | null,
    attemptCount: row.attempt_count as number,
    errorMessage: row.error_message as string | null,
    aiQualified: row.ai_qualified as boolean | null,
    aiScore: row.ai_score as number | null,
    aiMatchType: row.ai_match_type as string | null,
    aiLeadSummary: row.ai_lead_summary as string | null,
    aiMatchReason: row.ai_match_reason as string | null,
    aiPossibleCompetitor: row.ai_possible_competitor as string | null,
    aiProvider: row.ai_provider as string | null,
    aiModel: row.ai_model as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Persists one Phase 8-qualified Reddit post/comment to the queue, in
 * `pending` status, ready for a future Gemini worker to claim. Must only
 * ever be called for candidates where `evaluateGeminiEligibility` returned
 * `qualifiesForGemini: true` - the caller (the matching handler) is
 * responsible for that check; this function only persists.
 *
 * Duplicate protection relies on the database's
 * `gemini_qualification_queue_project_reddit_item_unique` constraint, not
 * an application-side check. A unique violation (Postgres code `23505`,
 * the same convention used in `services/projects.ts`) means this Reddit
 * item is already queued for this project - that's an expected outcome,
 * not an error, so the scan continues and `null` is returned instead of a
 * duplicate row.
 */
export async function enqueueCandidate(
  input: EnqueueGeminiCandidateInput,
): Promise<GeminiQualificationQueueRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("gemini_qualification_queue")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      reddit_item_id: input.redditItemId,
      item_type: input.itemType,
      parent_post_id: input.parentPostId,
      subreddit: input.subreddit,
      title: input.title,
      body: input.body,
      matched_text: input.matchedText,
      author: input.author,
      permalink: input.permalink,
      reddit_score: input.redditScore,
      item_created_at: input.itemCreatedAt,
      matched_terms: input.matchedTerms,
      numerical_score: input.numericalScore,
      diversity_bonus: input.diversityBonus,
      final_score: input.finalScore,
      qualification_reason: input.qualificationReason,
    })
    .select(QUEUE_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      console.warn(
        `[gemini-qualification-queue] Skipping duplicate candidate ${input.redditItemId} for project ${input.projectId} - already queued.`,
      );
      return null;
    }
    console.error("enqueueCandidate Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to queue Gemini candidate.");
  }

  return mapRowToQueueRow(data as QueueRowRecord);
}

/**
 * Claims the oldest `pending` row for Gemini processing: flips it to
 * `processing`, stamps `processing_started_at`, and increments
 * `attempt_count`. Returns `null` if there is nothing pending, or if
 * another worker claimed the same row between the lookup and the claim
 * update (the second `.eq("status", "pending")` below means that race
 * simply yields no update, not a crash or a double-claim).
 *
 * Not implemented as a scheduler/loop - a future worker is expected to
 * call this repeatedly on its own schedule.
 */
export async function claimNextPending(): Promise<GeminiQualificationQueueRow | null> {
  const supabase = await createClient();

  const { data: nextPending, error: selectError } = await supabase
    .from("gemini_qualification_queue")
    .select("id, attempt_count")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    console.error("claimNextPending Supabase select error:", {
      message: selectError.message,
      code: selectError.code,
      details: selectError.details,
      hint: selectError.hint,
    });
    throw new Error("Failed to look up the next Gemini candidate.");
  }

  if (!nextPending) {
    return null;
  }

  const { data, error } = await supabase
    .from("gemini_qualification_queue")
    .update({
      status: "processing",
      processing_started_at: new Date().toISOString(),
      attempt_count: (nextPending.attempt_count as number) + 1,
    })
    .eq("id", nextPending.id as string)
    .eq("status", "pending")
    .select(QUEUE_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error("claimNextPending Supabase update error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to claim the next Gemini candidate.");
  }

  if (!data) {
    // Lost the race to another worker between the select and the update.
    return null;
  }

  return mapRowToQueueRow(data as QueueRowRecord);
}

/**
 * Marks a claimed row as `completed` once a future Gemini worker has
 * finished processing it successfully. Retained indefinitely (MVP
 * retention policy) as an audit trail - never deleted here.
 */
export async function markCompleted(id: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("gemini_qualification_queue")
    .update({ status: "completed", error_message: null })
    .eq("id", id);

  if (error) {
    console.error("markCompleted Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to mark Gemini candidate as completed.");
  }
}

/**
 * Persists a Phase 9B Gemini qualification result (`aiQualified`, `aiScore`,
 * `aiMatchType`, `aiLeadSummary`, `aiMatchReason`, `aiPossibleCompetitor`,
 * plus the `aiProvider`/`aiModel` provenance the service attaches) for a
 * claimed row, and marks it `completed` in the same update. Because both
 * happen in one atomic write, there is never a window where the AI result
 * is saved without the row also being marked successfully completed, or
 * vice versa - satisfying "mark successful only after the result is
 * saved" without needing two separate round trips.
 */
export async function saveQualificationResult(
  id: string,
  result: QualifyRedditCandidateResult,
): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("gemini_qualification_queue")
    .update({
      ai_qualified: result.aiQualified,
      ai_score: result.aiScore,
      ai_match_type: result.aiMatchType,
      ai_lead_summary: result.aiLeadSummary,
      ai_match_reason: result.aiMatchReason,
      ai_possible_competitor: result.aiPossibleCompetitor,
      ai_provider: result.aiProvider,
      ai_model: result.aiModel,
      status: "completed",
      error_message: null,
    })
    .eq("id", id);

  if (error) {
    console.error("saveQualificationResult Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to save Gemini qualification result.");
  }
}

/**
 * Marks a claimed row as `failed` after a future Gemini worker's
 * processing attempt errors out. The row remains in the database
 * (retained, not deleted) so it stays available for retry or inspection.
 */
export async function markFailed(id: string, errorMessage: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("gemini_qualification_queue")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", id);

  if (error) {
    console.error("markFailed Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to mark Gemini candidate as failed.");
  }
}

/**
 * Visibility-timeout style crash recovery: resets any row still stuck in
 * `processing` whose `processing_started_at` is older than
 * `visibilityTimeoutMs` back to `pending` (clearing
 * `processing_started_at`), so a worker or server that crashed mid-claim
 * can never make a candidate disappear. `attempt_count` is left untouched
 * here - it was already incremented by the claim that got interrupted.
 *
 * Returns the number of rows recovered. Callers decide how/when to invoke
 * this (e.g. at the start of a worker run) - no scheduler is defined here.
 */
export async function recoverStaleProcessing(
  visibilityTimeoutMs: number = DEFAULT_VISIBILITY_TIMEOUT_MS,
): Promise<number> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - visibilityTimeoutMs).toISOString();

  const { data, error } = await supabase
    .from("gemini_qualification_queue")
    .update({ status: "pending", processing_started_at: null })
    .eq("status", "processing")
    .lt("processing_started_at", cutoff)
    .select("id");

  if (error) {
    console.error("recoverStaleProcessing Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to recover stale Gemini candidates.");
  }

  return (data ?? []).length;
}
