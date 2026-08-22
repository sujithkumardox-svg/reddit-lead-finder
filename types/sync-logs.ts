/**
 * Shapes for `public.sync_logs` - the existing per-project scan-run audit
 * table. User-facing stages such as "scanning" / "Scoring leads" are
 * inferred in application code; they are not stored as a status enum.
 */

export type SyncLogStatus = "running" | "success" | "failed";

/** A row of `sync_logs`, in camelCase. */
export type SyncLogRow = {
  id: string;
  projectId: string;
  userId: string;
  status: SyncLogStatus;
  leadsFound: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * User-facing first-scan progress. Derived from `sync_logs.status` plus
 * whether this project has Gemini queue rows created since `started_at`.
 * "scoring" means Gemini qualification ("Scoring leads"), not Phase 8.
 */
export type ScanProgressStage =
  | "not_started"
  | "scanning"
  | "scoring"
  | "completed"
  | "failed";
