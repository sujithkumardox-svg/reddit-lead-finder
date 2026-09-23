import "server-only";

import { geminiRelevanceFilterProvider } from "@/lib/ai/providers/gemini-relevance-provider";

/**
 * Provider abstraction boundary for NEW Phase 7 lightweight AI relevance
 * filtering.
 *
 * Mirrors the exact pattern already established for Phase 9 by
 * `lib/ai/providers/qualification-provider.ts`: ONE interface, ONE current
 * Gemini implementation (`gemini-relevance-provider.ts`), ONE trivial
 * factory (`getRelevanceFilterProvider` below). No registry, no
 * config-driven provider selection, no retry/failover/fallback chain, no
 * thinking-level configuration - a future fallback provider is expected to
 * implement this same interface and be wired in later by changing
 * `getRelevanceFilterProvider`'s single return statement, without touching
 * any Phase 7 business/orchestration logic
 * (`services/reddit-phase7-relevance-filter.ts`) or the scan integration
 * seam (`services/reddit-scan-matching-handler.ts`) at all.
 *
 * Deliberately separate from Phase 9's `QualificationProvider`:
 *   - Phase 7 makes exactly ONE binary decision (`"lead"` / `"not_a_lead"`)
 *     and never scores, ranks, enriches, or explains anything.
 *   - Phase 9's `QualificationProvider` is untouched by this file - Phase 7
 *     and Phase 9 each own their own provider interface, Gemini
 *     implementation, and factory, so a change to one can never accidentally
 *     affect the other.
 */

/** The only two outcomes NEW Phase 7 can ever produce for a Reddit post. Matches `Phase7Outcome` in `types/reddit-phase7-processing.ts` - kept as a separate type here so this provider abstraction never needs to import the Phase 7 storage layer's types. */
export type RelevanceFilterOutcome = "lead" | "not_a_lead";

/**
 * The Reddit post content NEW Phase 7 judges. `text` is the post's
 * title+body already combined via `combineRedditPostText()`
 * (`lib/reddit/combine-reddit-post-text.ts`) - this provider never
 * combines title/body itself.
 */
export type RelevanceFilterCandidate = {
  subreddit: string;
  title: string;
  text: string;
};

/**
 * The business context NEW Phase 7 needs to judge relevance. Field names
 * intentionally match the project's existing, established onboarding
 * fields (same names Phase 9's `QualifyRedditCandidateProject` already
 * uses) - nothing is renamed or reinterpreted.
 */
export type RelevanceFilterProjectContext = {
  description: string;
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
};

export type RelevanceFilterInput = {
  candidate: RelevanceFilterCandidate;
  project: RelevanceFilterProjectContext;
};

/** Whether a `RelevanceFilterProviderError` is worth a bounded retry (`"transient"`) or should abort immediately (`"permanent"`). See `services/reddit-phase7-relevance-filter.ts` for how this is used. */
export type RelevanceFilterErrorKind = "transient" | "permanent";

/**
 * Thrown by a `RelevanceFilterProvider` implementation for any failure -
 * a real API/network failure, or a strict-parsing failure when the model's
 * raw output was anything other than exactly `"LEAD"` or `"NOT_A_LEAD"`
 * (see `gemini-relevance-provider.ts`'s `classifyRelevance`). Callers must
 * never invent a fallback classification for either kind of failure - this
 * error type exists precisely so the orchestration layer can decide
 * "retry" vs. "give up for now, stay retryable" without ever silently
 * treating a failure as `"lead"` or `"not_a_lead"`.
 */
export class RelevanceFilterProviderError extends Error {
  readonly kind: RelevanceFilterErrorKind;

  constructor(message: string, kind: RelevanceFilterErrorKind, options?: { cause?: unknown }) {
    super(message);
    this.name = "RelevanceFilterProviderError";
    this.kind = kind;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * A provider capable of NEW Phase 7's single decision. `id`/`model` are
 * provenance metadata (unused by Phase 7 storage today - `reddit_phase7_processing`
 * intentionally stores no provenance, only the binary outcome - but kept
 * here for parity with Phase 9's `QualificationProvider` and in case a
 * future need arises).
 */
export interface RelevanceFilterProvider {
  readonly id: string;
  readonly model: string;

  /**
   * Judges exactly one Reddit post against one project's business context.
   * Must resolve to `"lead"` or `"not_a_lead"` - nothing else. Must reject
   * with a `RelevanceFilterProviderError` for any API failure or any
   * output that cannot be strictly parsed as one of those two values;
   * must never resolve with a fabricated/guessed classification.
   */
  classifyRelevance(input: RelevanceFilterInput): Promise<RelevanceFilterOutcome>;
}

/**
 * The minimal selection mechanism mirroring Phase 9's
 * `getQualificationProvider()`: a single hardcoded return of the current
 * Gemini implementation. Not a registry, not config-driven, no
 * fallback/failover chain - see this module's doc comment.
 */
export function getRelevanceFilterProvider(): RelevanceFilterProvider {
  return geminiRelevanceFilterProvider;
}
