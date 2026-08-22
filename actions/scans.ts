"use server";

import { after } from "next/server";

import { getCompletedScanRedirect } from "@/lib/scans/scan-progress";
import { createClient } from "@/lib/supabase/server";
import { countProjectQueueRowsSince } from "@/services/gemini-qualification-queue";
import { getProjectScanData } from "@/services/projects";
import { runProjectScan } from "@/services/scan-orchestrator";
import {
  getBlockingRunningScan,
  getLatestScan,
  inferScanStage,
  insertRunningScan,
} from "@/services/sync-logs";
import type { ScanProgressStage } from "@/types/sync-logs";

export type StartProjectScanResult =
  | { ok: true; syncLogId: string }
  | { ok: false; error: string };

export type ProjectScanStatus = {
  stage: ScanProgressStage;
  syncLogId: string | null;
  leadsFound: number;
  errorMessage: string | null;
  dashboardPath: string | null;
};

export type ProjectScanStatusResult =
  | { ok: true; data: ProjectScanStatus }
  | { ok: false; error: string };

/**
 * Authenticated first-scan start. Creates a `sync_logs` running row and
 * schedules `runProjectScan` via `after()` so this action returns
 * immediately. The browser must never wait for Reddit + Gemini.
 */
export async function startProjectScanAction(projectId: string): Promise<StartProjectScanResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "You must be signed in to start a scan." };
  }

  const project = await getProjectScanData(user.id, projectId);
  if (!project) {
    return { ok: false, error: "Project not found." };
  }

  const running = await getBlockingRunningScan(user.id, projectId);
  if (running) {
    return { ok: false, error: "A scan is already running for this project." };
  }

  const log = await insertRunningScan(user.id, projectId);

  after(() => {
    void runProjectScan({
      userId: user.id,
      projectId,
      syncLogId: log.id,
    });
  });

  return { ok: true, syncLogId: log.id };
}

/**
 * Authenticated scan progress for the "Finding Your Leads" popup.
 * Stages are inferred from `sync_logs` plus Gemini queue rows - no new
 * database enum/column.
 */
export async function getProjectScanStatusAction(
  projectId: string,
): Promise<ProjectScanStatusResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "You must be signed in to view scan status." };
  }

  const project = await getProjectScanData(user.id, projectId);
  if (!project) {
    return { ok: false, error: "Project not found." };
  }

  const latest = await getLatestScan(user.id, projectId);
  let hasQueueRowsSinceStart = false;

  if (latest?.status === "running") {
    hasQueueRowsSinceStart = (await countProjectQueueRowsSince(projectId, latest.startedAt)) > 0;
  }

  const stage = inferScanStage({ latest, hasQueueRowsSinceStart });

  return {
    ok: true,
    data: {
      stage,
      syncLogId: latest?.id ?? null,
      leadsFound: latest?.leadsFound ?? 0,
      errorMessage: latest?.errorMessage ?? null,
      dashboardPath: getCompletedScanRedirect(projectId, stage),
    },
  };
}
