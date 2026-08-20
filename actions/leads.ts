"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { deleteLead, updateLeadStatus } from "@/services/reddit-leads";

export type LeadActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function requireUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function markLeadContactedAction(
  projectId: string,
  leadId: string,
): Promise<LeadActionResult> {
  const userId = await requireUserId();
  if (!userId) {
    return { ok: false, error: "You must be signed in." };
  }

  try {
    await updateLeadStatus(userId, projectId, leadId, "contacted");
    revalidatePath(`/projects/${projectId}/leads`);
    revalidatePath(`/projects/${projectId}/dashboard`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to update lead.",
    };
  }
}

export async function deleteLeadAction(
  projectId: string,
  leadId: string,
): Promise<LeadActionResult> {
  const userId = await requireUserId();
  if (!userId) {
    return { ok: false, error: "You must be signed in." };
  }

  try {
    await deleteLead(userId, projectId, leadId);
    revalidatePath(`/projects/${projectId}/leads`);
    revalidatePath(`/projects/${projectId}/dashboard`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to delete lead.",
    };
  }
}
