import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { PersistQualifiedLeadInput } from "@/types/reddit-leads";

/**
 * Data access layer for `reddit_leads` (Phase 10). This is the only module
 * allowed to query/mutate that table directly, mirroring the convention
 * already established by `services/gemini-qualification-queue.ts` for the
 * queue table.
 *
 * Deliberately out of scope here: anything reading `reddit_leads` for
 * display (a future Phase 11 dashboard concern), and any change to how or
 * when a candidate gets qualified - this module only persists an
 * already-qualified result.
 */

/**
 * Upserts one Gemini-qualified (`ai_qualified = true`) candidate into
 * `reddit_leads`, keyed on `(project_id, reddit_item_id)` - the same
 * project-scoped dedup key already used by `gemini_qualification_queue`.
 *
 * Uses `upsert` rather than a plain `insert` so that re-processing the same
 * candidate (e.g. a manual backfill) refreshes the lead instead of
 * throwing a duplicate-key error - `reddit_leads_project_reddit_item_unique`
 * (see the Phase 10 migration) is what makes that conflict target valid.
 *
 * Never writes `status`: an upsert must not reset a lead a customer has
 * already reviewed/contacted back to the `'new'` default, so that column
 * is intentionally absent from the upsert payload and is only ever set by
 * the (future, out of scope) Leads UI.
 */
export async function persistQualifiedLead(input: PersistQualifiedLeadInput): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase.from("reddit_leads").upsert(
    {
      project_id: input.projectId,
      user_id: input.userId,
      reddit_item_id: input.redditItemId,
      item_type: input.itemType,
      parent_post_id: input.parentPostId,
      subreddit: input.subreddit,
      title: input.title,
      content: input.content,
      author: input.author,
      author_id: input.authorId,
      permalink: input.permalink,
      score: input.score,
      num_comments: input.numComments,
      item_created_at: input.itemCreatedAt,
      ai_score: input.aiScore,
      ai_match_type: input.aiMatchType,
      ai_lead_summary: input.aiLeadSummary,
      ai_match_reason: input.aiMatchReason,
      ai_possible_competitor: input.aiPossibleCompetitor,
      ai_possible_competitor_reason: input.aiPossibleCompetitorReason,
      safety_badge: input.safetyBadge,
      safety_explanation: input.safetyExplanation,
    },
    { onConflict: "project_id,reddit_item_id" },
  );

  if (error) {
    console.error("persistQualifiedLead Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to persist qualified lead.");
  }
}
