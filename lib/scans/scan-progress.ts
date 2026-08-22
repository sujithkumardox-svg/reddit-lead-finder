import type { ScanProgressStage } from "@/types/sync-logs";

/** How often the "Finding Your Leads" popup polls scan status. */
export const SCAN_POLL_INTERVAL_MS = 2000;

export function getProjectDashboardPath(projectId: string): string {
  return `/projects/${projectId}/dashboard`;
}

/** Dashboard path when the scan completed successfully; otherwise null. */
export function getCompletedScanRedirect(
  projectId: string,
  stage: ScanProgressStage,
): string | null {
  return stage === "completed" ? getProjectDashboardPath(projectId) : null;
}

/**
 * User-facing progress copy. "Scoring leads" is Gemini qualification, not
 * Phase 8 numerical scoring.
 */
export function getScanProgressLabel(stage: ScanProgressStage): string {
  switch (stage) {
    case "scoring":
      return "Scoring leads";
    case "completed":
      return "Scan complete";
    case "failed":
      return "Scan failed";
    case "scanning":
    case "not_started":
    default:
      return "Finding your leads";
  }
}
