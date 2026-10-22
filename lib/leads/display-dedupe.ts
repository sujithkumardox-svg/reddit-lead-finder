import type { LeadSort } from "@/types/reddit-leads";

/**
 * Customer-facing display dedupe for `reddit_leads`.
 *
 * Comparison values are built only to decide which stored rows belong to
 * one group. The returned row is the original record: its title, body, and
 * every other field stay as stored.
 *
 * Callers filter first. A row excluded by a score or date filter is not in
 * the array, so it cannot suppress a row that filter kept.
 */

export type ComparableLeadRow = {
  id: unknown;
  project_id: unknown;
  author_id: unknown;
  title: unknown;
  content: unknown;
  ai_score: unknown;
  created_at: unknown;
  item_created_at?: unknown;
};

/**
 * Reddit account fullname (`t2_` + base36), as stored from
 * `author_fullname`. Usernames and any other string are not a stable
 * account id.
 */
const RELIABLE_AUTHOR_ID = /^t2_[0-9a-z]+$/;

export type DisplayedLeadOptions = {
  sort?: LeadSort;
  limit?: number;
};

/** One stored row per duplicate group. Rows that cannot be compared stay separate. */
export function representativeLeadRows<T extends ComparableLeadRow>(rows: readonly T[]): T[] {
  const groups = new Map<string, T[]>();

  rows.forEach((row, index) => {
    const key = duplicateGroupKey(row) ?? singletonKey(row, index);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  });

  const representatives: T[] = [];
  for (const group of groups.values()) {
    representatives.push(chooseRepresentative(group));
  }
  return representatives;
}

/**
 * Picks representatives, then orders those rows with the existing lead
 * sorts. `limit` is applied to that ordered list.
 */
export function selectDisplayedLeadRows<T extends ComparableLeadRow>(
  rows: readonly T[],
  options: DisplayedLeadOptions = {},
): T[] {
  const sorted = [...representativeLeadRows(rows)].sort((left, right) =>
    compareDisplayed(left, right, options.sort ?? "newest"),
  );
  if (options.limit === undefined) {
    return sorted;
  }
  return sorted.slice(0, options.limit);
}

function duplicateGroupKey(row: ComparableLeadRow): string | null {
  if (typeof row.project_id !== "string" || row.project_id.length === 0) {
    return null;
  }
  if (typeof row.author_id !== "string" || !RELIABLE_AUTHOR_ID.test(row.author_id)) {
    return null;
  }
  if (!isCompleteComparableText(row.title) || !isCompleteComparableText(row.content)) {
    return null;
  }

  return JSON.stringify([
    row.project_id,
    row.author_id,
    normalizeComparisonText(row.title),
    normalizeComparisonText(row.content),
  ]);
}

/** Null, empty, and whitespace-only text is not evidence of an exact duplicate. */
function isCompleteComparableText(value: unknown): value is string {
  return typeof value === "string" && value.replace(/\s/g, "").length > 0;
}

function singletonKey(row: ComparableLeadRow, index: number): string {
  if (typeof row.id === "string" && row.id.length > 0) {
    return JSON.stringify(["row", row.id]);
  }
  return JSON.stringify(["index", index]);
}

/** Case and whitespace only. Not for display and not written back. */
function normalizeComparisonText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function chooseRepresentative<T extends ComparableLeadRow>(group: readonly T[]): T {
  let best = group[0];
  for (let index = 1; index < group.length; index += 1) {
    const candidate = group[index];
    if (compareRepresentative(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Negative when `candidate` should replace `current`.
 * Higher `ai_score`, then older `created_at`, then lesser `id`.
 * A null or non-numeric score loses to any real score and does not become 0.
 */
function compareRepresentative(candidate: ComparableLeadRow, current: ComparableLeadRow): number {
  const candidateScore = finiteNumber(candidate.ai_score);
  const currentScore = finiteNumber(current.ai_score);
  if (candidateScore !== currentScore) {
    if (candidateScore === null) {
      return 1;
    }
    if (currentScore === null) {
      return -1;
    }
    return currentScore - candidateScore;
  }

  const candidateCreated = timestampMs(candidate.created_at);
  const currentCreated = timestampMs(current.created_at);
  if (candidateCreated !== currentCreated) {
    if (candidateCreated === null) {
      return 1;
    }
    if (currentCreated === null) {
      return -1;
    }
    return candidateCreated - currentCreated;
  }

  return compareText(textId(candidate.id), textId(current.id));
}

function compareDisplayed(left: ComparableLeadRow, right: ComparableLeadRow, sort: LeadSort): number {
  if (sort === "oldest") {
    return compareTimestamp(left.item_created_at, right.item_created_at, "asc") || compareText(textId(left.id), textId(right.id));
  }
  if (sort === "highest_score") {
    return (
      compareScore(left.ai_score, right.ai_score, "desc") ||
      compareTimestamp(left.item_created_at, right.item_created_at, "desc") ||
      compareText(textId(left.id), textId(right.id))
    );
  }
  if (sort === "lowest_score") {
    return (
      compareScore(left.ai_score, right.ai_score, "asc") ||
      compareTimestamp(left.item_created_at, right.item_created_at, "desc") ||
      compareText(textId(left.id), textId(right.id))
    );
  }
  return compareTimestamp(left.item_created_at, right.item_created_at, "desc") || compareText(textId(left.id), textId(right.id));
}

function compareScore(left: unknown, right: unknown, direction: "asc" | "desc"): number {
  const leftScore = finiteNumber(left);
  const rightScore = finiteNumber(right);
  if (leftScore === null && rightScore === null) {
    return 0;
  }
  if (leftScore === null) {
    return 1;
  }
  if (rightScore === null) {
    return -1;
  }
  return direction === "asc" ? leftScore - rightScore : rightScore - leftScore;
}

function compareTimestamp(left: unknown, right: unknown, direction: "asc" | "desc"): number {
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === null && rightMs === null) {
    return 0;
  }
  if (leftMs === null) {
    return 1;
  }
  if (rightMs === null) {
    return -1;
  }
  return direction === "asc" ? leftMs - rightMs : rightMs - leftMs;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function textId(value: unknown): string {
  return typeof value === "string" ? value : "";
}
