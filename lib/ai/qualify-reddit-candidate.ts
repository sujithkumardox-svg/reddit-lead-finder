import "server-only";

import { getQualificationProvider } from "@/lib/ai/providers/qualification-provider";

/** The five approved aiMatchType values (Phase 9B-1, locked). Owned here as the public Phase 9 taxonomy; the Gemini provider's schema enum is checked against this type. */
export type AiMatchType =
  | "intent"
  | "pain_point"
  | "competitor_mention"
  | "general_discussion"
  | "not_relevant";

/**
 * The minimum `aiScore` (inclusive) for a candidate to be eligible for
 * enrichment (Phase 9 score-first gating) and for `normalizeAiQualified`
 * to ever preserve Gemini's own `aiQualified` judgment. Single source of
 * truth for the existing `<6` / `>=6` boundary - unchanged from the prior
 * single-call implementation's hardcoded `aiScore <= 5` check.
 */
const MIN_QUALIFYING_SCORE = 6;

/**
 * Approved Phase 9B-1 candidate context. Deliberately excludes the Reddit
 * author, Phase 7 `matchedTerms`, and Phase 8 scoring/qualification fields -
 * none of those are ever sent to Gemini. `title` is `null` for comments.
 */
export type QualifyRedditCandidateCandidate = {
  itemType: "post" | "comment";
  subreddit: string;
  title: string | null;
  matchedText: string;
  permalink: string;
  redditScore: number;
  itemCreatedAt: string;
};

/**
 * Approved Phase 9B-1 project context. Deliberately excludes
 * `hiddenKeywords`/`hiddenKeywordVariations` - never sent to Gemini.
 */
export type QualifyRedditCandidateProject = {
  description: string;
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
};

export type QualifyRedditCandidateInput = {
  candidate: QualifyRedditCandidateCandidate;
  project: QualifyRedditCandidateProject;
};

/**
 * The qualification provider's seven structured fields. `aiLeadSummary`
 * and `aiMatchReason` are nullable (Phase 9 score-first gating): both are
 * `null` whenever the core call determined `aiScore < 6`, since enrichment
 * is never generated for that candidate. `aiPossibleCompetitor` and
 * `aiPossibleCompetitorReason` were already nullable before this change.
 */
export type QualifyRedditCandidateOutput = {
  aiQualified: boolean;
  aiScore: number;
  aiMatchType: AiMatchType;
  aiLeadSummary: string | null;
  aiMatchReason: string | null;
  aiPossibleCompetitor: string | null;
  aiPossibleCompetitorReason: string | null;
};

/**
 * `QualifyRedditCandidateOutput` plus provenance metadata attached by this
 * orchestrator - `aiProvider`/`aiModel` are never produced by the
 * provider's `qualifyCore`/`generateEnrichment` methods directly, but read
 * off the provider instance itself (`provider.id`/`provider.model`) so a
 * future fallback provider's provenance is never mislabeled as Gemini's.
 */
export type QualifyRedditCandidateResult = QualifyRedditCandidateOutput & {
  aiProvider: string;
  aiModel: string;
};

/** The three aiMatchType values for which aiQualified is the provider's own judgment call (subject to the aiScore 0-5 override below). */
const SELF_JUDGED_MATCH_TYPES: ReadonlySet<QualifyRedditCandidateOutput["aiMatchType"]> = new Set([
  "intent",
  "pain_point",
  "competitor_mention",
]);

/**
 * Enforces the approved aiQualified consistency rules after the core
 * qualification call returns. Unchanged from the prior single-call
 * implementation - only the shared `MIN_QUALIFYING_SCORE` constant is new,
 * replacing the previously inlined `aiScore <= 5` literal:
 *
 * - aiMatchType "not_relevant" or "general_discussion" -> false
 * - aiMatchType "intent"/"pain_point"/"competitor_mention" with aiScore < MIN_QUALIFYING_SCORE -> false
 * - aiMatchType "intent"/"pain_point"/"competitor_mention" with aiScore >= MIN_QUALIFYING_SCORE -> the provider's own aiQualified, unchanged
 *
 * Only ever narrows aiQualified toward false; never touches aiScore,
 * aiMatchType, aiLeadSummary, aiMatchReason, aiPossibleCompetitor, or
 * aiPossibleCompetitorReason.
 */
export function normalizeAiQualified({
  aiMatchType,
  aiScore,
  aiQualified,
}: Pick<QualifyRedditCandidateOutput, "aiMatchType" | "aiScore" | "aiQualified">): boolean {
  if (!SELF_JUDGED_MATCH_TYPES.has(aiMatchType)) {
    return false;
  }

  if (aiScore < MIN_QUALIFYING_SCORE) {
    return false;
  }

  return aiQualified;
}

/**
 * Independently judges a single Reddit post/comment against a project's
 * context using the configured `QualificationProvider` (Gemini today), per
 * the approved Phase 9 score-first design:
 *
 *   1. `provider.qualifyCore(input)` determines `aiScore`, `aiMatchType`,
 *      and the provider's own `aiQualified` judgment - exactly one call,
 *      always made.
 *   2. `normalizeAiQualified` applies the existing consistency rules,
 *      unchanged.
 *   3. If `aiScore < MIN_QUALIFYING_SCORE` (6): stop immediately. No
 *      enrichment call is made; `aiLeadSummary`, `aiMatchReason`,
 *      `aiPossibleCompetitor`, and `aiPossibleCompetitorReason` are all
 *      `null`. The returned result is still a complete, valid
 *      `QualifyRedditCandidateResult` the existing worker/persistence
 *      contract (`services/gemini-qualification-worker.ts`,
 *      `services/gemini-qualification-queue.ts`) can record exactly as
 *      before - `aiScore` alone (always non-null here) is what
 *      `candidateAlreadyHasGeminiResult` in the worker already relies on
 *      to prevent a duplicate provider call on crash-recovery reclaim, and
 *      `aiQualified: false` means Phase 10 lead persistence is skipped,
 *      exactly like any other non-qualifying result before this change.
 *   4. If `aiScore >= MIN_QUALIFYING_SCORE`: `provider.generateEnrichment`
 *      is called exactly once, passing the already-decided core result so
 *      the enrichment call treats it as fact rather than re-deciding it
 *      (see the Gemini provider's prompt for how that's enforced). Its
 *      four fields are merged into the final result unchanged from the
 *      prior single-call behavior.
 *
 * Pure orchestration: no Supabase, queue, or persistence dependency, and -
 * unlike before this change - no direct dependency on any AI SDK, Gemini
 * client, or Zod schema; all of that lives behind `getQualificationProvider()`
 * in `lib/ai/providers/`. Phase 7/8 matching evidence (matchedTerms,
 * hiddenKeywords, finalScore, qualificationReason) and the Reddit author
 * are still never passed to the provider - only the approved
 * candidate/project context above.
 */
export async function qualifyRedditCandidate(
  input: QualifyRedditCandidateInput,
): Promise<QualifyRedditCandidateResult> {
  const provider = getQualificationProvider();

  const core = await provider.qualifyCore(input);
  const aiQualified = normalizeAiQualified(core);

  if (core.aiScore < MIN_QUALIFYING_SCORE) {
    return {
      aiQualified,
      aiScore: core.aiScore,
      aiMatchType: core.aiMatchType,
      aiLeadSummary: null,
      aiMatchReason: null,
      aiPossibleCompetitor: null,
      aiPossibleCompetitorReason: null,
      aiProvider: provider.id,
      aiModel: provider.model,
    };
  }

  const enrichment = await provider.generateEnrichment(input, core);

  return {
    aiQualified,
    aiScore: core.aiScore,
    aiMatchType: core.aiMatchType,
    aiLeadSummary: enrichment.aiLeadSummary,
    aiMatchReason: enrichment.aiMatchReason,
    aiPossibleCompetitor: enrichment.aiPossibleCompetitor,
    aiPossibleCompetitorReason: enrichment.aiPossibleCompetitorReason,
    aiProvider: provider.id,
    aiModel: provider.model,
  };
}
