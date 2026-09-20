import "server-only";

import { geminiQualificationProvider } from "@/lib/ai/providers/gemini-qualification-provider";
import type {
  QualifyRedditCandidateInput,
  QualifyRedditCandidateOutput,
} from "@/lib/ai/qualify-reddit-candidate";

/**
 * Provider abstraction boundary for Phase 9 Gemini qualification.
 *
 * Introduced so `lib/ai/qualify-reddit-candidate.ts` (the Phase 9
 * orchestrator) can implement score-first gating - core qualification
 * first, enrichment only when `aiScore >= 6` - without depending on any
 * Gemini SDK types, schemas, or prompt text directly. All of that lives
 * behind this interface, inside `gemini-qualification-provider.ts`.
 *
 * Deliberately minimal per the approved plan: ONE interface, ONE current
 * Gemini implementation (`gemini-qualification-provider.ts`), ONE trivial
 * factory (`getQualificationProvider` below). No registry, no config-driven
 * provider selection, no retry/failover, no load balancing - a future
 * fallback provider is expected to implement this same interface and be
 * wired in later by changing `getQualificationProvider`'s single return
 * statement, without touching the orchestrator's score-first gating logic
 * or the worker at all.
 */

/**
 * Result of the core qualification decision: the score, classification,
 * and Gemini's own qualification judgment, before `normalizeAiQualified`
 * is applied and before any enrichment is generated. Intentionally the
 * same three fields the current single-call schema already produces for
 * this part of the decision - no scoring/classification semantics change.
 */
export type CoreQualificationResult = Pick<
  QualifyRedditCandidateOutput,
  "aiScore" | "aiMatchType" | "aiQualified"
>;

/**
 * Result of the enrichment step: the customer-facing summary/reason/
 * competitor fields. Only ever requested when `aiScore >= 6` (decided by
 * the orchestrator, not by the provider itself).
 */
export type EnrichmentResult = Pick<
  QualifyRedditCandidateOutput,
  "aiLeadSummary" | "aiMatchReason" | "aiPossibleCompetitor" | "aiPossibleCompetitorReason"
>;

/**
 * A qualification provider capable of both halves of Phase 9 processing.
 * `id`/`model` are provenance metadata the orchestrator attaches to the
 * final result (`aiProvider`/`aiModel`) - today always Gemini's, but
 * sourced from the provider so a future fallback provider's provenance is
 * never mislabeled as Gemini's.
 */
export interface QualificationProvider {
  readonly id: string;
  readonly model: string;

  /**
   * Determines the core qualification decision (score, match type,
   * qualified judgment) for one candidate. Must not perform enrichment.
   */
  qualifyCore(input: QualifyRedditCandidateInput): Promise<CoreQualificationResult>;

  /**
   * Generates the enrichment fields for a candidate whose core
   * qualification already determined `aiScore >= 6`. The already-decided
   * `core` result (score/match type) must be treated as an established
   * fact by the implementation - this call must never re-decide or
   * contradict the qualification decision, only explain/enrich it.
   */
  generateEnrichment(
    input: QualifyRedditCandidateInput,
    core: CoreQualificationResult,
  ): Promise<EnrichmentResult>;
}

/**
 * The minimal selection mechanism the approved plan calls for: a single
 * hardcoded return of the current Gemini implementation. Deliberately NOT
 * a registry, config-driven switch, or fallback/failover chain - a future
 * fallback provider is expected to be wired in here later (e.g. returning
 * a different `QualificationProvider` implementation based on
 * configuration), without requiring any change to
 * `lib/ai/qualify-reddit-candidate.ts`'s orchestration or score-first
 * gating logic, since both only depend on this function's return type.
 */
export function getQualificationProvider(): QualificationProvider {
  return geminiQualificationProvider;
}
