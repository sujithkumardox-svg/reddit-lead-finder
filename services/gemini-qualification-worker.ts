import "server-only";

import { qualifyRedditCandidate } from "@/lib/ai/qualify-reddit-candidate";
import type { QualifyRedditCandidateInput } from "@/lib/ai/qualify-reddit-candidate";
import {
  claimNextPending,
  markFailed,
  recoverStaleProcessing,
  saveQualificationResult,
} from "@/services/gemini-qualification-queue";
import { getProjectById } from "@/services/projects";
import type { GeminiQualificationQueueRow } from "@/types/gemini-qualification-queue";
import type { Project } from "@/types/project";

/**
 * Gemini qualification worker (Phase 9C).
 *
 * Claims Phase 8-qualified candidates from `gemini_qualification_queue` one
 * at a time and qualifies each with the Phase 9B `qualifyRedditCandidate()`
 * service, then persists the result. This module does NOT duplicate any
 * Gemini prompt/schema/scoring logic - all of that lives in
 * `lib/ai/qualify-reddit-candidate.ts` and is reused as-is. It also does
 * NOT implement a fallback AI provider, UI, notifications, analytics, or
 * any new queue/retry architecture - claiming, completion, and failure all
 * go through the existing `services/gemini-qualification-queue.ts`
 * primitives.
 */

export type ProcessCandidateOutcome =
  | { outcome: "no_pending_candidates" }
  | { outcome: "processed"; queueId: string; aiQualified: boolean }
  | { outcome: "failed"; queueId: string; error: string };

/**
 * Builds the approved Phase 9B-1 input from one claimed queue row and its
 * project. Deliberately excludes `matchedTerms`, Phase 8's
 * `numericalScore`/`diversityBonus`/`finalScore`/`qualificationReason`, and
 * the Reddit `author` - only the candidate/project fields the Phase 9B-2
 * prompt is designed around are ever passed to Gemini. `getProjectById`
 * already never selects `hidden_keywords`/`subreddits`, so hidden keyword
 * variations can never reach this function in the first place.
 */
function buildQualificationInput(
  candidate: GeminiQualificationQueueRow,
  project: Project,
): QualifyRedditCandidateInput {
  return {
    candidate: {
      itemType: candidate.itemType,
      subreddit: candidate.subreddit,
      title: candidate.title,
      matchedText: candidate.matchedText,
      permalink: candidate.permalink,
      redditScore: candidate.redditScore,
      itemCreatedAt: candidate.itemCreatedAt,
    },
    project: {
      description: project.description,
      keywords: project.keywords,
      intentPhrases: project.intentPhrases,
      painPhrases: project.painPhrases,
      competitors: project.competitors,
    },
  };
}

/**
 * Claims and fully processes exactly one pending candidate:
 * claim -> load project context -> qualify via Gemini -> persist result.
 *
 * `claimNextPending()` atomically flips the row from `pending` to
 * `processing` (guarded by its own `status = 'pending'` condition), so two
 * concurrent calls to this function can never claim - and therefore never
 * successfully complete - the same row twice.
 *
 * The claimed row is marked `completed` (with the AI result attached) only
 * once `saveQualificationResult` has actually written that result - see
 * its doc comment for why that's a single atomic step. If loading the
 * project or calling Gemini fails for any reason, the row is marked
 * `failed` (never `completed`) via the existing `markFailed` primitive and
 * left in the database for the existing retry/inspection conventions
 * (`attempt_count`, `error_message`) - no immediate retry is attempted
 * here.
 *
 * Returns `{ outcome: "no_pending_candidates" }` when the queue is empty,
 * so a caller can stop looping without treating that as an error.
 */
export async function processNextGeminiQualificationCandidate(): Promise<ProcessCandidateOutcome> {
  const claimed = await claimNextPending();
  if (!claimed) {
    return { outcome: "no_pending_candidates" };
  }

  try {
    const project = await getProjectById(claimed.userId, claimed.projectId);
    if (!project) {
      throw new Error(`Project ${claimed.projectId} not found.`);
    }

    const result = await qualifyRedditCandidate(buildQualificationInput(claimed, project));
    await saveQualificationResult(claimed.id, result);

    return { outcome: "processed", queueId: claimed.id, aiQualified: result.aiQualified };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error during Gemini qualification.";
    console.error(
      `[gemini-qualification-worker] Failed to qualify candidate ${claimed.id}:`,
      error,
    );
    await markFailed(claimed.id, message);
    return { outcome: "failed", queueId: claimed.id, error: message };
  }
}

export type GeminiQualificationWorkerSummary = {
  processed: number;
  qualified: number;
  failed: number;
};

/**
 * Drains the queue by repeatedly calling
 * `processNextGeminiQualificationCandidate` until nothing is left pending
 * (or `maxCandidates` is reached, if provided). Recovers any stale
 * `processing` rows abandoned by a crashed worker once at the start of the
 * run, using the existing visibility-timeout convention already defined by
 * `recoverStaleProcessing` (whose own doc comment anticipates being called
 * "at the start of a worker run").
 *
 * This function is not itself a scheduler - something else (a cron job,
 * route handler, etc., all out of scope for Phase 9C) is expected to
 * invoke it on a schedule.
 */
export async function runGeminiQualificationWorker(
  maxCandidates?: number,
): Promise<GeminiQualificationWorkerSummary> {
  await recoverStaleProcessing();

  const summary: GeminiQualificationWorkerSummary = { processed: 0, qualified: 0, failed: 0 };

  while (maxCandidates === undefined || summary.processed + summary.failed < maxCandidates) {
    const outcome = await processNextGeminiQualificationCandidate();

    if (outcome.outcome === "no_pending_candidates") {
      break;
    }

    if (outcome.outcome === "processed") {
      summary.processed++;
      if (outcome.aiQualified) {
        summary.qualified++;
      }
    } else {
      summary.failed++;
    }
  }

  return summary;
}
