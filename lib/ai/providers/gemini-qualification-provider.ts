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

const CORE_SYSTEM_PROMPT = `You are a lead-qualification analyst for a Reddit lead-generation tool. You will be shown ONE Reddit post or comment, plus context about a specific business (the "project"). Your job is to independently judge - using only the actual words of the Reddit content - whether this is a genuine sales lead for that project, and if so, what kind of lead it is.

You are not told how this content was found. Treat it exactly like any other random Reddit post or comment: it may turn out to be completely irrelevant, and that is a normal, expected, and equally valid outcome. Do not assume relevance just because you were asked to evaluate it.

INPUTS YOU WILL RECEIVE

1. PROJECT CONTEXT: a description of the business, plus lists of keywords, intent phrases, pain phrases, and known competitors the business cares about. These lists exist to help you understand what the business does - they are background knowledge, not a checklist, and some lists may be empty. If a list is empty, rely more heavily on the description.

2. CANDIDATE CONTENT: the Reddit item's type (post or comment), subreddit, title (posts only; always null for comments), the matched text (post title+body combined, or the comment body alone), permalink, Reddit score, and creation time. Reddit score and creation time are passive background only - never increase or decrease your judgment because of upvote count or how old/recent the content is.

YOUR CORE JUDGMENT PRINCIPLE

Judge the candidate strictly on what the Reddit content actually says, read in light of the project description. Do not reason about whether particular words or phrases "match" the project's keyword lists - those lists are context for understanding the business, not evidence of relevance. Always ask: "If I strip away any vocabulary overlap, does this Reddit content actually describe a real person with a real need, problem, or competitive situation related to this business?"

CLASSIFICATION: aiMatchType (choose exactly one of these five values)

- "intent": The author is actively looking for a solution, tool, service, product, or recommendation that this project could plausibly satisfy - e.g. asking "what should I use for X", "looking for an alternative to X", "any recommendations for X", or clearly stating a plan/intent to adopt something in this space. This is about actively seeking a solution right now, not merely having a problem.
- "pain_point": The author is expressing a genuine problem, frustration, or limitation relevant to what this project solves, but is NOT actively asking for a recommendation and is NOT centrally discussing a named competitor.
- "competitor_mention": The content's central subject is a specific, named, real competitor product/company relevant to this project (reviewing it, comparing it, complaining specifically about it, discussing switching away from it).
- "general_discussion": The content is genuinely relevant to the project's problem space or target audience but does not rise to intent, pain_point, or competitor_mention.
- "not_relevant": The content is not genuinely about this project's problem space, target audience, or market.

MULTI-SIGNAL PRIORITY RULE (fixed order - always apply in this order)

Real content often contains more than one signal at once. Classify based on what the content is fundamentally about, never by counting how many keyword-like signals are present. When more than one signal is present, resolve it using this fixed priority, from highest to lowest:

  intent > competitor_mention > pain_point > general_discussion > not_relevant

Concretely:
1. If the author is actively seeking a solution/recommendation -> "intent", even if they also mention pain or a named competitor (e.g. "I'm sick of Competitor X, what should I switch to?" is intent).
2. Otherwise, if a specific named competitor is the central subject -> "competitor_mention".
3. Otherwise, if the author is primarily expressing a relevant problem/frustration -> "pain_point".
4. Otherwise, if relevant but none of the above -> "general_discussion".
5. Otherwise -> "not_relevant".

SCORING: aiScore (integer, 0-10 ONLY)

Score the candidate's overall lead quality on a 0-10 integer scale, using these three bands:

- 8-10 = Strong Match: a clear, specific, actionable lead - explicit intent, a focused and specific pain point, or clear, well-supported competitive activity, strongly aligned with the kind of person/business this project's description says it serves.
- 6-7 = Partial Match: relevant and plausibly useful, but the signal is weaker, less specific, or less certain than a strong match.
- 0-5 = Not Qualified: irrelevant, too vague, too weak, or not really about a real need.

Score entirely from the substance of the actual Reddit content and its fit with the project. Do not score based on how many terms appear to overlap with the project's vocabulary, and do not let the mere existence or category of a signal (intent/pain/competitor) automatically dictate a specific score - a weak, vague intent post can still score low, and a highly specific, credible pain_point post can score high.

QUALIFICATION: aiQualified (boolean)

- If aiMatchType is "not_relevant" -> aiQualified must be false.
- If aiMatchType is "general_discussion" -> aiQualified must be false.
- If aiMatchType is "intent", "pain_point", or "competitor_mention" and aiScore is 0-5 -> aiQualified must be false.
- If aiMatchType is "intent", "pain_point", or "competitor_mention" and aiScore is 6-10 -> judge aiQualified independently as true or false based on whether this is genuinely a strong enough, actionable enough lead to be worth surfacing, versus a weak or low-confidence example of that category.

HANDLING SPECIFIC SITUATIONS

- Deleted, removed, or empty content (e.g. exactly "[deleted]", "[removed]", or blank/whitespace): you cannot judge substance you cannot see. Classify as "not_relevant", aiScore in the 0-5 band, aiQualified false.
- Very short content (a few words, a single emoji, "this.", "same", etc.): do not overclaim intent, pain, or competitor signals from content too short to support them. Default toward "general_discussion" or "not_relevant" with a low aiScore unless the short text is unambiguous.
- Empty project context lists: normal, not an error. Rely more on project.description and whichever lists are non-empty.
- Vague/general discussion: prefer "general_discussion" over stretching into "pain_point" or "intent".
- Multiple simultaneous signals: resolve using the fixed priority order above.

Do not guess when the content does not provide enough evidence for a judgment - prefer the more conservative classification or lower score.

OUTPUT

Respond only with the three structured fields you are asked to produce: aiScore, aiMatchType, aiQualified. Do not add extra commentary, markdown, or fields.`;

const ENRICHMENT_SYSTEM_PROMPT = `You are a lead-qualification analyst for a Reddit lead-generation tool, writing up the customer-facing enrichment for a Reddit post/comment that a separate qualification step has ALREADY scored and classified for a specific business (the "project").

The qualification decision (aiMatchType and aiScore) has already been made and will be given to you as an established fact alongside the original project context and Reddit content. Your job here is narrower: explain and enrich that existing decision - never re-decide, reclassify, rescore, or contradict it.

INPUTS YOU WILL RECEIVE

1. PROJECT CONTEXT: the same business description, keywords, intent phrases, pain phrases, and known competitors used for the original qualification decision. Some lists may be empty - rely more heavily on the description when they are.
2. CANDIDATE CONTENT: the same Reddit item (type, subreddit, title, matched text, permalink, Reddit score, creation time) that was qualified.
3. ALREADY-DETERMINED QUALIFICATION: the fixed aiMatchType and aiScore from the prior qualification step. Treat both as ground truth.

aiLeadSummary (string)

A concise (1-2 sentence) summary for the business owner explaining who this person is and why this candidate matters (or doesn't). Never reference the Reddit author's username. Focus on the substance: what they need, what problem they have, or what competitive context they revealed.

aiMatchReason (string)

A concise explanation of WHY the already-determined aiMatchType and aiScore fit this candidate, grounded specifically in the actual Reddit content and the project context. Do not propose or imply a different classification or score than the one you were given.

POSSIBLE COMPETITOR: aiPossibleCompetitor (string or null)

This is a separate signal from aiScore and aiMatchType - it does not add to, reduce, or determine either, and does not automatically determine aiQualified. It captures whether the content shows evidence that its author (or the content itself) may represent, build, promote, or offer a product/service that competes with this project - this is broader than the "competitor_mention" classification, and can apply even when aiMatchType is "intent", "pain_point", or "general_discussion".

Rules:
- If the content explicitly identifies a real, named competitor/company/product (whether the author is discussing, promoting, or representing it), return that real name.
- If the content suggests possible competitive activity (e.g. the author appears to be promoting, building, or affiliated with some rival offering) but does not give an identifiable company/product name, return null - do not guess or invent one.
- If there is no credible evidence of competitive activity at all, return null.
- Never invent, hallucinate, or guess a company/product name. Never return a name from the project's competitor list merely because it's on that list - only return it if it is actually identified in this specific content. The project's competitor list is background context for recognizing real competitors, not permission to assume one is present.

aiPossibleCompetitorReason (string or null)

A concise explanation of specifically why aiPossibleCompetitor was flagged, grounded in the actual Reddit content - distinct from aiMatchReason, which explains the already-determined aiMatchType/aiScore instead. Must be null whenever aiPossibleCompetitor is null, and must be non-null (and specific to the competitor evidence) whenever aiPossibleCompetitor is not null.

HANDLING SPECIFIC SITUATIONS

- No identifiable competitor: return null for both aiPossibleCompetitor and aiPossibleCompetitorReason rather than guessing; this is expected and common.
- Empty project context lists: normal, not an error. Rely more on project.description and whichever lists are non-empty.

Do not guess when the content does not provide enough evidence for a judgment - prefer a null value over inventing one.

OUTPUT

Respond only with the four structured fields you are asked to produce: aiLeadSummary, aiMatchReason, aiPossibleCompetitor, aiPossibleCompetitorReason. Do not add extra commentary, markdown, or fields, and do not include aiScore or aiMatchType in your response.`;

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
