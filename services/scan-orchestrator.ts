import "server-only";

import { createScanMetrics } from "@/lib/scans/scan-metrics";
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
 * Identity is passed in explicitly. This module does not read cookies,
 * session, or UI state, so a future scheduler can call the same function
 * after it has already resolved `userId` / `projectId` / `syncLogId`.
 */
export async function runProjectScan(input: {
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
