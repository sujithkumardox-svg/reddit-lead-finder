import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
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
 * STORAGE/DEDUP FOUNDATION ONLY:
 *   - No AI provider (Gemini Flash-Lite or otherwise) is ever called here.
 *   - No Phase 7 business classification logic lives here - a future Phase
 *     7 classifier decides `"lead"` vs. `"not_a_lead"` elsewhere; this
 *     module only records/looks up that decision.
 *   - Not yet wired into `services/reddit-scan-matching-handler.ts` - that
 *     connection, the Phase 7 AI provider/prompt, and the Phase 7
 *     orchestrator are all later implementation steps.
 *
 * The dedup key is `(project_id, reddit_item_id)`, matching the same
 * project-scoped convention `gemini_qualification_queue` and `reddit_leads`
 * already use.
 */

const PHASE7_COLUMNS = "id, project_id, user_id, reddit_item_id, outcome, created_at, updated_at";

type Phase7RowRecord = {
  id: unknown;
  project_id: unknown;
  user_id: unknown;
  reddit_item_id: unknown;
  outcome: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function mapRowToPhase7Row(row: Phase7RowRecord): Phase7ProcessingRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    redditItemId: row.reddit_item_id as string,
    outcome: row.outcome as Phase7ProcessingRow["outcome"],
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
