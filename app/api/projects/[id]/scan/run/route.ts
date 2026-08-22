import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getProjectScanData } from "@/services/projects";
import { runProjectScan } from "@/services/scan-orchestrator";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Long-running Node execution path for a project scan. Session-authenticated;
 * forwards the same cookie-bound Supabase client as the start action.
 * The first-scan CTA uses `after()` + `runProjectScan` directly; this
 * route is the maxDuration-capable HTTP entry that calls the same
 * orchestrator.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const project = await getProjectScanData(user.id, projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
  }

  let syncLogId: string | null = null;
  try {
    const body = (await request.json()) as { syncLogId?: unknown };
    syncLogId = typeof body.syncLogId === "string" ? body.syncLogId : null;
  } catch {
    syncLogId = null;
  }

  if (!syncLogId) {
    return NextResponse.json({ ok: false, error: "Missing syncLogId." }, { status: 400 });
  }

  await runProjectScan({
    userId: user.id,
    projectId,
    syncLogId,
  });

  return NextResponse.json({ ok: true });
}
