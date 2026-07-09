"use server";

import { revalidatePath } from "next/cache";

import { analyzeWebsite } from "@/lib/ai/analyze-website";
import { deriveProjectNameFromUrl, normalizeWebsiteUrl } from "@/lib/ai/website-url";
import { createClient } from "@/lib/supabase/server";
import { createProject } from "@/services/projects";
import type { ProjectDraft } from "@/types/project";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Step 1 of the Create Project wizard: takes only a website URL, fetches
 * and analyzes it, and returns a draft. Nothing is persisted here - the
 * project row is only created once the user confirms the review screen.
 */
export async function analyzeWebsiteAction(
  rawUrl: string,
): Promise<ActionResult<ProjectDraft>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "You must be signed in to create a project." };
  }

  let websiteUrl: string;
  try {
    websiteUrl = normalizeWebsiteUrl(rawUrl);
  } catch {
    return { ok: false, error: "Please enter a valid website URL." };
  }

  try {
    const analysis = await analyzeWebsite(websiteUrl);

    return {
      ok: true,
      data: {
        name: deriveProjectNameFromUrl(websiteUrl),
        websiteUrl,
        ...analysis,
      },
    };
  } catch (error) {
    console.error("Website analysis failed:", error);
    return {
      ok: false,
      error:
        "We couldn't analyze that website. Double-check the URL and try again.",
    };
  }
}

/**
 * Step 2 of the Create Project wizard: persists the (possibly edited) draft
 * as a real project row.
 */
export async function createProjectAction(
  draft: ProjectDraft,
): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "You must be signed in to create a project." };
  }

  const description = draft.description.trim();
  if (!description) {
    return { ok: false, error: "Business description can't be empty." };
  }

  let websiteUrl: string;
  try {
    websiteUrl = normalizeWebsiteUrl(draft.websiteUrl);
  } catch {
    return { ok: false, error: "Invalid website URL." };
  }

  try {
    const id = await createProject(user.id, {
      name: draft.name,
      websiteUrl,
      description,
      keywords: sanitizeList(draft.keywords),
      intentPhrases: sanitizeList(draft.intentPhrases),
      painPhrases: sanitizeList(draft.painPhrases),
      competitors: sanitizeList(draft.competitors),
      hiddenKeywords: sanitizeList(draft.hiddenKeywords),
      hiddenSubreddits: sanitizeList(draft.hiddenSubreddits),
    });

    revalidatePath("/projects");

    return { ok: true, data: { id } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to create project.",
    };
  }
}

function sanitizeList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}
