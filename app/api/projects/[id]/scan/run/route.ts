import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { resolveScanAccessToken } from "@/lib/supabase/scan-session";
import { getProjectScanData } from "@/services/projects";
import { runProjectScan } from "@/services/scan-orchestrator";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Long-running Node execution path for a project scan. Verifies the
 * session, then runs the scan with that user's access token on one
 * server-only client. The first-scan CTA uses `after()` + `runProjectScan`
 * directly; this route is the maxDuration-capable HTTP entry that calls
 * the same orchestrator.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await context.params;
  const supabase = await createClient();
  const access = await resolveScanAccessToken(supabase.auth);

  if (!access.ok) {
    const status = access.error.includes("rate limited") ? 429 : 401;
    return NextResponse.json({ ok: false, error: access.error }, { status });
  }

  const project = await getProjectScanData(access.userId, projectId);
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
    userId: access.userId,
    projectId,
    syncLogId,
    accessToken: access.accessToken,
  });

  return NextResponse.json({ ok: true });
}
