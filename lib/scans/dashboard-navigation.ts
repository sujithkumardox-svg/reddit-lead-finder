import type { ScanProgressStage } from "@/types/sync-logs";

/**
 * One-shot guard for the post-scan dashboard redirect used by the
 * "Finding Your Leads" polling effect in `NewProjectWizard`.
 *
 * Navigation must fire exactly once per scan, only once the scan has
 * actually reached `"completed"` (a `"failed"` scan must never navigate),
 * and must never depend on lead count - `leadsFound` is never a parameter
 * here, which is what makes that independence structural rather than
 * just a convention someone could accidentally break later.
 *
 * `alreadyNavigated` lets callers stop a poll that is already in flight
 * (or an interval tick that fires before React has cleaned up the
 * polling effect after `scanStage` flips to `"completed"`) from repeating
 * the dashboard navigation for the same scan.
 *
 * Kept in its own plain module (no `"use client"`, no React/Next
 * imports) so it can be unit tested directly - `new-project-wizard.tsx`
 * is a client component that pulls in `next/navigation` and UI
 * components, which this repo's Vitest config (resolving everything
 * through the `"react-server"` condition, for server-only unit tests)
 * cannot import.
 */
export function isCompletedScanReadyToNavigate(
  stage: ScanProgressStage,
  dashboardPath: string | null,
  alreadyNavigated: boolean,
): dashboardPath is string {
  return !alreadyNavigated && stage === "completed" && dashboardPath !== null;
}
