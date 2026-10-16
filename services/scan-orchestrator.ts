import "server-only";

import { createScanMetrics } from "@/lib/scans/scan-metrics";
import { runWithScanAccessToken } from "@/lib/supabase/scan-client";
import { runGeminiQualificationWorker } from "@/services/gemini-qualification-worker";
import { RedditScanMatchingHandler } from "@/services/reddit-scan-matching-handler";
import { scanProjectReddit } from "@/services/reddit-scanner";
import { countLeadsCreatedSince } from "@/services/reddit-leads";
import {
  getScanById,
  markScanFailed,
  markScanSuccess,
  toSafeScanErrorMessage,
} from "@/services/sync-logs";

/**
 * Central first-scan (and future scheduler) pipeline entry point.
 *
 * Composes existing functions only:
 * Reddit scan + Phase 8 matching/enqueue → project-scoped Gemini worker
 * (Phase 9 + Phase 10) → `sync_logs` success/failed.
 *
 * Identity is passed in explicitly. This module does not read cookies.
 * `accessToken` is the verified user JWT captured by the caller. Database
 * calls inside this function reuse one server-only client for that token
 * and never fall back to the anonymous key.
 */
export async function runProjectScan(input: {
  userId: string;
  projectId: string;
  syncLogId: string;
  accessToken: string;
}): Promise<void> {
  return runWithScanAccessToken(input.accessToken, () => executeProjectScan(input));
}

function unfinishedScanMessage(input: {
  phase7Errors: number;
  phase7ConcurrentSkipped: number;
  queueInsertFailed: number;
  phase9Failed: number;
  persistFailed: number;
}): string | null {
  // A live claim left with another worker is not a failed post. It is still
  // unfinished for this scan, so this scan cannot be reported as success.
  const phase7Incomplete = input.phase7Errors > 0 || input.phase7ConcurrentSkipped > 0;
  const queueFailed = input.queueInsertFailed > 0;
  const qualificationFailed = input.phase9Failed > 0;
  const persistFailed = input.persistFailed > 0;
  if (!phase7Incomplete && !queueFailed && !qualificationFailed && !persistFailed) {
    return null;
  }
  if (phase7Incomplete && !queueFailed && !qualificationFailed && !persistFailed) {
    return "The scan could not finish classifying every post.";
  }
  if (queueFailed && !phase7Incomplete && !qualificationFailed && !persistFailed) {
    return "The scan could not queue one or more leads for qualification.";
  }
  if (persistFailed && !phase7Incomplete && !queueFailed && !qualificationFailed) {
    return "The scan could not save a qualified lead. It can be retried without running qualification again.";
  }
  if (!phase7Incomplete && !queueFailed && !persistFailed) {
    return "The scan could not finish qualifying every lead.";
  }
  return "The scan could not finish classifying or qualifying every lead.";
}

async function executeProjectScan(input: {
  userId: string;
  projectId: string;
  syncLogId: string;
}): Promise<void> {
  const { userId, projectId, syncLogId } = input;
  const metrics = createScanMetrics(projectId, syncLogId);
  const totalStartedMs = Date.now();

  try {
    await scanProjectReddit(userId, projectId, new RedditScanMatchingHandler(userId, metrics), {
      metrics,
    });
    const summary = await runGeminiQualificationWorker({ projectId, metrics });
    metrics.qualified = summary.qualified;

    const log = await getScanById(userId, syncLogId);
    const since = log?.startedAt ?? new Date(0).toISOString();
    const leadsFound = await countLeadsCreatedSince(userId, projectId, since);
    metrics.leadsFound = leadsFound;
    metrics.durationsMs.total = Date.now() - totalStartedMs;

    const failureMessage = unfinishedScanMessage({
      phase7Errors: metrics.phase7Errors,
      phase7ConcurrentSkipped: metrics.phase7ConcurrentSkipped,
      queueInsertFailed: metrics.queueInsertFailed,
      phase9Failed: summary.failed,
      persistFailed: summary.persistFailed,
    });
    if (failureMessage) {
      await markScanFailed(syncLogId, failureMessage, metrics);
      return;
    }

    await markScanSuccess(syncLogId, leadsFound, metrics);
  } catch (error) {
    const message = toSafeScanErrorMessage(error);
    metrics.durationsMs.total = Date.now() - totalStartedMs;
    try {
      await markScanFailed(syncLogId, message, metrics);
    } catch (markError) {
      console.error("[scan-orchestrator] Failed to mark scan failed:", markError);
    }
  }
}
