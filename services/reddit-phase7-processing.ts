import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  ClaimPhase7ProcessingInput,
  Phase7ClaimResult,
  Phase7Outcome,
  Phase7ProcessingRow,
  RecordPhase7OutcomeInput,
} from "@/types/reddit-phase7-processing";

/**
 * Data access layer for `reddit_phase7_processing` - the Phase 7
 * processing-history table. This is the only module allowed to
 * query/mutate that table directly, mirroring the convention already
 * established by `services/gemini-qualification-queue.ts` for the Phase 9
 * queue and `services/reddit-leads.ts` for leads.
 *
 * STORAGE/DEDUP FOUNDATION:
 *   - No AI provider (Gemini Flash-Lite or otherwise) is ever called here.
 *   - No Phase 7 business classification logic lives here - the Phase 7
 *     orchestrator (`services/reddit-phase7-relevance-filter.ts`) decides
 *     `"lead"` vs. `"not_a_lead"` elsewhere; this module only claims,
 *     records, and looks up that decision.
 *
 * `claimPhase7Processing`/`completePhase7Processing`/
 * `recordPhase7ProcessingError` (added alongside
 * `supabase/migrations/20260923090000_reddit_phase7_processing_claim.sql`)
 * provide the atomic claim/in-flight-processing primitives the Phase 7
 * orchestrator uses so two concurrent workers can never both call the AI
 * provider for the same `(project_id, reddit_item_id)` pair - see each
 * function's doc comment below. `getPhase7ProcessingRecord`/
 * `hasProcessedRedditItem`/`recordPhase7Outcome` are the original Prompt 1
 * primitives, kept unchanged and still fully functional.
 *
 * The dedup key is `(project_id, reddit_item_id)`, matching the same
 * project-scoped convention `gemini_qualification_queue` and `reddit_leads`
 * already use.
 */

const PHASE7_COLUMNS =
  "id, project_id, user_id, reddit_item_id, status, outcome, attempt_count, processing_started_at, last_error, last_error_at, created_at, updated_at";

type Phase7RowRecord = {
  id: unknown;
  project_id: unknown;
  user_id: unknown;
  reddit_item_id: unknown;
  status: unknown;
  outcome: unknown;
  attempt_count: unknown;
  processing_started_at: unknown;
  last_error: unknown;
  last_error_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function mapRowToPhase7Row(row: Phase7RowRecord): Phase7ProcessingRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    redditItemId: row.reddit_item_id as string,
    status: row.status as Phase7ProcessingRow["status"],
    outcome: row.outcome as Phase7ProcessingRow["outcome"],
    attemptCount: row.attempt_count as number,
    processingStartedAt: row.processing_started_at as string | null,
    lastError: row.last_error as string | null,
    lastErrorAt: row.last_error_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Looks up the existing Phase 7 processing record (if any) for this exact
 * `(projectId, redditItemId)` pair. A future Phase 7 orchestrator calls
 * this BEFORE processing a discovered post: a non-null result - regardless
 * of whether its `outcome` is `"lead"` or `"not_a_lead"` - means this post
 * has already been processed for this project and must be skipped.
 */
export async function getPhase7ProcessingRecord(
  projectId: string,
  redditItemId: string,
): Promise<Phase7ProcessingRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reddit_phase7_processing")
    .select(PHASE7_COLUMNS)
    .eq("project_id", projectId)
    .eq("reddit_item_id", redditItemId)
    .maybeSingle();

  if (error) {
    console.error("getPhase7ProcessingRecord Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to look up the Phase 7 processing record.");
  }

  return data ? mapRowToPhase7Row(data as Phase7RowRecord) : null;
}

/**
 * Whether this project has already processed this exact Reddit item
 * through Phase 7 - `true` for either outcome (`"lead"` or
 * `"not_a_lead"`). A thin convenience wrapper around
 * `getPhase7ProcessingRecord` for callers that only need the yes/no
 * eligibility answer, not the row itself.
 */
export async function hasProcessedRedditItem(
  projectId: string,
  redditItemId: string,
): Promise<boolean> {
  const record = await getPhase7ProcessingRecord(projectId, redditItemId);
  return record !== null;
}

/**
 * Persists a Phase 7 processing outcome (`"lead"` or `"not_a_lead"`) for
 * one `(projectId, redditItemId)` pair. Both outcomes count as
 * "processed" - a `"not_a_lead"` result must be written here too, or
 * Phase 7 would keep re-sending the same post to the AI on every future
 * scan.
 *
 * Duplicate protection relies on the database's
 * `reddit_phase7_processing_project_reddit_item_unique` constraint, not an
 * application-side check. A unique violation (Postgres code `23505`, the
 * same convention used by `services/gemini-qualification-queue.ts` and
 * `services/projects.ts`) means this Reddit item was already processed for
 * this project - by this call or a concurrent one - so that's an expected
 * outcome, not an error: `null` is returned instead of a duplicate row.
 *
 * Does not call any AI provider and contains no Phase 7 classification
 * logic - the caller has already decided `outcome`; this function only
 * persists it.
 */
export async function recordPhase7Outcome(
  input: RecordPhase7OutcomeInput,
): Promise<Phase7ProcessingRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reddit_phase7_processing")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      reddit_item_id: input.redditItemId,
      outcome: input.outcome,
    })
    .select(PHASE7_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      console.warn(
        `[reddit-phase7-processing] Skipping duplicate Phase 7 outcome for reddit item ${input.redditItemId} in project ${input.projectId} - already processed.`,
      );
      return null;
    }
    console.error("recordPhase7Outcome Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to record Phase 7 processing outcome.");
  }

  return mapRowToPhase7Row(data as Phase7RowRecord);
}

/** Visibility timeout `claimPhase7Processing` uses when the caller doesn't pass one - short relative to Phase 9's 15 minutes because a single lightweight AI call is expected to be fast. */
const DEFAULT_STALE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Atomically claims Phase 7 processing for one `(projectId, redditItemId)`
 * pair, per the NEW Phase 7 concurrency design. The Phase 7 orchestrator
 * (`services/reddit-phase7-relevance-filter.ts`) MUST call this before
 * ever calling the lightweight AI provider, and MUST NOT call the AI
 * provider unless this returns `{ kind: "claimed", ... }`.
 *
 * Three possible outcomes:
 *
 *   1. `{ kind: "claimed", row }` - an INSERT of a fresh `status:
 *      "processing"`, `outcome: null` row succeeded. This caller now
 *      atomically owns this pair - the database's own
 *      `reddit_phase7_processing_project_reddit_item_unique` constraint is
 *      what guarantees no other concurrent caller can also receive this
 *      result for the same pair at the same time; there is no
 *      application-side race window here at all.
 *   2. `{ kind: "already_processed", outcome }` - the INSERT hit that
 *      unique constraint (23505) because a `status: "completed"` row
 *      already exists for this pair. The caller must skip Phase 7
 *      entirely - this Reddit item has already been decided for this
 *      project, in either direction, and must never be re-sent to the AI
 *      provider.
 *   3. `{ kind: "in_progress" }` - the INSERT hit the same unique
 *      constraint because a DIFFERENT, still-active (non-stale) claim
 *      already owns this pair right now. The caller must skip Phase 7 for
 *      it this round rather than wait, retry immediately, or call the AI
 *      provider itself.
 *
 * Stale-claim recovery is folded into this same call rather than a
 * separate sweep, per the minimal-design goal: when the existing row is
 * still `status: "processing"` but its `processing_started_at` is older
 * than `staleTimeoutMs` (a worker likely crashed/was killed mid-attempt),
 * this function attempts to reclaim it via an UPDATE guarded by BOTH
 * `status = 'processing'` AND the exact `processing_started_at` value
 * just read - so if two callers concurrently detect the same stale row,
 * only one UPDATE can ever match and succeed; the loser sees zero rows
 * updated and returns `{ kind: "in_progress" }` instead of also claiming
 * it. A successful reclaim increments `attempt_count` and clears
 * `last_error`/`last_error_at` (the reclaiming caller gets a clean slate)
 * without ever inserting a second row for this pair - the original row is
 * reused in place.
 */
export async function claimPhase7Processing(
  input: ClaimPhase7ProcessingInput,
  staleTimeoutMs: number = DEFAULT_STALE_TIMEOUT_MS,
): Promise<Phase7ClaimResult> {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const { data: insertedRow, error: insertError } = await supabase
    .from("reddit_phase7_processing")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      reddit_item_id: input.redditItemId,
      status: "processing",
      outcome: null,
      attempt_count: 1,
      processing_started_at: nowIso,
      last_error: null,
      last_error_at: null,
    })
    .select(PHASE7_COLUMNS)
    .single();

  if (!insertError) {
    return { kind: "claimed", row: mapRowToPhase7Row(insertedRow as Phase7RowRecord) };
  }

  if (insertError.code !== "23505") {
    console.error("claimPhase7Processing Supabase insert error:", {
      message: insertError.message,
      code: insertError.code,
      details: insertError.details,
      hint: insertError.hint,
    });
    throw new Error("Failed to claim the Phase 7 processing row.");
  }

  // Someone (this pair) already has a row - load it to decide whether
  // it's a terminal outcome, an active claim, or a stale claim safe to
  // reclaim.
  const { data: existingData, error: selectError } = await supabase
    .from("reddit_phase7_processing")
    .select(PHASE7_COLUMNS)
    .eq("project_id", input.projectId)
    .eq("reddit_item_id", input.redditItemId)
    .maybeSingle();

  if (selectError) {
    console.error("claimPhase7Processing Supabase select error:", {
      message: selectError.message,
      code: selectError.code,
      details: selectError.details,
      hint: selectError.hint,
    });
    throw new Error("Failed to look up the existing Phase 7 processing row after a claim conflict.");
  }

  if (!existingData) {
    // Extremely unlikely (the row disappeared between the insert conflict
    // and this lookup) - treat as "someone else currently owns it" rather
    // than silently claiming it here, so this caller never calls the AI
    // provider without a durable claim of its own.
    return { kind: "in_progress" };
  }

  const existingRow = mapRowToPhase7Row(existingData as Phase7RowRecord);

  if (existingRow.status === "completed") {
    return { kind: "already_processed", outcome: existingRow.outcome as Phase7Outcome };
  }

  const startedAtMs = existingRow.processingStartedAt
    ? new Date(existingRow.processingStartedAt).getTime()
    : 0;
  const isStale = Date.now() - startedAtMs > staleTimeoutMs;

  if (!isStale) {
    return { kind: "in_progress" };
  }

  // Guarded reclaim: only succeeds if `processing_started_at` still
  // matches exactly what was just read - if another caller reclaimed it
  // first (or completed it) between that read and this update, this
  // UPDATE matches zero rows instead of racing to claim it twice.
  const { data: reclaimedData, error: reclaimError } = await supabase
    .from("reddit_phase7_processing")
    .update({
      processing_started_at: nowIso,
      attempt_count: existingRow.attemptCount + 1,
      last_error: null,
      last_error_at: null,
    })
    .eq("id", existingRow.id)
    .eq("status", "processing")
    .eq("processing_started_at", existingRow.processingStartedAt as string)
    .select(PHASE7_COLUMNS)
    .maybeSingle();

  if (reclaimError) {
    console.error("claimPhase7Processing Supabase reclaim error:", {
      message: reclaimError.message,
      code: reclaimError.code,
      details: reclaimError.details,
      hint: reclaimError.hint,
    });
    throw new Error("Failed to reclaim the stale Phase 7 processing row.");
  }

  if (!reclaimedData) {
    // Lost the race to another reclaimer between the read above and this
    // guarded update.
    return { kind: "in_progress" };
  }

  return { kind: "claimed", row: mapRowToPhase7Row(reclaimedData as Phase7RowRecord) };
}

/**
 * Finishes a row already claimed via `claimPhase7Processing`, recording
 * its terminal `outcome` and flipping `status` to `"completed"` in one
 * atomic update - the same "mark successful only once the result is
 * durably attached" guarantee `saveQualificationResult` provides for
 * Phase 9. Also clears any `last_error`/`last_error_at` left over from an
 * earlier failed attempt on this same row, so a completed row never shows
 * stale error information. Never reclaimed again once this resolves -
 * `claimPhase7Processing` only ever reclaims rows still `status:
 * "processing"`.
 */
export async function completePhase7Processing(id: string, outcome: Phase7Outcome): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("reddit_phase7_processing")
    .update({ status: "completed", outcome, last_error: null, last_error_at: null })
    .eq("id", id);

  if (error) {
    console.error("completePhase7Processing Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to complete the Phase 7 processing row.");
  }
}

/**
 * Durably records why the most recent attempt on a claimed row did not
 * reach a terminal outcome (a transient AI failure, a malformed AI
 * response, bounded retries exhausted, etc.) WITHOUT touching `status` or
 * `outcome` - the row is deliberately left `status: "processing"` so it
 * stays retryable: `claimPhase7Processing` can safely reclaim it later
 * once its `processing_started_at` goes stale, and it is never left
 * permanently stuck, never marked `"completed"`, and never given a
 * fabricated `outcome`.
 */
export async function recordPhase7ProcessingError(id: string, errorMessage: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("reddit_phase7_processing")
    .update({ last_error: errorMessage, last_error_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("recordPhase7ProcessingError Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to record the Phase 7 processing error.");
  }
}
