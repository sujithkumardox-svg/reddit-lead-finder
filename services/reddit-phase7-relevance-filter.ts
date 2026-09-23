import "server-only";

import {
  RelevanceFilterProviderError,
  getRelevanceFilterProvider,
} from "@/lib/ai/providers/relevance-filter-provider";
import type { RelevanceFilterInput, RelevanceFilterOutcome } from "@/lib/ai/providers/relevance-filter-provider";
import { combineRedditPostText } from "@/lib/reddit/combine-reddit-post-text";
import { findSubredditMetrics } from "@/lib/scans/scan-metrics";
import { enqueueCandidate } from "@/services/gemini-qualification-queue";
import {
  claimPhase7Processing,
  completePhase7Processing,
  recordPhase7ProcessingError,
} from "@/services/reddit-phase7-processing";
import type { EnqueueGeminiCandidateInput } from "@/types/gemini-qualification-queue";
import type { Phase7ClaimResult, Phase7Outcome } from "@/types/reddit-phase7-processing";
import type { RedditPostItem } from "@/types/reddit-scan";
import type { ScanRunMetrics, ScanSubredditMetrics } from "@/types/scan-metrics";

/**
 * NEW Phase 7 orchestrator: the lightweight AI relevance filter that now
 * sits directly between Reddit Discovery and Phase 9, replacing the OLD
 * per-post pipeline (OLD Phase 7 keyword matching -> OLD Phase 8 keyword
 * scoring) at the exact seam `services/reddit-scan-matching-handler.ts`
 * used to run it.
 *
 * Business logic depends ONLY on the `RelevanceFilterProvider` interface
 * (`lib/ai/providers/relevance-filter-provider.ts`) via
 * `getRelevanceFilterProvider()` - never on the Gemini SDK directly - and
 * ONLY on the Phase 7 storage layer's claim/complete/error primitives
 * (`services/reddit-phase7-processing.ts`) - never on Supabase directly.
 *
 * Per post, in order (see each helper's doc comment for the exact
 * guarantees):
 *
 *   1. `claimPhase7Processing` - atomic claim. Skips (no AI call) when
 *      already `"already_processed"` or `"in_progress"`.
 *   2. `classifyWithBoundedRetry` - calls the AI provider, with a small,
 *      bounded number of retries ONLY for errors the provider classifies
 *      as `"transient"`. Never a tight loop, never blind retry of every
 *      exception.
 *   3. On success: `completePhase7Processing` persists the terminal
 *      outcome. `NOT_A_LEAD` stops here - it is never sent to Phase 9,
 *      never creates a dashboard lead. `LEAD` is handed, via the ORIGINAL
 *      Reddit post data, into the EXISTING Phase 9
 *      `enqueueCandidate()` path (`services/gemini-qualification-queue.ts`)
 *      - the same function OLD Phase 8 already used - so Phase 9 itself
 *      (its provider, prompt, scoring, enrichment, worker, retry/recovery)
 *      is never touched.
 *   4. On failure (claim error, exhausted retries, unexpected persistence
 *      error): logged and recorded via `recordPhase7ProcessingError`
 *      where a claim exists; the row is left `status: "processing"`
 *      (retryable/reclaimable later) - never a false terminal `LEAD`/
 *      `NOT_A_LEAD`. Never throws out of `processPhase7ForPost` - one
 *      post's failure never aborts the rest of the scan's posts, the same
 *      defensive convention `safelyEnqueueCandidate` already established
 *      for OLD Phase 8.
 *
 * Deliberately out of scope here (see task spec): comment scanning (only
 * `RedditPostItem`s are ever processed - comments are never handed to
 * Phase 7), any AI provider fallback/failover/registry, and any
 * qualification/scoring/enrichment logic (that remains exclusively
 * Phase 9's).
 */

/**
 * Business context NEW Phase 7 needs to judge relevance - the same
 * project fields (by name) Phase 9's `QualifyRedditCandidateProject`
 * already uses, reusing the project's established onboarding fields
 * rather than introducing new ones. See `getProjectScanData` in
 * `services/projects.ts` for where these are loaded from.
 */
export type Phase7ProjectContext = {
  description: string;
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
};

/** Bounded AI-call attempts within one claimed processing attempt - only for errors the provider classifies as `"transient"`. Deliberately small: a stuck AI provider must never turn into a tight retry loop, and a permanent error never retries at all. */
const MAX_AI_ATTEMPTS = 3;

/** Base delay between bounded in-process retries, scaled by attempt number - small enough to keep a scan responsive, non-zero so this is never a tight/busy loop. */
const RETRY_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Calls the configured `RelevanceFilterProvider` for one Reddit post,
 * retrying up to `maxAttempts` times ONLY when the provider throws a
 * `RelevanceFilterProviderError` with `kind: "transient"` - any other
 * error (a `"permanent"` `RelevanceFilterProviderError`, or any
 * unexpected non-provider error) is rethrown immediately, on the first
 * attempt, without retrying. "Do not blindly retry every exception" is
 * enforced here, not left to the caller.
 */
async function classifyWithBoundedRetry(
  input: RelevanceFilterInput,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<RelevanceFilterOutcome> {
  const provider = getRelevanceFilterProvider();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await provider.classifyRelevance(input);
    } catch (error) {
      lastError = error;
      const isTransient = error instanceof RelevanceFilterProviderError && error.kind === "transient";
      if (!isTransient || attempt >= maxAttempts) {
        throw error;
      }
      await delay(retryDelayMs * attempt);
    }
  }

  // Unreachable (the loop above always either returns or throws), kept
  // only so control flow analysis is satisfied.
  throw lastError;
}

function buildRelevanceFilterInput(
  post: RedditPostItem,
  project: Phase7ProjectContext,
): RelevanceFilterInput {
  return {
    candidate: {
      subreddit: post.subreddit,
      title: post.title,
      text: combineRedditPostText(post),
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
 * Builds the Phase 9 handoff payload from the ORIGINAL Reddit post - never
 * from anything Phase 7 itself computed beyond the combined matched text.
 * The five OLD Phase 7/8 fields (`matchedTerms`/`numericalScore`/
 * `diversityBonus`/`finalScore`/`qualificationReason`) are omitted rather
 * than fabricated - `enqueueCandidate` persists them as `null` (see
 * `types/gemini-qualification-queue.ts` and the
 * `20260923091000_gemini_qualification_queue_nullable_legacy_fields.sql`
 * migration that made this safe).
 */
function buildLeadCandidateInput(
  userId: string,
  projectId: string,
  post: RedditPostItem,
): EnqueueGeminiCandidateInput {
  return {
    projectId,
    userId,
    redditItemId: post.id,
    itemType: "post",
    parentPostId: null,
    subreddit: post.subreddit,
    title: post.title,
    body: post.body,
    matchedText: combineRedditPostText(post),
    author: post.author,
    authorId: post.authorId,
    permalink: post.permalink,
    redditScore: post.score,
    numComments: post.numComments,
    itemCreatedAt: post.createdAt,
  };
}

/**
 * Hands a `LEAD` post into the EXISTING Phase 9 `enqueueCandidate()` path.
 * Mirrors `safelyEnqueueCandidate`'s OLD Phase 8 defensive convention
 * exactly: a genuine DB insertion error is caught and logged (never
 * retried here, never rethrown) so it can never abort the rest of the
 * scan's posts; a duplicate (`enqueueCandidate` resolving `null`, the
 * existing `23505` convention) is not an error at all.
 */
async function safelyEnqueueLead(
  userId: string,
  projectId: string,
  post: RedditPostItem,
  metrics?: ScanRunMetrics,
  bucket?: ScanSubredditMetrics,
): Promise<boolean> {
  const queueStartedMs = Date.now();
  try {
    const row = await enqueueCandidate(buildLeadCandidateInput(userId, projectId, post));
    if (metrics) {
      if (row) {
        metrics.queueInserted++;
        if (bucket) {
          bucket.queueInserted++;
        }
      } else {
        metrics.queueDuplicateSkipped++;
      }
    }
    return row !== null;
  } catch (error) {
    if (metrics) {
      metrics.queueInsertFailed++;
    }
    console.error(
      `[reddit-phase7-relevance-filter] Failed to hand LEAD candidate ${post.id} to Phase 9 for project ${projectId}:`,
      error,
    );
    return false;
  } finally {
    if (metrics) {
      metrics.durationsMs.queue += Date.now() - queueStartedMs;
    }
  }
}

export type Phase7PostOutcome =
  | { outcome: "lead"; enqueued: boolean }
  | { outcome: "not_a_lead" }
  | { outcome: "already_processed"; existingOutcome: Phase7Outcome }
  | { outcome: "in_progress" }
  | { outcome: "error"; message: string };

export type ProcessPhase7ForPostOptions = {
  metrics?: ScanRunMetrics;
  maxAiAttempts?: number;
  retryDelayMs?: number;
  staleTimeoutMs?: number;
};

/**
 * Runs NEW Phase 7 for exactly one Reddit post. Never throws - every
 * expected failure mode (claim error, exhausted AI retries, a completion
 * write failing after a successful AI call) is caught, logged, optionally
 * recorded via `recordPhase7ProcessingError`, and returned as `{ outcome:
 * "error" }` instead, so the caller (`runPhase7RelevanceFilter` below,
 * and ultimately the scan) can keep processing the rest of the posts
 * without interruption.
 */
export async function processPhase7ForPost(
  userId: string,
  projectId: string,
  project: Phase7ProjectContext,
  post: RedditPostItem,
  options?: ProcessPhase7ForPostOptions,
): Promise<Phase7PostOutcome> {
  const {
    metrics,
    maxAiAttempts = MAX_AI_ATTEMPTS,
    retryDelayMs = RETRY_DELAY_MS,
    staleTimeoutMs,
  } = options ?? {};
  const bucket = metrics ? findSubredditMetrics(metrics, post.subreddit) : undefined;

  let claim: Phase7ClaimResult;
  try {
    claim = await claimPhase7Processing(
      { projectId, userId, redditItemId: post.id },
      staleTimeoutMs,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Phase 7 claim error.";
    console.error(
      `[reddit-phase7-relevance-filter] Failed to claim Phase 7 processing for ${post.id} (project ${projectId}):`,
      error,
    );
    if (metrics) {
      metrics.phase7Errors++;
    }
    return { outcome: "error", message };
  }

  if (claim.kind === "already_processed") {
    if (metrics) {
      metrics.phase7DedupSkipped++;
    }
    return { outcome: "already_processed", existingOutcome: claim.outcome };
  }

  if (claim.kind === "in_progress") {
    if (metrics) {
      metrics.phase7ConcurrentSkipped++;
    }
    return { outcome: "in_progress" };
  }

  // claim.kind === "claimed" - this caller, and only this caller, may now
  // call the AI provider for this (project, reddit item) pair.
  const { row } = claim;
  const relevanceInput = buildRelevanceFilterInput(post, project);

  let result: RelevanceFilterOutcome;
  const aiStartedMs = Date.now();
  try {
    result = await classifyWithBoundedRetry(relevanceInput, maxAiAttempts, retryDelayMs);
  } catch (error) {
    if (metrics) {
      metrics.durationsMs.phase7 += Date.now() - aiStartedMs;
      metrics.phase7Errors++;
    }
    const message =
      error instanceof Error ? error.message : "Unknown Phase 7 relevance filter error.";
    console.error(
      `[reddit-phase7-relevance-filter] Relevance classification failed for ${post.id} (project ${projectId}):`,
      error,
    );
    try {
      // Leaves status "processing" (never a false terminal outcome) so
      // this row remains retryable/reclaimable later.
      await recordPhase7ProcessingError(row.id, message);
    } catch (persistError) {
      console.error(
        `[reddit-phase7-relevance-filter] Failed to record the Phase 7 error for row ${row.id}:`,
        persistError,
      );
    }
    return { outcome: "error", message };
  }
  if (metrics) {
    metrics.durationsMs.phase7 += Date.now() - aiStartedMs;
  }

  try {
    await completePhase7Processing(row.id, result);
  } catch (error) {
    if (metrics) {
      metrics.phase7Errors++;
    }
    const message =
      error instanceof Error ? error.message : "Unknown error completing Phase 7 processing.";
    console.error(
      `[reddit-phase7-relevance-filter] Failed to persist the Phase 7 outcome for ${post.id} (project ${projectId}):`,
      error,
    );
    return { outcome: "error", message };
  }

  if (result === "not_a_lead") {
    if (metrics) {
      metrics.phase7NotALead++;
    }
    return { outcome: "not_a_lead" };
  }

  if (metrics) {
    metrics.phase7Leads++;
  }

  const enqueued = await safelyEnqueueLead(userId, projectId, post, metrics, bucket);
  return { outcome: "lead", enqueued };
}

/**
 * Runs NEW Phase 7 over every scanned post (comments are never passed
 * here - see this module's doc comment) for one project, sequentially.
 * Called from `RedditScanMatchingHandler.handleScanResult()` -
 * `services/reddit-scan-matching-handler.ts` - the exact seam that used
 * to run the OLD Phase 7 keyword matcher + OLD Phase 8 keyword scoring.
 */
export async function runPhase7RelevanceFilter(
  userId: string,
  projectId: string,
  project: Phase7ProjectContext,
  posts: RedditPostItem[],
  metrics?: ScanRunMetrics,
): Promise<void> {
  if (metrics) {
    metrics.postsEnteringPhase7 += posts.length;
  }

  for (const post of posts) {
    await processPhase7ForPost(userId, projectId, project, post, { metrics });
  }
}
