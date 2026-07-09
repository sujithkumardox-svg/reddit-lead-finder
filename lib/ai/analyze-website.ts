import "server-only";

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";

import { fetchWebsiteContent } from "@/lib/ai/fetch-website-content";
import type { WebsiteAnalysis } from "@/types/project";

const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";

const websiteAnalysisSchema = z.object({
  description: z
    .string()
    .describe(
      "A 2-4 sentence description of what the business/product does and who it is for.",
    ),
  keywords: z
    .array(z.string())
    .describe(
      "Around 20 keywords and short phrases people would use when searching for or discussing this kind of product.",
    ),
  hiddenKeywordVariations: z
    .array(z.string())
    .describe(
      "Up to 100 additional keyword variations, synonyms, misspellings, and long-tail phrasings for internal lead matching. This list is never shown to the end user.",
    ),
  intentPhrases: z
    .array(z.string())
    .describe(
      "Around 15 short phrases that signal someone is actively looking for a solution like this (e.g. 'best tool for...', 'looking for an alternative to...').",
    ),
  painPhrases: z
    .array(z.string())
    .describe(
      "Around 15 short phrases that signal someone is frustrated with, or complaining about, the problem this business solves.",
    ),
  competitors: z
    .array(z.string())
    .describe("Up to 5 real competitor product or company names."),
  hiddenSubreddits: z
    .array(z.string())
    .describe(
      "Exactly 10 subreddit names (no 'r/' prefix) most likely to contain people discussing this problem space. This list is never shown to the end user.",
    ),
});

/**
 * Fetches the given website and asks the AI model to analyze it, producing
 * both the fields users see/edit and the fields that stay hidden forever
 * (hidden keyword variations, hidden subreddits) for later use by the
 * Reddit scanning engine.
 */
export async function analyzeWebsite(url: string): Promise<WebsiteAnalysis> {
  const content = await fetchWebsiteContent(url);

  const prompt = [
    `Website URL: ${url}`,
    content.title && `Page title: ${content.title}`,
    content.metaDescription && `Meta description: ${content.metaDescription}`,
    content.headings.length > 0 && `Headings: ${content.headings.join(" | ")}`,
    `Page content:\n${content.bodyText}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { object } = await generateObject({
    model: openai(AI_MODEL),
    schema: websiteAnalysisSchema,
    system:
      "You are a market research assistant for a Reddit lead-generation tool. Given a website's content, infer what the business does and generate structured data used to find potential customers discussing related problems on Reddit. Be specific to this business, not generic. Respond only with data grounded in the provided content.",
    prompt,
  });

  return {
    description: object.description.trim(),
    keywords: dedupeAndTrim(object.keywords),
    hiddenKeywords: dedupeAndTrim(object.hiddenKeywordVariations),
    intentPhrases: dedupeAndTrim(object.intentPhrases),
    painPhrases: dedupeAndTrim(object.painPhrases),
    competitors: dedupeAndTrim(object.competitors),
    hiddenSubreddits: dedupeAndTrim(object.hiddenSubreddits),
  };
}

function dedupeAndTrim(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}
