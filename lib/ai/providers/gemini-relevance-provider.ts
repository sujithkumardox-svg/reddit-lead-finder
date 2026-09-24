import "server-only";

import { google } from "@ai-sdk/google";
import { generateText } from "ai";

import {
  RelevanceFilterProviderError,
  type RelevanceFilterInput,
  type RelevanceFilterOutcome,
  type RelevanceFilterProvider,
} from "@/lib/ai/providers/relevance-filter-provider";

/**
 * Gemini implementation of the NEW Phase 7 `RelevanceFilterProvider`
 * contract.
 *
 * All Gemini/AI-SDK-specific code (the `google(...)` model descriptor and
 * the `generateText` call) lives here and ONLY here -
 * `services/reddit-phase7-relevance-filter.ts` (the Phase 7
 * orchestrator) never imports `ai` or `@ai-sdk/google`, and depends only
 * on this file's exported `geminiRelevanceFilterProvider` via the
 * `RelevanceFilterProvider` interface.
 *
 * Deliberately plain-text, not `generateObject`: Phase 7's entire output
 * space is two literal words, so this asks Gemini for exactly that and
 * strictly parses the raw text itself (`normalizeRelevanceOutput` below) -
 * any response that isn't exactly `LEAD` or `NOT_A_LEAD` (after trimming
 * incidental whitespace/casing) is treated as an invalid AI response, not
 * silently coerced into either outcome.
 *
 * `LIGHTWEIGHT_AI_MODEL`/`LIGHTWEIGHT_AI_PROVIDER` are separate env vars
 * from Phase 9's `AI_MODEL` - changing Phase 7's lightweight model/provider
 * must never affect Phase 9's Gemini configuration, and vice versa.
 */

const LIGHTWEIGHT_AI_MODEL = process.env.LIGHTWEIGHT_AI_MODEL || "gemini-3.1-flash-lite";

/**
 * Provenance-only label for the current provider. Not used for any
 * routing/selection decision - `getRelevanceFilterProvider()` always
 * returns this same Gemini implementation regardless of this value. An
 * extension point only, per the approved plan (no provider registry, no
 * fallback provider implementation in this task).
 */
const LIGHTWEIGHT_AI_PROVIDER = process.env.LIGHTWEIGHT_AI_PROVIDER || "google";

const SYSTEM_PROMPT = `You are a lightweight relevance filter for a Reddit lead-generation tool. You will be shown ONE Reddit post, plus context about a specific business (the "project"). Your ONLY job is to decide whether this post could reasonably be a meaningful potential lead for this project - one worth sending on to a slower, more expensive qualification step. You do NOT decide whether the author will actually buy anything, and you do NOT score, rank, enrich, or explain your answer.

INPUTS YOU WILL RECEIVE

1. PROJECT CONTEXT: a description of the business, plus lists of keywords, intent phrases, pain phrases, and known competitors the business cares about. These lists exist only to help you understand what the business does - they are background knowledge, not a checklist to match against. Some lists may be empty; rely more on the description when they are.
2. REDDIT POST: its subreddit, title, and combined title+body text.

YOUR DECISION

Decide between exactly two outcomes:

- LEAD - the post is meaningfully or strongly relevant to the project's problem space, target audience, or market. This includes:
  - A clear, explicit buying/looking-for-a-solution signal (e.g. "I'm looking for a tool that alerts me to prospective customers on Reddit").
  - Strong relevance to the project's problem space even with only a weaker or moderate buying signal - e.g. discussing the same kind of problem, audience, or topic the project's description says it serves (e.g. "How can I market my SaaS?", "How do I get my first users?", "Finding the right beta users is difficult", "Is Reddit a good marketing channel?"). These can lack explicit purchase intent but are still strongly relevant to the project's problem space.
- NOT_A_LEAD - the post is not meaningfully relevant. This includes:
  - A superficial keyword mention only - a project-related word appears, but the actual discussion is about something unrelated.
  - Content that is clearly unrelated to the project's problem space, target audience, or market.
  - Content whose title/body does not provide enough contextual evidence to judge relevance either way.

IMPORTANT: Do NOT default to LEAD when uncertain. Apply exactly this rule:
  - Meaningfully/strongly relevant -> LEAD
  - Strong relevance to the problem space with only moderate/weak genuine buying intent -> still LEAD (this is a high-recall filter; deeper qualification happens later, in a separate step you are not part of)
  - Superficial keyword mention only -> NOT_A_LEAD
  - Clearly unrelated -> NOT_A_LEAD
  - Insufficient contextual evidence to judge relevance -> NOT_A_LEAD

You are a coarse, high-recall filter, not the final judge of lead quality: when genuine relevance is present, prefer LEAD even if the buying signal is weak; when relevance itself is in doubt, prefer NOT_A_LEAD.

OUTPUT

Respond with EXACTLY one of these two words, and nothing else - no punctuation, no explanation, no markdown, no surrounding text:

LEAD
NOT_A_LEAD`;

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "(none provided)";
}

function buildUserPrompt({ candidate, project }: RelevanceFilterInput): string {
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
    "REDDIT POST",
    "",
    `Subreddit: r/${candidate.subreddit}`,
    `Title: ${candidate.title}`,
    "Content:",
    candidate.text,
  ].join("\n");
}

/**
 * Strictly parses Gemini's raw text response. Only harmless surrounding
 * whitespace and casing are normalized - anything else that isn't exactly
 * `LEAD` or `NOT_A_LEAD` after that normalization returns `null`, which
 * `classifyRelevance` below treats as an invalid AI response, never as a
 * silent fallback classification.
 */
function normalizeRelevanceOutput(raw: string): RelevanceFilterOutcome | null {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "LEAD") {
    return "lead";
  }
  if (normalized === "NOT_A_LEAD") {
    return "not_a_lead";
  }
  return null;
}

/** Substrings/patterns of a caught error's message that indicate a transient, retry-worthy failure (rate limiting, timeouts, temporary server/network issues) rather than a permanent one (bad config, auth, malformed request). */
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/i,
  /\b5\d\d\b/i,
  /timeout/i,
  /timed out/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /network/i,
  /econnreset/i,
  /etimedout/i,
  /fetch failed/i,
];

/**
 * Classifies a caught `generateText` failure as transient or permanent
 * based on its message. Best-effort heuristic (the AI SDK does not expose
 * a stable, structured error-kind field here) - defaults to `"permanent"`
 * when nothing matches, so an unrecognized failure is never blindly
 * retried forever.
 */
function classifyGenerateTextError(error: unknown): RelevanceFilterProviderError {
  const message = error instanceof Error ? error.message : String(error);
  const isTransient = TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  return new RelevanceFilterProviderError(message, isTransient ? "transient" : "permanent", {
    cause: error,
  });
}

async function classifyRelevance(input: RelevanceFilterInput): Promise<RelevanceFilterOutcome> {
  let rawText: string;
  try {
    const response = await generateText({
      model: google(LIGHTWEIGHT_AI_MODEL),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
    });
    rawText = response.text;
  } catch (error) {
    throw classifyGenerateTextError(error);
  }

  const outcome = normalizeRelevanceOutput(rawText);
  if (outcome === null) {
    // Malformed/unparseable output is treated as transient here: a single
    // bad response is often a one-off glitch worth a bounded retry (see
    // services/reddit-phase7-relevance-filter.ts's retry cap), and if the
    // model keeps returning invalid output across every bounded attempt,
    // that retry cap - not this classification - is what ultimately stops
    // it from looping forever. Never silently coerced into LEAD or
    // NOT_A_LEAD.
    throw new RelevanceFilterProviderError(
      `Lightweight relevance model returned an invalid response (expected exactly "LEAD" or "NOT_A_LEAD"): ${JSON.stringify(rawText)}`,
      "transient",
    );
  }

  return outcome;
}

/** The only `RelevanceFilterProvider` implementation today. See this module's doc comment. */
export const geminiRelevanceFilterProvider: RelevanceFilterProvider = {
  id: LIGHTWEIGHT_AI_PROVIDER,
  model: LIGHTWEIGHT_AI_MODEL,
  classifyRelevance,
};
