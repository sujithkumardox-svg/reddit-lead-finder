import "server-only";

import { RedditApiError } from "@/lib/reddit/reddit-api-client";
import { createClient } from "@/lib/supabase/server";
import type {
  ScanProgressStage,
  SyncLogRow,
  SyncLogStatus,
} from "@/types/sync-logs";

/**
 * Data access layer for `public.sync_logs` - the existing per-project
 * scan-run table. This is the only module allowed to query/mutate that
 * table directly. No new scan_jobs table is introduced.
 *
 * First-scan slice capabilities: insert a running scan, mark success or
 * failed, read the latest row, detect an overlapping non-stale running
 * scan, and treat stale `running` rows as failed so a crashed scan cannot
 * lock the project forever.
 */

const SYNC_LOG_COLUMNS =
  "id, project_id, user_id, status, leads_found, error_message, started_at, completed_at, created_at, updated_at";

/** A `running` row older than this is treated as failed so the lock cannot stick. */
export const STALE_RUNNING_TIMEOUT_MS = 15 * 60 * 1000;

export const STALE_RUNNING_ERROR_MESSAGE =
  "The scan stopped responding and was marked failed so a new scan can start.";

const SYNC_LOG_STATUSES: readonly SyncLogStatus[] = ["running", "success", "failed"];

type SyncLogRecord = {
  id: unknown;
  project_id: unknown;
  user_id: unknown;
  status: unknown;
  leads_found: unknown;
  error_message: unknown;
  started_at: unknown;
  completed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function asStatus(value: unknown): SyncLogStatus {
  return SYNC_LOG_STATUSES.includes(value as SyncLogStatus)
    ? (value as SyncLogStatus)
    : "failed";
}

function mapRowToSyncLog(row: SyncLogRecord): SyncLogRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    userId: row.user_id as string,
    status: asStatus(row.status),
    leadsFound: (row.leads_found as number | null) ?? 0,
    errorMessage: row.error_message as string | null,
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function isStaleRunning(row: SyncLogRow, nowMs: number = Date.now()): boolean {
  return row.status === "running" && nowMs - new Date(row.startedAt).getTime() > STALE_RUNNING_TIMEOUT_MS;
}

/**
 * Maps an unknown failure to a short, secret-free message safe to store on
 * `sync_logs.error_message` and show in the first-scan popup. Never includes
 * env values, tokens, or raw provider payloads.
 */
export function toSafeScanErrorMessage(error: unknown): string {
  if (error instanceof RedditApiError) {
    if (/missing reddit api credentials/i.test(error.message)) {
      return "Reddit scanning is not configured.";
    }
    return "The Reddit scan failed. Please try again.";
  }

  if (error instanceof Error && error.message === "Project not found.") {
    return "Project not found.";
  }

  return "The scan failed. Please try again.";
}

/**
 * Infers the user-facing first-scan stage from the latest `sync_logs` row
 * and whether this project has any Gemini queue rows created since that
 * row's `started_at`. Phase 8 is never exposed as its own stage.
 */
export function inferScanStage(input: {
  latest: SyncLogRow | null;
  hasQueueRowsSinceStart: boolean;
}): ScanProgressStage {
  if (!input.latest) {
    return "not_started";
  }

  if (input.latest.status === "success") {
    return "completed";
  }

  if (input.latest.status === "failed") {
    return "failed";
  }

  return input.hasQueueRowsSinceStart ? "scoring" : "scanning";
}

/**
 * Inserts a `running` scan-run row. Callers must refuse first when
 * `getBlockingRunningScan` returns a row.
 */
export async function insertRunningScan(
  userId: string,
  projectId: string,
): Promise<SyncLogRow> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sync_logs")
    .insert({
      project_id: projectId,
      user_id: userId,
      status: "running",
      leads_found: 0,
    })
    .select(SYNC_LOG_COLUMNS)
    .single();

  if (error) {
    console.error("insertRunningScan Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to start scan.");
  }

  return mapRowToSyncLog(data as SyncLogRecord);
}

export async function markScanSuccess(syncLogId: string, leadsFound: number): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("sync_logs")
    .update({
      status: "success",
      leads_found: leadsFound,
      error_message: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", syncLogId);

  if (error) {
    console.error("markScanSuccess Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to record scan success.");
  }
}

export async function markScanFailed(syncLogId: string, errorMessage: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from("sync_logs")
    .update({
      status: "failed",
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", syncLogId);

  if (error) {
    console.error("markScanFailed Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to record scan failure.");
  }
}

/** Latest scan-run for this owned project, newest `started_at` first. */
export async function getLatestScan(
  userId: string,
  projectId: string,
): Promise<SyncLogRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sync_logs")
    .select(SYNC_LOG_COLUMNS)
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("getLatestScan Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to load scan status.");
  }

  return data ? mapRowToSyncLog(data as SyncLogRecord) : null;
}

export async function getScanById(
  userId: string,
  syncLogId: string,
): Promise<SyncLogRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sync_logs")
    .select(SYNC_LOG_COLUMNS)
    .eq("user_id", userId)
    .eq("id", syncLogId)
    .maybeSingle();

  if (error) {
    console.error("getScanById Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to load scan status.");
  }

  return data ? mapRowToSyncLog(data as SyncLogRecord) : null;
}

/**
 * Marks every stale `running` row for this project as `failed`. Returns
 * how many rows were updated. A stale running scan must not lock the
 * project forever.
 */
export async function failStaleRunningScans(
  userId: string,
  projectId: string,
): Promise<number> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - STALE_RUNNING_TIMEOUT_MS).toISOString();

  const { data, error } = await supabase
    .from("sync_logs")
    .update({
      status: "failed",
      error_message: STALE_RUNNING_ERROR_MESSAGE,
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");

  if (error) {
    console.error("failStaleRunningScans Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to recover stale scans.");
  }

  return (data ?? []).length;
}

/**
 * Current non-stale `running` row for this project, if any. Stale running
 * rows are failed first so they cannot block a new scan.
 */
export async function getBlockingRunningScan(
  userId: string,
  projectId: string,
): Promise<SyncLogRow | null> {
  await failStaleRunningScans(userId, projectId);

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sync_logs")
    .select(SYNC_LOG_COLUMNS)
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("getBlockingRunningScan Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to check for a running scan.");
  }

  if (!data) {
    return null;
  }

  const row = mapRowToSyncLog(data as SyncLogRecord);
  return isStaleRunning(row) ? null : row;
}
