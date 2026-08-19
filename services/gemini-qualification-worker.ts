import "server-only";

import { qualifyRedditCandidate } from "@/lib/ai/qualify-reddit-candidate";
import type {
  QualifyRedditCandidateInput,
  QualifyRedditCandidateOutput,
  QualifyRedditCandidateResult,
} from "@/lib/ai/qualify-reddit-candidate";
import { getSubredditSafety } from "@/lib/safety/subreddit-safety";
import {
  claimNextPending,
  markFailed,
  markGeminiCallAttempted,
  recordGeminiResult,
  recoverStaleProcessing,
  saveQualificationResult,
} from "@/services/gemini-qualification-queue";
import { getProjectById } from "@/services/projects";
import { persistQualifiedLead } from "@/services/reddit-leads";
import type { GeminiQualificationQueueRow } from "@/types/gemini-qualification-queue";
import type { Project } from "@/types/project";
import type { PersistQualifiedLeadInput, SubredditSafetyResult } from "@/types/reddit-leads";

/**
 * Gemini qualification worker (Phase 9C), extended by Phase 10 with a
 * post-qualification lead persistence step.
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
 *
 * Phase 10 addition: once `saveQualificationResult` has successfully
 * written a `result.aiQualified === true` verdict, this module also looks
 * up the candidate's subreddit safety (rule-based, via
 * `lib/safety/subreddit-safety.ts`) and persists the qualified lead via
 * `services/reddit-leads.ts`. That step is deliberately best-effort and
 * isolated in its own try/catch (see `persistQualifiedLeadSafely` below) -
 * a failure there must never flip an already-`completed` queue row back to
 * `failed`, since the Gemini qualification itself already succeeded and
 * was already durably saved.
 *
 * Crash-recovery fix, in two layers:
 *
 * 1. PRE-call marker: `markGeminiCallAttempted` is called immediately after
 *    claiming a fresh candidate, BEFORE `qualifyRedditCandidate`/Gemini is
 *    ever invoked. If the process crashes/OOMs/is killed anywhere from
 *    that point up to and including immediately after Gemini's HTTP
 *    response returns but before `recordGeminiResult` (below) commits,
 *    this marker has already durably survived in the database, so
 *    `recoverStaleProcessing` can tell "Gemini was never attempted" apart
 *    from "Gemini may already have been called, outcome unknown" for a
 *    stale row - and refuses to auto-reset the latter to `pending` (it
 *    flags it `failed` for manual review instead). This is what actually
 *    closes the crash window: without it, a crash in exactly that window
 *    left no evidence at all, and the row looked identical to "never
 *    attempted".
 * 2. POST-call checkpoint: once Gemini responds, `recordGeminiResult`
 *    durably records the `ai_*` columns before `saveQualificationResult`
 *    (which re-affirms them and marks the row `completed`). If the
 *    process crashes between those two writes, `candidateAlreadyHasGeminiResult`
 *    detects the already-recorded result on reclaim and reuses it instead
 *    of calling Gemini again.
 *
 * Together, these mean the same `project_id`/`reddit_item_id` can never be
 * *automatically* sent to Gemini a second time after a Gemini call may
 * already have been attempted - the queue's `(project_id, reddit_item_id)`
 * uniqueness constraint only prevents a second row from being *inserted*;
 * it says nothing about reprocessing an *existing* row, which is what
 * these two checkpoints are for.
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
 * True when this claimed row already has a Gemini result recorded on it -
 * the crash-recovery signature left behind by `recordGeminiResult` when a
 * previous attempt got a successful Gemini response but the worker
 * crashed before `saveQualificationResult`/`markCompleted` ever ran, so
 * `recoverStaleProcessing` reset the row back to `pending` and it was
 * reclaimed here again.
 *
 * `recordGeminiResult` and `saveQualificationResult` always write every
 * `ai_*` column together in a single update, so checking `aiScore` alone
 * (an always-present integer field in a real result, never omitted by the
 * Phase 9B schema) is a reliable signal that Gemini already answered for
 * this exact row - a fresh, never-processed row always has `aiScore ===
 * null`. Works identically for posts and comments; nothing here depends
 * on `itemType`.
 */
function candidateAlreadyHasGeminiResult(candidate: GeminiQualificationQueueRow): boolean {
  return candidate.aiScore !== null;
}

/**
 * Reconstructs the `QualifyRedditCandidateResult` already recorded for a
 * candidate (see `candidateAlreadyHasGeminiResult`) directly from the
 * claimed row, instead of calling Gemini again. Only ever called when
 * `candidateAlreadyHasGeminiResult(candidate)` is true, so every field
 * read here is guaranteed non-null (they are always written together).
 */
function buildResultFromRecordedCandidate(
  candidate: GeminiQualificationQueueRow,
): QualifyRedditCandidateResult {
  return {
    aiQualified: candidate.aiQualified as boolean,
    aiScore: candidate.aiScore as number,
    aiMatchType: candidate.aiMatchType as QualifyRedditCandidateOutput["aiMatchType"],
    aiLeadSummary: candidate.aiLeadSummary as string,
    aiMatchReason: candidate.aiMatchReason as string,
    aiPossibleCompetitor: candidate.aiPossibleCompetitor,
    aiPossibleCompetitorReason: candidate.aiPossibleCompetitorReason,
    aiProvider: candidate.aiProvider as string,
    aiModel: candidate.aiModel as string,
  };
}

/** Builds the Phase 10 `persistQualifiedLead` input from a claimed queue row plus its subreddit safety result. */
function buildPersistLeadInput(
  candidate: GeminiQualificationQueueRow,
  result: QualifyRedditCandidateResult,
  safety: SubredditSafetyResult,
): PersistQualifiedLeadInput {
  return {
    projectId: candidate.projectId,
    userId: candidate.userId,
    redditItemId: candidate.redditItemId,
    itemType: candidate.itemType,
    parentPostId: candidate.parentPostId,
    subreddit: candidate.subreddit,
    title: candidate.title,
    content: candidate.body,
    author: candidate.author,
    authorId: candidate.authorId,
    permalink: candidate.permalink,
    score: candidate.redditScore,
    numComments: candidate.numComments,
    itemCreatedAt: candidate.itemCreatedAt,
    aiScore: result.aiScore,
    aiMatchType: result.aiMatchType,
    aiLeadSummary: result.aiLeadSummary,
    aiMatchReason: result.aiMatchReason,
    aiPossibleCompetitor: result.aiPossibleCompetitor,
    aiPossibleCompetitorReason: result.aiPossibleCompetitorReason,
    safetyBadge: safety.badge,
    safetyExplanation: safety.explanation,
  };
}

/**
 * Phase 10: looks up the candidate's subreddit safety (cached per-run via
 * `safetyCache`) and persists it as a qualified lead. Only ever called
 * after `saveQualificationResult` has already succeeded for a
 * `result.aiQualified === true` candidate.
 *
 * Deliberately swallows and only logs any error (Reddit rules fetch,
 * classification, or the lead upsert itself) rather than letting it
 * propagate - a failure here must never mark an already-`completed` queue
 * row `failed`, since the Gemini qualification it's based on already
 * succeeded and was already durably saved by `saveQualificationResult`. A
 * candidate that fails this step simply isn't yet reflected in
 * `reddit_leads`; retrying/backfilling that is out of scope here.
 */
async function persistQualifiedLeadSafely(
  candidate: GeminiQualificationQueueRow,
  result: QualifyRedditCandidateResult,
  safetyCache: Map<string, SubredditSafetyResult>,
): Promise<void> {
  try {
    const safety = await getSubredditSafety(candidate.subreddit, safetyCache);
    await persistQualifiedLead(buildPersistLeadInput(candidate, result, safety));
  } catch (error) {
    console.error(
      `[gemini-qualification-worker] Failed to persist qualified lead for candidate ${candidate.id}:`,
      error,
    );
  }
}

/**
 * Claims and fully processes exactly one pending candidate:
 * claim -> load project context -> qualify via Gemini -> persist result ->
 * (Phase 10) persist qualified lead.
 *
 * `claimNextPending()` atomically flips the row from `pending` to
 * `processing` (guarded by its own `status = 'pending'` condition), so two
 * concurrent calls to this function can never claim - and therefore never
 * successfully complete - the same row twice.
 *
 * The claimed row is marked `completed` (with the AI result attached) only
 * once `saveQualificationResult` has actually written that result. If
 * loading the project or calling Gemini fails for any reason, the row is
 * marked `failed` (never `completed`) via the existing `markFailed`
 * primitive and left in the database for the existing retry/inspection
 * conventions (`attempt_count`, `error_message`) - no immediate retry is
 * attempted here.
 *
 * Crash-recovery fix: if this claimed row already has a Gemini result
 * recorded on it (`candidateAlreadyHasGeminiResult` - see its doc comment),
 * Gemini is never called again for it - the already-recorded result is
 * reused to finish the row instead. Otherwise, `markGeminiCallAttempted`
 * is called FIRST (before even loading the project), then a fresh Gemini
 * call is made and immediately checkpointed via `recordGeminiResult` (see
 * its doc comment) before `saveQualificationResult` runs. Together with
 * `recoverStaleProcessing`'s handling of `gemini_call_attempted_at` (see
 * its doc comment in `services/gemini-qualification-queue.ts`), this means
 * the same `project_id`/`reddit_item_id` can never be automatically sent
 * to Gemini a second time after a Gemini call may already have been
 * attempted, even across a worker crash and recovery cycle.
 *
 * Once qualification succeeds, a `result.aiQualified === true` verdict
 * additionally triggers `persistQualifiedLeadSafely` (Phase 10) - see its
 * doc comment for why that step can never turn a `"processed"` outcome
 * into a `"failed"` one.
 *
 * Returns `{ outcome: "no_pending_candidates" }` when the queue is empty,
 * so a caller can stop looping without treating that as an error.
 *
 * `safetyCache` is an optional in-memory `Map` used to fetch each distinct
 * subreddit's Reddit rules at most once across many calls - pass the same
 * `Map` into every call within one worker run to get that behavior (see
 * `runGeminiQualificationWorker`). Omitting it (e.g. a one-off call) simply
 * means no cross-call caching, not incorrect behavior.
 */
export async function processNextGeminiQualificationCandidate(
  safetyCache: Map<string, SubredditSafetyResult> = new Map(),
): Promise<ProcessCandidateOutcome> {
  const claimed = await claimNextPending();
  if (!claimed) {
    return { outcome: "no_pending_candidates" };
  }

  let result: QualifyRedditCandidateResult;
  try {
    if (candidateAlreadyHasGeminiResult(claimed)) {
      // Crash-recovery path: Gemini already answered for this exact row in
      // a previous attempt (recorded by recordGeminiResult) before the
      // worker crashed. Reuse that already-paid-for result - never call
      // Gemini again for it.
      result = buildResultFromRecordedCandidate(claimed);
      await saveQualificationResult(claimed.id, result);
    } else {
      // PRE-call checkpoint: durably record that a Gemini call is about to
      // be attempted for this exact row BEFORE doing anything that could
      // call Gemini - including before loading the project. If the
      // process crashes anywhere after this point (up to and including
      // right after Gemini responds but before recordGeminiResult below
      // commits), recoverStaleProcessing will see this marker set with no
      // ai_* result recorded and refuse to auto-reset the row to pending.
      await markGeminiCallAttempted(claimed.id);

      const project = await getProjectById(claimed.userId, claimed.projectId);
      if (!project) {
        throw new Error(`Project ${claimed.projectId} not found.`);
      }

      result = await qualifyRedditCandidate(buildQualificationInput(claimed, project));
      // POST-call checkpoint: durably record the result BEFORE anything
      // else, so a crash before saveQualificationResult/markCompleted can
      // never cause this candidate to be sent to Gemini a second time.
      await recordGeminiResult(claimed.id, result);
      await saveQualificationResult(claimed.id, result);
    }
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

  if (result.aiQualified) {
    await persistQualifiedLeadSafely(claimed, result, safetyCache);
  }

  return { outcome: "processed", queueId: claimed.id, aiQualified: result.aiQualified };
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
 * Creates a single subreddit-safety cache (Phase 10) for the whole run and
 * passes it into every `processNextGeminiQualificationCandidate` call, so
 * a subreddit seen more than once in the same run only triggers one Reddit
 * rules fetch.
 *
 * This function is not itself a scheduler - something else (a cron job,
 * route handler, etc., all out of scope for Phase 9C) is expected to
 * invoke it on a schedule.
 */
export async function runGeminiQualificationWorker(
  maxCandidates?: number,
): Promise<GeminiQualificationWorkerSummary> {
  await recoverStaleProcessing();

  const safetyCache = new Map<string, SubredditSafetyResult>();
  const summary: GeminiQualificationWorkerSummary = { processed: 0, qualified: 0, failed: 0 };

  while (maxCandidates === undefined || summary.processed + summary.failed < maxCandidates) {
    const outcome = await processNextGeminiQualificationCandidate(safetyCache);

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
