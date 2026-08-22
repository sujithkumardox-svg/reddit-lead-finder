import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { GeminiQueueItemType } from "@/types/gemini-qualification-queue";
import type {
  LeadStats,
  ListLeadsOptions,
  PersistQualifiedLeadInput,
  RedditLeadRow,
  RedditLeadStatus,
  SubredditSafetyBadge,
} from "@/types/reddit-leads";

/**
 * Data access layer for `reddit_leads`. This is the only module allowed to
 * query/mutate that table directly, mirroring the convention already
 * established by `services/gemini-qualification-queue.ts` for the queue
 * table.
 *
 * Phase 10 writes qualified leads via `persistQualifiedLead`. Phase 11
 * reads/updates/deletes them for the customer dashboard. Qualification
 * logic is never changed here.
 */

const LEAD_COLUMNS =
  "id, project_id, user_id, reddit_item_id, item_type, parent_post_id, subreddit, title, content, author, author_id, permalink, score, num_comments, item_created_at, ai_score, ai_match_type, ai_lead_summary, ai_match_reason, ai_possible_competitor, ai_possible_competitor_reason, safety_badge, safety_explanation, status, created_at, updated_at";

type LeadRowRecord = {
  id: unknown;
  project_id: unknown;
  user_id: unknown;
  reddit_item_id: unknown;
  item_type: unknown;
  parent_post_id: unknown;
  subreddit: unknown;
  title: unknown;
  content: unknown;
  author: unknown;
  author_id: unknown;
  permalink: unknown;
  score: unknown;
  num_comments: unknown;
  item_created_at: unknown;
  ai_score: unknown;
  ai_match_type: unknown;
  ai_lead_summary: unknown;
  ai_match_reason: unknown;
  ai_possible_competitor: unknown;
  ai_possible_competitor_reason: unknown;
  safety_badge: unknown;
  safety_explanation: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
};

const SAFETY_BADGES: readonly SubredditSafetyBadge[] = [
  "without_rules",
  "promo_conditional",
  "promo_not_safe",
];

const LEAD_STATUSES: readonly RedditLeadStatus[] = ["new", "reviewed", "contacted", "ignored"];

function asSafetyBadge(value: unknown): SubredditSafetyBadge {
  return SAFETY_BADGES.includes(value as SubredditSafetyBadge)
    ? (value as SubredditSafetyBadge)
    : "without_rules";
}

function asLeadStatus(value: unknown): RedditLeadStatus {
  return LEAD_STATUSES.includes(value as RedditLeadStatus)
    ? (value as RedditLeadStatus)
    : "new";
}

function mapRowToLeadRow(row: LeadRowRecord): RedditLeadRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    redditItemId: row.reddit_item_id as string,
    itemType: row.item_type as GeminiQueueItemType,
    parentPostId: row.parent_post_id as string | null,
    subreddit: (row.subreddit as string | null) ?? "",
    title: row.title as string | null,
    content: (row.content as string | null) ?? "",
    author: (row.author as string | null) ?? "[deleted]",
    authorId: row.author_id as string | null,
    permalink: (row.permalink as string | null) ?? "",
    score: (row.score as number | null) ?? 0,
    numComments: row.num_comments as number | null,
    itemCreatedAt: row.item_created_at as string,
    aiScore: (row.ai_score as number | null) ?? 0,
    aiMatchType: (row.ai_match_type as string | null) ?? "",
    aiLeadSummary: (row.ai_lead_summary as string | null) ?? "",
    aiMatchReason: (row.ai_match_reason as string | null) ?? "",
    aiPossibleCompetitor: row.ai_possible_competitor as string | null,
    aiPossibleCompetitorReason: row.ai_possible_competitor_reason as string | null,
    safetyBadge: asSafetyBadge(row.safety_badge),
    safetyExplanation: (row.safety_explanation as string | null) ?? "",
    status: asLeadStatus(row.status),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

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
 * the Leads UI (`updateLeadStatus`).
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

/**
 * Lists customer-facing qualified leads for one project owned by `userId`.
 * Default sort is newest Reddit item first (`item_created_at` desc), which
 * uses the existing `(project_id, item_created_at desc)` index.
 */
export async function listLeadsByProject(
  userId: string,
  projectId: string,
  options: ListLeadsOptions = {},
): Promise<RedditLeadRow[]> {
  const supabase = await createClient();
  const sort = options.sort ?? "newest";
  const matchFilters = options.matchFilters ?? [];
  const wantsStrong = matchFilters.includes("strong");
  const wantsPartial = matchFilters.includes("partial");

  let query = supabase
    .from("reddit_leads")
    .select(LEAD_COLUMNS)
    .eq("user_id", userId)
    .eq("project_id", projectId);

  if (wantsStrong && !wantsPartial) {
    query = query.gte("ai_score", 8);
  } else if (wantsPartial && !wantsStrong) {
    query = query.gte("ai_score", 6).lte("ai_score", 7);
  } else if (wantsStrong && wantsPartial) {
    query = query.gte("ai_score", 6);
  }

  if (options.dateFrom) {
    query = query.gte("item_created_at", options.dateFrom);
  }
  if (options.dateTo) {
    query = query.lte("item_created_at", options.dateTo);
  }

  if (sort === "oldest") {
    query = query.order("item_created_at", { ascending: true });
  } else if (sort === "highest_score") {
    query = query
      .order("ai_score", { ascending: false })
      .order("item_created_at", { ascending: false });
  } else if (sort === "lowest_score") {
    query = query
      .order("ai_score", { ascending: true })
      .order("item_created_at", { ascending: false });
  } else {
    query = query.order("item_created_at", { ascending: false });
  }

  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error("listLeadsByProject Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to load leads.");
  }

  return ((data ?? []) as LeadRowRecord[]).map(mapRowToLeadRow);
}

/**
 * How many `reddit_leads` this owned project has created at or after
 * `sinceIso`. Used by the first-scan orchestrator to write
 * `sync_logs.leads_found` for this run.
 */
export async function countLeadsCreatedSince(
  userId: string,
  projectId: string,
  sinceIso: string,
): Promise<number> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .from("reddit_leads")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .gte("created_at", sinceIso);

  if (error) {
    console.error("countLeadsCreatedSince Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to count leads.");
  }

  return count ?? 0;
}

/**
 * Simple Dashboard counts for one project. Computed in-process from a
 * narrow `status`/`ai_score` select so we do not add extra schema or RPCs.
 */
export async function getLeadStats(userId: string, projectId: string): Promise<LeadStats> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reddit_leads")
    .select("status, ai_score")
    .eq("user_id", userId)
    .eq("project_id", projectId);

  if (error) {
    console.error("getLeadStats Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to load lead stats.");
  }

  const rows = (data ?? []) as { status: unknown; ai_score: unknown }[];
  const stats: LeadStats = {
    total: rows.length,
    newCount: 0,
    contactedCount: 0,
    strongCount: 0,
    partialCount: 0,
  };

  for (const row of rows) {
    const status = asLeadStatus(row.status);
    if (status === "new") {
      stats.newCount += 1;
    } else if (status === "contacted") {
      stats.contactedCount += 1;
    }

    const score = (row.ai_score as number | null) ?? 0;
    if (score >= 8) {
      stats.strongCount += 1;
    } else if (score >= 6 && score <= 7) {
      stats.partialCount += 1;
    }
  }

  return stats;
}

/**
 * Sets a lead's customer-facing `status`. Scoped to the owning user and
 * project so RLS is not the only guard.
 */
export async function updateLeadStatus(
  userId: string,
  projectId: string,
  leadId: string,
  status: RedditLeadStatus,
): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("reddit_leads")
    .update({ status })
    .eq("id", leadId)
    .eq("user_id", userId)
    .eq("project_id", projectId);

  if (error) {
    console.error("updateLeadStatus Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to update lead status.");
  }
}

/**
 * Permanently deletes one lead. Scoped to the owning user and project.
 */
export async function deleteLead(
  userId: string,
  projectId: string,
  leadId: string,
): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("reddit_leads")
    .delete()
    .eq("id", leadId)
    .eq("user_id", userId)
    .eq("project_id", projectId);

  if (error) {
    console.error("deleteLead Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to delete lead.");
  }
}
