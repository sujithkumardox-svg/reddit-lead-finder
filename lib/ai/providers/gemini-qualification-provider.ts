import "server-only";

import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

import type { AiMatchType, QualifyRedditCandidateInput } from "@/lib/ai/qualify-reddit-candidate";
import type {
  CoreQualificationResult,
  EnrichmentResult,
  QualificationProvider,
} from "@/lib/ai/providers/qualification-provider";

/**
 * Gemini implementation of the Phase 9 `QualificationProvider` contract.
 *
 * All Gemini/AI-SDK-specific code (the `google(...)` model descriptor, the
 * `generateObject` calls, the Zod schemas, and the full prompt text) lives
 * here and ONLY here - `lib/ai/qualify-reddit-candidate.ts` (the Phase 9
 * orchestrator) never imports `ai`, `@ai-sdk/google`, or `zod`, and depends
 * only on this file's exported `geminiQualificationProvider` via the
 * `QualificationProvider` interface.
 *
 * Split into two Gemini calls (Phase 9 score-first gating, unchanged
 * scoring/classification/qualification semantics from the prior single-call
 * design - see `qualifyCore` and `generateEnrichment` below):
 *
 *   1. `qualifyCore` - determines `aiScore`, `aiMatchType`, and Gemini's own
 *      `aiQualified` judgment. This is the ONLY call made when the
 *      orchestrator decides `aiScore < 6` (its schema/prompt never mentions
 *      enrichment fields, so Gemini cannot produce them here).
 *   2. `generateEnrichment` - only ever invoked by the orchestrator when
 *      `aiScore >= 6`. Its prompt explicitly states the already-decided
 *      `aiMatchType`/`aiScore` as established facts and instructs Gemini
 *      not to re-classify or re-score - it must only explain/enrich the
 *      qualification that already happened in step 1.
 *
 * `AI_MODEL` and its default (`gemini-3.5-flash`) are unchanged from the
 * prior single-call implementation.
 */

const AI_MODEL = process.env.AI_MODEL || "gemini-3.5-flash";

/** The five approved aiMatchType values (Phase 9B-1, locked) - unchanged. */
const AI_MATCH_TYPES = [
  "intent",
  "pain_point",
  "competitor_mention",
  "general_discussion",
  "not_relevant",
] as const satisfies readonly AiMatchType[];

/**
 * Structured output schema for Gemini's core qualification call (score,
 * classification, qualified judgment only). Pure shape/range/enum
 * validation only - the aiQualified/aiScore/aiMatchType consistency rules
 * (e.g. not_relevant -> aiQualified must be false) are enforced afterward
 * by `normalizeAiQualified` in the orchestrator, exactly as before this
 * split.
 */
const coreQualificationSchema = z
  .object({
    aiScore: z
      .number()
      .int()
      .min(0)
      .max(10)
      .describe(
        "Overall lead-quality score as an integer from 0 to 10 (no decimals). 8-10 = Strong Match, 6-7 = Partial Match, 0-5 = Not Qualified. Judge independently from the actual Reddit content and project fit - never from keyword/phrase match counts.",
      ),
    aiMatchType: z
      .enum(AI_MATCH_TYPES)
      .describe(
        "Single primary classification. When multiple signals are present, apply the fixed priority: intent > competitor_mention > pain_point > general_discussion > not_relevant.",
      ),
    aiQualified: z
      .boolean()
      .describe(
        "Whether this candidate is a genuine, actionable lead worth surfacing. Must be false for not_relevant and general_discussion, and false whenever aiScore is 0-5. For intent/pain_point/competitor_mention with aiScore 6-10, judge independently based on actual lead quality.",
      ),
  })
  .strict();

/**
 * Structured output schema for Gemini's enrichment call. Only ever
 * requested when the core call already produced `aiScore >= 6` - see
 * `generateEnrichment`'s prompt, which treats that score and the
 * classification as fixed, already-decided facts.
 */
const enrichmentSchema = z
  .object({
    aiLeadSummary: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise 1-2 sentence summary for the business owner explaining who this person is and why this candidate matters. Never reference the Reddit author's username.",
      ),
    aiMatchReason: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise explanation, grounded in the actual Reddit content and project context, of why the already-determined classification and score fit this candidate. Do not propose a different classification or score.",
      ),
    aiPossibleCompetitor: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "A real, identifiable competitor/company/product name only if the Reddit content provides credible evidence. Null when no real competitor is identified. Never invent, guess, or infer a name, and never return a name solely because it appears in the project's competitor list.",
      ),
    aiPossibleCompetitorReason: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Concise explanation of specifically why aiPossibleCompetitor was flagged, grounded in the actual Reddit content. Must be null whenever aiPossibleCompetitor is null, and non-null whenever it is not null.",
      ),
  })
  .strict();

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none provided)";
}

/**
 * Shared PROJECT CONTEXT + CANDIDATE CONTENT block both Gemini calls need:
 * the enrichment call must be grounded in the same actual Reddit content
 * and project context as the core call, not just the bare classification.
 */
function buildContextPrompt({ candidate, project }: QualifyRedditCandidateInput): string {
  return [
    "PROJECT CONTEXT",
    "",
    `Business description: ${project.description}`,
    "",
    `Keywords the business associates with its space: ${formatList(project.keywords)}`,
    "",
    `Phrases that signal someone is looking for a solution like this: ${formatList(project.intentPhrases)}`,
    "",
    `Phrases that signal someone is frustrated with the problem this business solves: ${formatList(project.painPhrases)}`,
    "",
    `Known competitors in this space: ${formatList(project.competitors)}`,
    "",
    "CANDIDATE REDDIT CONTENT",
    "",
    `Type: ${candidate.itemType}`,
    `Subreddit: r/${candidate.subreddit}`,
    `Title: ${candidate.title ?? "(none - this is a comment)"}`,
    "Content:",
    candidate.matchedText,
    "",
    `Reddit score: ${candidate.redditScore}`,
    `Posted at: ${candidate.itemCreatedAt}`,
    `Permalink: ${candidate.permalink}`,
  ].join("\n");
}

function buildCoreUserPrompt(input: QualifyRedditCandidateInput): string {
  return buildContextPrompt(input);
}

function buildEnrichmentUserPrompt(
  input: QualifyRedditCandidateInput,
  core: CoreQualificationResult,
): string {
  return [
    buildContextPrompt(input),
    "",
    "ALREADY-DETERMINED QUALIFICATION (established fact - do not re-decide)",
    "",
    `aiMatchType: ${core.aiMatchType}`,
    `aiScore: ${core.aiScore}`,
    "",
    "The qualification decision above has already been made by a separate step. Treat aiMatchType and aiScore as fixed facts. Do not reclassify this candidate, do not propose a different score, and do not contradict this decision - only generate enrichment consistent with it.",
  ].join("\n");
}

const CORE_SYSTEM_PROMPT = `You are a lead-qualification analyst.

Evaluate the provided Reddit post for the specific customer business.

Use the customer's business description and any provided keywords, intent phrases, pain phrases, or competitors only as context for understanding what the business does.

Read the FULL Reddit title and body. Judge the actual meaning and situation described in the post, not simple keyword overlap.

A strong lead is a person with a real need, problem, goal, or intent that the customer's business could reasonably help with.

The person does NOT need to explicitly ask for a product, tool, service, or recommendation. A strong indirect need or pain can be a strong lead when the post provides clear evidence and the business fit is strong.

### SCORING

Score the overall strength of the opportunity from 0–10.

Base the score on:
- the strength and clarity of the person's need, problem, goal, or intent,
- how closely that need fits what the customer's business can help with,
- and the evidence in the Reddit post showing that the opportunity is real and meaningful.

A lead does not need to explicitly ask for a solution to be a strong opportunity. A strong need, problem, goal, or intent can score 8–10 even when the person does not ask for a product, tool, service, or recommendation.

- 8–10: Strong opportunity — strong evidence of a meaningful need, problem, goal, or intent with strong business fit. This can be direct or indirect.
- 5–7: Meaningful opportunity — a real and relevant opportunity, but the need, evidence, business fit, or actionability is weaker than a strong opportunity.
- 0–4: Insufficient opportunity — weak, vague, unclear, poorly supported, or not meaningfully relevant to the business.

Competitive behaviour or competitor mentions must not influence the score. Evaluate the lead opportunity independently.

Choose exactly one aiMatchType:
- "intent" — actively seeking a solution, recommendation, or way to solve the problem.
- "pain_point" — describing a real relevant problem, frustration, or limitation.
- "competitor_mention" — a specific named competitor is a central part of the post.
- "general_discussion" — relevant to the business but without a clear intent or meaningful pain point.
- "not_relevant" — not meaningfully relevant to the business.

Set aiQualified to true when aiScore is 5–10, otherwise false.

Output only:
aiScore
aiMatchType
aiQualified`;

const ENRICHMENT_SYSTEM_PROMPT = `You are writing customer-facing enrichment for a Reddit post that has already been qualified.

The Core qualification decision is already final. Treat aiScore, aiMatchType, and aiQualified as fixed. Do not re-qualify, rescore, or contradict them.

Use the customer's business context and the FULL Reddit title and body.

### aiLeadSummary

Write a concise 1–2 sentence summary explaining what the person needs, what problem they have, or why the post is relevant to the business.

### aiMatchReason

Write a concise 1–2 sentence explanation of why the existing aiMatchType and aiScore fit the actual Reddit content and the customer's business. Do not introduce a different score or classification.

### aiPossibleCompetitor

Independently check whether the Reddit content shows credible competitive behaviour.

Competitive behaviour includes things such as designing, building, launching, marketing, promoting, or operating a product or service that is meaningfully similar to the customer's business.

This is a separate signal from lead qualification. It must NOT increase or decrease aiScore or determine aiQualified.

If a competing company or product is clearly identified in the post, return its actual name.

If the post clearly shows competitive behaviour but no company or product name is identifiable, return "Potential Competitor".

If there is no credible competitive behaviour, return null.

Never invent or guess a competitor name. The customer's competitor list is only background context and is not evidence by itself.

Only customer-visible enrichment is generated for aiScore 5–10. Therefore, competitive behaviour must not be shown to the customer when aiScore is below 5.

### aiPossibleCompetitorReason

If aiPossibleCompetitor is not null, briefly explain the specific competitive behaviour found in the Reddit content.

If aiPossibleCompetitor is null, return null.

Output only:
aiLeadSummary
aiMatchReason
aiPossibleCompetitor
aiPossibleCompetitorReason

Do not output aiScore or aiMatchType.`;

async function qualifyCore(input: QualifyRedditCandidateInput): Promise<CoreQualificationResult> {
  const { object } = await generateObject({
    model: google(AI_MODEL),
    schema: coreQualificationSchema,
    system: CORE_SYSTEM_PROMPT,
    prompt: buildCoreUserPrompt(input),
  });

  return object;
}

async function generateEnrichment(
  input: QualifyRedditCandidateInput,
  core: CoreQualificationResult,
): Promise<EnrichmentResult> {
  const { object } = await generateObject({
    model: google(AI_MODEL),
    schema: enrichmentSchema,
    system: ENRICHMENT_SYSTEM_PROMPT,
    prompt: buildEnrichmentUserPrompt(input, core),
  });

  return object;
}

/** The only `QualificationProvider` implementation today. See this module's doc comment. */
export const geminiQualificationProvider: QualificationProvider = {
  id: "google",
  model: AI_MODEL,
  qualifyCore,
  generateEnrichment,
};
