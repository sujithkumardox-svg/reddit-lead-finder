import "server-only";

import {
  representativeLeadRows,
  selectDisplayedLeadRows,
  type ComparableLeadRow,
} from "@/lib/leads/display-dedupe";
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

const LEAD_STATS_COLUMNS = "id, project_id, author_id, title, content, ai_score, created_at, status";

/** PostgREST page size. Rows are read until the exact count is reached, then deduped. */
export const LEAD_READ_PAGE_SIZE = 1000;

type LeadSupabase = Awaited<ReturnType<typeof createClient>>;

type LeadReadError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

type LeadReadPage = {
  data: unknown;
  error: LeadReadError | null;
  count?: number | null;
};

type PageableLeadQuery = {
  order: (
    column: string,
    options: { ascending: boolean },
  ) => {
    range: (from: number, to: number) => PromiseLike<LeadReadPage>;
  };
};

type LeadStatRow = ComparableLeadRow & { status: unknown };

function buildProjectLeadQuery(
  supabase: LeadSupabase,
  userId: string,
  projectId: string,
  columns: string,
  options: ListLeadsOptions = {},
): PageableLeadQuery {
  const matchFilters = options.matchFilters ?? [];
  const wantsStrong = matchFilters.includes("strong");
  const wantsPartial = matchFilters.includes("partial");

  let query = supabase
    .from("reddit_leads")
    .select(columns, { count: "exact" })
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

  return query as unknown as PageableLeadQuery;
}

function leadRowId(row: unknown): string | null {
  if (typeof row !== "object" || row === null || !("id" in row)) {
    return null;
  }
  const id = row.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Reads every filtered row for one owned project. Pages by primary key so a
 * response cap cannot split a duplicate group or stop the preview early.
 * A short page while `count` says more rows remain is treated as that cap,
 * and the next page continues at the following offset.
 */
async function fetchEveryMatchingLeadRow(
  buildFilteredQuery: () => PageableLeadQuery,
  logLabel: string,
  failureMessage: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let pageSize = LEAD_READ_PAGE_SIZE;
  let total: number | null = null;

  for (;;) {
    const { data, error, count } = await buildFilteredQuery()
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`${logLabel} Supabase error:`, {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });
      throw new Error(failureMessage);
    }

    if (total === null && typeof count === "number") {
      total = count;
    }

    const batch = Array.isArray(data) ? data : [];
    if (batch.length === 0) {
      break;
    }

    let freshCount = 0;
    for (const row of batch) {
      const id = leadRowId(row);
      if (id !== null) {
        if (seenIds.has(id)) {
          continue;
        }
        seenIds.add(id);
      }
      rows.push(row);
      freshCount += 1;
    }

    if (freshCount === 0) {
      break;
    }

    offset += batch.length;
    if (total !== null && offset >= total) {
      break;
    }
    if (batch.length < pageSize) {
      if (total !== null && offset < total) {
        pageSize = batch.length;
        continue;
      }
      break;
    }
  }

  return rows;
}

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

function asSafetyBadge(value: unknown): SubredditSafetyBadge | null {
  return SAFETY_BADGES.includes(value as SubredditSafetyBadge)
    ? (value as SubredditSafetyBadge)
    : null;
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
    safetyExplanation: (row.safety_explanation as string | null) ?? null,
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

  // supabase-js does not return written rows unless `.select()` is chained.
  // The returned representation is the row this upsert modified. It is checked
  // against this project, owner, and Reddit item. An error, or a response
  // with no matching row, means this write is not confirmed.
  const { data, error } = await supabase
    .from("reddit_leads")
    .upsert(
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
        safety_badge: input.safetyBadge ?? null,
        safety_explanation: input.safetyExplanation ?? null,
      },
      { onConflict: "project_id,reddit_item_id" },
    )
    .select("id, project_id, user_id, reddit_item_id")
    .maybeSingle();

  const persisted = data as {
    project_id?: string;
    user_id?: string;
    reddit_item_id?: string;
  } | null;
  const confirmed =
    persisted?.project_id === input.projectId &&
    persisted.user_id === input.userId &&
    persisted.reddit_item_id === input.redditItemId;

  if (error || !confirmed) {
    console.error("persistQualifiedLead Supabase error:", {
      message: error?.message ?? "The qualified lead upsert did not return the intended row.",
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
    });
    throw new Error("Failed to persist qualified lead.");
  }
}

/**
 * Lists customer-facing qualified leads for one project owned by `userId`.
 * Duplicate display groups are collapsed after the existing score and date
 * filters. Representatives are then ordered (newest Reddit item by default)
 * and `options.limit` is applied to that list. The dashboard preview passes
 * `limit: 4`.
 */
export async function listLeadsByProject(
  userId: string,
  projectId: string,
  options: ListLeadsOptions = {},
): Promise<RedditLeadRow[]> {
  const supabase = await createClient();
  const rows = await fetchEveryMatchingLeadRow(
    () => buildProjectLeadQuery(supabase, userId, projectId, LEAD_COLUMNS, options),
    "listLeadsByProject",
    "Failed to load leads.",
  );

  return selectDisplayedLeadRows(rows as LeadRowRecord[], {
    sort: options.sort ?? "newest",
    limit: options.limit,
  }).map(mapRowToLeadRow);
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
 * Dashboard counts for one project. Each duplicate display group contributes
 * its representative, using that row's status and AI score. `reviewed` and
 * `ignored` still count only toward the total.
 */
export async function getLeadStats(userId: string, projectId: string): Promise<LeadStats> {
  const supabase = await createClient();
  const data = await fetchEveryMatchingLeadRow(
    () => buildProjectLeadQuery(supabase, userId, projectId, LEAD_STATS_COLUMNS),
    "getLeadStats",
    "Failed to load lead stats.",
  );
  const rows = representativeLeadRows(data as LeadStatRow[]);
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
