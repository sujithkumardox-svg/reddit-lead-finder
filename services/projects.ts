import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Project, ProjectSummary } from "@/types/project";

export type CreateProjectInput = {
  name: string;
  websiteUrl: string;
  description: string;
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
  /** Never returned to the client - stored for the future Reddit scanning engine. */
  hiddenKeywords: string[];
  /** Never returned to the client - stored for the future Reddit scanning engine. */
  hiddenSubreddits: string[];
};

/**
 * Data access layer for `projects`. This is the only module allowed to
 * query/mutate the `projects` table directly. It always selects an explicit
 * column list so `hidden_keywords`/`subreddits` (hidden fields) can never
 * accidentally leak into a value that reaches a client component.
 */

export async function createProject(
  userId: string,
  input: CreateProjectInput,
): Promise<string> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: userId,
      name: input.name,
      website_url: input.websiteUrl,
      description: input.description,
      keywords: input.keywords,
      intent_phrases: input.intentPhrases,
      pain_phrases: input.painPhrases,
      competitors: input.competitors,
      hidden_keywords: input.hiddenKeywords,
      subreddits: input.hiddenSubreddits,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error("You already have a project for this website.");
    }
    throw new Error("Failed to create project. Please try again.");
  }

  return data.id as string;
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, website_url, description, is_active, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("listProjects Supabase error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    throw new Error("Failed to load projects.");
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    websiteUrl: row.website_url as string,
    description: (row.description as string | null) ?? "",
    isActive: row.is_active as boolean,
    createdAt: row.created_at as string,
  }));
}

export async function getProjectById(
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, name, website_url, description, keywords, intent_phrases, pain_phrases, competitors, is_active, created_at, updated_at",
    )
    .eq("user_id", userId)
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load project.");
  }

  if (!data) {
    return null;
  }

  return {
    id: data.id as string,
    name: data.name as string,
    websiteUrl: data.website_url as string,
    description: (data.description as string | null) ?? "",
    keywords: (data.keywords as string[] | null) ?? [],
    intentPhrases: (data.intent_phrases as string[] | null) ?? [],
    painPhrases: (data.pain_phrases as string[] | null) ?? [],
    competitors: (data.competitors as string[] | null) ?? [],
    isActive: data.is_active as boolean,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}
