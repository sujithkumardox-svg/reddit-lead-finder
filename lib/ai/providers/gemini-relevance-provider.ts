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

const SYSTEM_PROMPT = `You are a lead relevance classifier.

Read the customer's business context and the full Reddit post.

Decide whether the person has a real need, problem, goal, or intent that the business could reasonably help with.

The need can be direct or indirect. Do not require the person to mention the business, product, or exact solution.

Understand the meaning and context of the post, not just matching words.

If the person's need or situation is relevant to what the business offers, return LEAD.

Otherwise, return NOT_A_LEAD.

Output exactly one word:
LEAD
or
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
