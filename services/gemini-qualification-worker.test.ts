import { beforeEach, describe, expect, it, vi } from "vitest";

// `services/gemini-qualification-queue.ts` and `services/projects.ts` both
// talk to Supabase (via `server-only`), which doesn't exist in a plain unit
// test. Mocking them here keeps these tests focused on the worker's own
// wiring (claim -> build input -> qualify -> save/fail) without exercising
// real Supabase access - the queue primitives themselves are already
// covered by `gemini-qualification-queue.test.ts`.
vi.mock("@/services/gemini-qualification-queue", () => ({
  claimNextPending: vi.fn(),
  markFailed: vi.fn(),
  markGeminiCallAttempted: vi.fn(),
  recordGeminiResult: vi.fn(),
  recoverStaleProcessing: vi.fn(),
  saveQualificationResult: vi.fn(),
}));

vi.mock("@/services/projects", () => ({
  getProjectById: vi.fn(),
}));

// `lib/ai/qualify-reddit-candidate.ts` calls Gemini via the AI SDK, which
// doesn't run in a plain unit test either. Mocking it here keeps these
// tests focused on the worker's wiring, not Gemini's prompt/schema/scoring
// logic - that logic is already covered by `qualify-reddit-candidate.test.ts`.
vi.mock("@/lib/ai/qualify-reddit-candidate", () => ({
  qualifyRedditCandidate: vi.fn(),
}));

// Safety lookup is deferred from the MVP persist path. The mock stays so
// tests can prove `getSubredditSafety` is never called. `reddit-leads` is
// mocked because it talks to Supabase.
vi.mock("@/lib/safety/subreddit-safety", () => ({
  getSubredditSafety: vi.fn(),
}));

vi.mock("@/services/reddit-leads", () => ({
  persistQualifiedLead: vi.fn(),
}));

import { qualifyRedditCandidate } from "@/lib/ai/qualify-reddit-candidate";
import type { QualifyRedditCandidateResult } from "@/lib/ai/qualify-reddit-candidate";
import { getSubredditSafety } from "@/lib/safety/subreddit-safety";
import { createScanMetrics } from "@/lib/scans/scan-metrics";
import {
  claimNextPending,
  markFailed,
  markGeminiCallAttempted,
  recordGeminiResult,
  recoverStaleProcessing,
  saveQualificationResult,
} from "@/services/gemini-qualification-queue";
import {
  processNextGeminiQualificationCandidate,
  runGeminiQualificationWorker,
} from "@/services/gemini-qualification-worker";
import { getProjectById } from "@/services/projects";
import { persistQualifiedLead } from "@/services/reddit-leads";
import type { GeminiQualificationQueueRow } from "@/types/gemini-qualification-queue";
import type { Project } from "@/types/project";

const mockedClaimNextPending = vi.mocked(claimNextPending);
const mockedMarkFailed = vi.mocked(markFailed);
const mockedMarkGeminiCallAttempted = vi.mocked(markGeminiCallAttempted);
const mockedRecordGeminiResult = vi.mocked(recordGeminiResult);
const mockedRecoverStaleProcessing = vi.mocked(recoverStaleProcessing);
const mockedSaveQualificationResult = vi.mocked(saveQualificationResult);
const mockedGetProjectById = vi.mocked(getProjectById);
const mockedQualifyRedditCandidate = vi.mocked(qualifyRedditCandidate);
const mockedGetSubredditSafety = vi.mocked(getSubredditSafety);
const mockedPersistQualifiedLead = vi.mocked(persistQualifiedLead);

function makeQueueRow(
  overrides: Partial<GeminiQualificationQueueRow> = {},
): GeminiQualificationQueueRow {
  return {
    id: "queue-1",
    projectId: "project-1",
    userId: "user-1",
    redditItemId: "t3_abc123",
    itemType: "post",
    parentPostId: null,
    subreddit: "SaaS",
    title: "Looking for a lead-gen tool",
    body: "Looking for a lead-gen tool\n\nAny recommendations?",
    matchedText: "Looking for a lead-gen tool\n\nAny recommendations?",
    author: "some-redditor",
    authorId: "t2_someredditor",
    permalink: "https://reddit.com/r/SaaS/comments/abc123",
    redditScore: 12,
    numComments: 4,
    itemCreatedAt: "2026-08-01T00:00:00.000Z",
    matchedTerms: {
      keywords: [],
      intentPhrases: [],
      painPhrases: [],
      competitors: [],
      hiddenKeywordVariations: [],
    },
    numericalScore: 10,
    diversityBonus: 0,
    finalScore: 10,
    qualificationReason: "intent_or_pain",
    status: "processing",
    processingStartedAt: "2026-08-01T00:01:00.000Z",
    attemptCount: 1,
    errorMessage: null,
    geminiCallAttemptedAt: null,
    aiQualified: null,
    aiScore: null,
    aiMatchType: null,
    aiLeadSummary: null,
    aiMatchReason: null,
    aiPossibleCompetitor: null,
    aiPossibleCompetitorReason: null,
    aiProvider: null,
    aiModel: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:01:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Reddit Lead Finder",
    websiteUrl: "https://example.com",
    description: "A Reddit lead-generation tool.",
    keywords: ["lead generation"],
    intentPhrases: ["looking for an alternative"],
    painPhrases: ["struggling to find leads"],
    competitors: ["Syften"],
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeQualifyResult(
  overrides: Partial<QualifyRedditCandidateResult> = {},
): QualifyRedditCandidateResult {
  return {
    aiQualified: true,
    aiScore: 9,
    aiMatchType: "intent",
    aiLeadSummary: "Actively looking for a lead-gen tool.",
    aiMatchReason: "Explicitly asks for recommendations.",
    aiPossibleCompetitor: null,
    aiPossibleCompetitorReason: null,
    aiProvider: "google",
    aiModel: "gemini-3.5-flash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPersistQualifiedLead.mockResolvedValue(undefined);
  mockedRecordGeminiResult.mockResolvedValue(undefined);
  mockedMarkGeminiCallAttempted.mockResolvedValue(undefined);
});

describe("processNextGeminiQualificationCandidate - successful qualification", () => {
  it("1. claims a pending candidate, qualifies it via Gemini, saves the result, and reports it as processed", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult({ aiQualified: true });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedClaimNextPending).toHaveBeenCalledTimes(1);
    expect(mockedMarkGeminiCallAttempted).toHaveBeenCalledWith(claimedRow.id);
    expect(mockedGetProjectById).toHaveBeenCalledWith(claimedRow.userId, claimedRow.projectId);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedRecordGeminiResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedPersistQualifiedLead).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: true });

    // A: marked attempted -> Gemini called exactly once -> result recorded
    // -> qualified lead persisted -> queue row completed, strictly in that order.
    const attemptedOrder = mockedMarkGeminiCallAttempted.mock.invocationCallOrder[0];
    const qualifyOrder = mockedQualifyRedditCandidate.mock.invocationCallOrder[0];
    const recordOrder = mockedRecordGeminiResult.mock.invocationCallOrder[0];
    const persistOrder = mockedPersistQualifiedLead.mock.invocationCallOrder[0];
    const saveOrder = mockedSaveQualificationResult.mock.invocationCallOrder[0];
    expect(attemptedOrder).toBeLessThan(qualifyOrder);
    expect(qualifyOrder).toBeLessThan(recordOrder);
    expect(recordOrder).toBeLessThan(persistOrder);
    expect(persistOrder).toBeLessThan(saveOrder);
  });

  it("passes only the approved Phase 9B candidate/project fields to qualifyRedditCandidate", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    const project = makeProject();
    mockedGetProjectById.mockResolvedValueOnce(project);
    mockedQualifyRedditCandidate.mockResolvedValueOnce(makeQualifyResult());
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    await processNextGeminiQualificationCandidate();

    // No author, matchedTerms, numericalScore/diversityBonus/finalScore,
    // qualificationReason, or hidden project fields - only the approved
    // Phase 9B-1 candidate/project shape.
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledWith({
      candidate: {
        itemType: claimedRow.itemType,
        subreddit: claimedRow.subreddit,
        title: claimedRow.title,
        matchedText: claimedRow.matchedText,
        permalink: claimedRow.permalink,
        redditScore: claimedRow.redditScore,
        itemCreatedAt: claimedRow.itemCreatedAt,
      },
      project: {
        description: project.description,
        keywords: project.keywords,
        intentPhrases: project.intentPhrases,
        painPhrases: project.painPhrases,
        competitors: project.competitors,
      },
    });
  });
});

describe("processNextGeminiQualificationCandidate - non-qualified result", () => {
  it("2. still saves a non-qualified Gemini result and marks the candidate completed", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult({
      aiQualified: false,
      aiMatchType: "not_relevant",
      aiScore: 2,
    });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: false });
  });
});

describe("processNextGeminiQualificationCandidate - Gemini/API failure", () => {
  it("3. propagates a Gemini/API failure, marks the candidate failed, and records the error message", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const apiError = new Error("Gemini API request failed");
    mockedQualifyRedditCandidate.mockRejectedValueOnce(apiError);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(claimedRow.id, apiError.message);
    expect(outcome).toEqual({ outcome: "failed", queueId: claimedRow.id, error: apiError.message });
  });

  it("marks the candidate failed (never completed) when its project can no longer be found", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(null);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).not.toHaveBeenCalled();
    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      claimedRow.id,
      expect.stringContaining(claimedRow.projectId),
    );
    expect(outcome.outcome).toBe("failed");
  });
});

describe("processNextGeminiQualificationCandidate - duplicate protection", () => {
  it("4. a completed candidate cannot be claimed again through the existing pending-claim mechanism", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    mockedQualifyRedditCandidate.mockResolvedValueOnce(makeQualifyResult());
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const firstOutcome = await processNextGeminiQualificationCandidate();
    expect(firstOutcome.outcome).toBe("processed");

    // claimNextPending's own `status = 'pending'` filter (verified in
    // gemini-qualification-queue.test.ts) means a now-completed row is
    // never returned again - simulated here by resolving null, exactly as
    // the real implementation would once this row is no longer pending.
    mockedClaimNextPending.mockResolvedValueOnce(null);

    const secondOutcome = await processNextGeminiQualificationCandidate();

    expect(secondOutcome).toEqual({ outcome: "no_pending_candidates" });
    // The same candidate was only ever qualified/saved once across both calls.
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).toHaveBeenCalledTimes(1);
  });
});

describe("processNextGeminiQualificationCandidate - empty queue", () => {
  it("5. exits cleanly with no side effects when there are no pending candidates", async () => {
    mockedClaimNextPending.mockResolvedValueOnce(null);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(outcome).toEqual({ outcome: "no_pending_candidates" });
    expect(mockedGetProjectById).not.toHaveBeenCalled();
    expect(mockedQualifyRedditCandidate).not.toHaveBeenCalled();
    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
  });
});

describe("runGeminiQualificationWorker - batch behavior", () => {
  it("6a. processes candidates until the queue is empty and returns correct summary counts", async () => {
    const rows = [
      makeQueueRow({ id: "queue-1" }),
      makeQueueRow({ id: "queue-2" }),
      makeQueueRow({ id: "queue-3" }),
    ];
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending
      .mockResolvedValueOnce(rows[0])
      .mockResolvedValueOnce(rows[1])
      .mockResolvedValueOnce(rows[2])
      .mockResolvedValueOnce(null);
    mockedGetProjectById.mockResolvedValue(makeProject());
    mockedQualifyRedditCandidate
      .mockResolvedValueOnce(makeQualifyResult({ aiQualified: true }))
      .mockResolvedValueOnce(
        makeQualifyResult({ aiQualified: false, aiMatchType: "general_discussion", aiScore: 5 }),
      )
      .mockRejectedValueOnce(new Error("Gemini API request failed"));
    mockedSaveQualificationResult.mockResolvedValue(undefined);

    const summary = await runGeminiQualificationWorker();

    expect(mockedRecoverStaleProcessing).toHaveBeenCalledTimes(1);
    expect(mockedClaimNextPending).toHaveBeenCalledTimes(4);
    expect(summary).toEqual({
      processed: 2,
      qualified: 1,
      failed: 1,
      geminiCallsPerformed: 3,
      geminiDuplicateSkips: 0,
      geminiErrors: 1,
      strong8to10: 1,
      partial6to7: 0,
      notQualified0to5: 1,
      leadsPersisted: 1,
      persistFailed: 0,
    });
  });

  it("6b. stops once maxCandidates is reached even if more candidates remain pending", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending
      .mockResolvedValueOnce(makeQueueRow({ id: "queue-1" }))
      .mockResolvedValueOnce(makeQueueRow({ id: "queue-2" }));
    mockedGetProjectById.mockResolvedValue(makeProject());
    mockedQualifyRedditCandidate.mockResolvedValue(makeQualifyResult({ aiQualified: true }));
    mockedSaveQualificationResult.mockResolvedValue(undefined);

    const summary = await runGeminiQualificationWorker(2);

    expect(mockedClaimNextPending).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      processed: 2,
      qualified: 2,
      failed: 0,
      geminiCallsPerformed: 2,
      geminiDuplicateSkips: 0,
      geminiErrors: 0,
      strong8to10: 2,
      partial6to7: 0,
      notQualified0to5: 0,
      leadsPersisted: 2,
      persistFailed: 0,
    });
  });

  it("6c. exits immediately with a zero summary when the queue starts empty", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending.mockResolvedValueOnce(null);

    const summary = await runGeminiQualificationWorker();

    expect(summary).toEqual({
      processed: 0,
      qualified: 0,
      failed: 0,
      geminiCallsPerformed: 0,
      geminiDuplicateSkips: 0,
      geminiErrors: 0,
      strong8to10: 0,
      partial6to7: 0,
      notQualified0to5: 0,
      leadsPersisted: 0,
      persistFailed: 0,
    });
  });
});

describe("processNextGeminiQualificationCandidate - Phase 10 qualified-lead persistence", () => {
  it("7. persists the lead when aiQualified is true without looking up subreddit safety", async () => {
    const claimedRow = makeQueueRow({ subreddit: "SaaS" });
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult({ aiQualified: true });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedGetSubredditSafety).not.toHaveBeenCalled();
    expect(mockedPersistQualifiedLead.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSaveQualificationResult.mock.invocationCallOrder[0],
    );
    expect(mockedPersistQualifiedLead).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: claimedRow.projectId,
        userId: claimedRow.userId,
        redditItemId: claimedRow.redditItemId,
        itemType: claimedRow.itemType,
        subreddit: "SaaS",
        content: claimedRow.body,
        author: claimedRow.author,
        authorId: claimedRow.authorId,
        permalink: claimedRow.permalink,
        score: claimedRow.redditScore,
        numComments: claimedRow.numComments,
        aiScore: result.aiScore,
        aiMatchType: result.aiMatchType,
        aiLeadSummary: result.aiLeadSummary,
        aiMatchReason: result.aiMatchReason,
        aiPossibleCompetitor: result.aiPossibleCompetitor,
        aiPossibleCompetitorReason: result.aiPossibleCompetitorReason,
      }),
    );
    const persistPayload = mockedPersistQualifiedLead.mock.calls[0][0];
    expect(persistPayload).not.toHaveProperty("safetyBadge");
    expect(persistPayload).not.toHaveProperty("safetyExplanation");
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: true });
  });

  it("8. does not look up safety or persist a lead when aiQualified is false", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult({ aiQualified: false, aiMatchType: "not_relevant", aiScore: 1 });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedGetSubredditSafety).not.toHaveBeenCalled();
    expect(mockedPersistQualifiedLead).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: false });
  });

  it("9. still persists a qualified lead when getSubredditSafety would have failed", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult({ aiQualified: true });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedGetSubredditSafety.mockRejectedValueOnce(new Error("Reddit API request failed"));
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedGetSubredditSafety).not.toHaveBeenCalled();
    expect(mockedRecordGeminiResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedPersistQualifiedLead).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: true });
  });

  it("10. does not mark the queue row completed when persisting the lead throws; retry remains an upsert", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    mockedQualifyRedditCandidate.mockResolvedValueOnce(makeQualifyResult({ aiQualified: true }));
    mockedPersistQualifiedLead.mockRejectedValueOnce(new Error("Failed to persist qualified lead."));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const firstOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(claimedRow.id, "Failed to persist qualified lead.");
    expect(firstOutcome).toEqual({
      outcome: "failed",
      queueId: claimedRow.id,
      error: "Failed to persist qualified lead.",
    });

    // Retry path: the same candidate is claimed again with the already-
    // recorded Gemini result. persistQualifiedLead is an upsert, so this
    // second attempt is safe even if the first persist partially wrote.
    const reclaimed = makeQueueRow({
      ...claimedRow,
      aiQualified: true,
      aiScore: 9,
      aiMatchType: "intent",
      aiLeadSummary: "Actively looking for a lead-gen tool.",
      aiMatchReason: "Explicitly asks for recommendations.",
      aiProvider: "google",
      aiModel: "gemini-3.5-flash",
    });
    mockedClaimNextPending.mockResolvedValueOnce(reclaimed);
    mockedPersistQualifiedLead.mockResolvedValueOnce(undefined);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const retryOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedPersistQualifiedLead).toHaveBeenCalledTimes(2);
    expect(mockedSaveQualificationResult).toHaveBeenCalledTimes(1);
    expect(retryOutcome).toEqual({
      outcome: "processed",
      queueId: claimedRow.id,
      aiQualified: true,
    });

    consoleErrorSpy.mockRestore();
  });
});

describe("runGeminiQualificationWorker - deferred subreddit safety", () => {
  it("11. never looks up subreddit safety while draining the queue", async () => {
    const rows = [
      makeQueueRow({ id: "queue-1", subreddit: "SaaS" }),
      makeQueueRow({ id: "queue-2", subreddit: "SaaS" }),
    ];
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending
      .mockResolvedValueOnce(rows[0])
      .mockResolvedValueOnce(rows[1])
      .mockResolvedValueOnce(null);
    mockedGetProjectById.mockResolvedValue(makeProject());
    mockedQualifyRedditCandidate.mockResolvedValue(makeQualifyResult({ aiQualified: true }));
    mockedSaveQualificationResult.mockResolvedValue(undefined);

    await runGeminiQualificationWorker();

    expect(mockedGetSubredditSafety).not.toHaveBeenCalled();
    expect(mockedPersistQualifiedLead).toHaveBeenCalledTimes(2);
  });
});

describe("processNextGeminiQualificationCandidate - crash/recovery duplicate Gemini-call protection", () => {
  it("12. a normal successful qualification calls Gemini exactly once and checkpoints the result before completing", async () => {
    const claimedRow = makeQueueRow();
    mockedClaimNextPending.mockResolvedValueOnce(claimedRow);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const result = makeQualifyResult();
    mockedQualifyRedditCandidate.mockResolvedValueOnce(result);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedMarkGeminiCallAttempted).toHaveBeenCalledTimes(1);
    expect(mockedMarkGeminiCallAttempted).toHaveBeenCalledWith(claimedRow.id);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedRecordGeminiResult).toHaveBeenCalledTimes(1);
    expect(mockedRecordGeminiResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedSaveQualificationResult).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: true });
  });

  it("13. a claimed row that already has a recorded Gemini result (aiScore non-null) never calls Gemini again - post", async () => {
    // Simulates the exact crash-recovery reclaim: a previous attempt got a
    // successful Gemini response and recordGeminiResult wrote it, but the
    // worker crashed before saveQualificationResult/markCompleted ran, so
    // recoverStaleProcessing reset status back to pending and
    // claimNextPending reclaimed it here with the ai_* fields still intact.
    const recoveredRow = makeQueueRow({
      itemType: "post",
      status: "processing",
      aiQualified: true,
      aiScore: 9,
      aiMatchType: "intent",
      aiLeadSummary: "Actively looking for a lead-gen tool.",
      aiMatchReason: "Explicitly asks for recommendations.",
      aiPossibleCompetitor: null,
      aiPossibleCompetitorReason: null,
      aiProvider: "google",
      aiModel: "gemini-3.5-flash",
    });
    mockedClaimNextPending.mockResolvedValueOnce(recoveredRow);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).not.toHaveBeenCalled();
    expect(mockedGetProjectById).not.toHaveBeenCalled();
    expect(mockedMarkGeminiCallAttempted).not.toHaveBeenCalled();
    expect(mockedRecordGeminiResult).not.toHaveBeenCalled();
    expect(mockedPersistQualifiedLead).toHaveBeenCalledTimes(1);
    expect(mockedPersistQualifiedLead.mock.invocationCallOrder[0]).toBeLessThan(
      mockedSaveQualificationResult.mock.invocationCallOrder[0],
    );
    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(
      recoveredRow.id,
      expect.objectContaining({
        aiQualified: true,
        aiScore: 9,
        aiMatchType: "intent",
        aiLeadSummary: "Actively looking for a lead-gen tool.",
        aiMatchReason: "Explicitly asks for recommendations.",
      }),
    );
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: recoveredRow.id, aiQualified: true });
  });

  it("14. a claimed row that already has a recorded Gemini result never calls Gemini again - comment", async () => {
    const recoveredRow = makeQueueRow({
      redditItemId: "t1_comment1",
      itemType: "comment",
      parentPostId: "t3_abc123",
      title: null,
      numComments: null,
      status: "processing",
      aiQualified: false,
      aiScore: 4,
      aiMatchType: "not_relevant",
      aiLeadSummary: "Not a genuine lead.",
      aiMatchReason: "Off-topic chatter.",
      aiPossibleCompetitor: null,
      aiPossibleCompetitorReason: null,
      aiProvider: "google",
      aiModel: "gemini-3.5-flash",
    });
    mockedClaimNextPending.mockResolvedValueOnce(recoveredRow);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const outcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).not.toHaveBeenCalled();
    expect(mockedMarkGeminiCallAttempted).not.toHaveBeenCalled();
    expect(mockedRecordGeminiResult).not.toHaveBeenCalled();
    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(
      recoveredRow.id,
      expect.objectContaining({ aiQualified: false, aiScore: 4, aiMatchType: "not_relevant" }),
    );
    // Not qualified, so Phase 10 persistence must not run either - but the
    // key assertion for this requirement is simply that Gemini was never
    // called a second time for this comment.
    expect(mockedPersistQualifiedLead).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: recoveredRow.id, aiQualified: false });
  });

  it("15. end-to-end crash/recovery simulation: the same candidate is claimed twice (crash in between) but Gemini is only ever called once - post", async () => {
    const original = makeQueueRow({ id: "queue-crash-post", itemType: "post" });
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const geminiResult = makeQualifyResult({ aiQualified: true, aiScore: 8, aiMatchType: "pain_point" });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(geminiResult);

    // Attempt 1: Gemini succeeds and recordGeminiResult durably checkpoints
    // it, but the process "crashes" before saveQualificationResult ever
    // runs - simulated here by making saveQualificationResult reject only
    // on this first attempt.
    mockedClaimNextPending.mockResolvedValueOnce(original);
    mockedSaveQualificationResult.mockRejectedValueOnce(new Error("simulated process crash"));

    const firstOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedRecordGeminiResult).toHaveBeenCalledWith(original.id, geminiResult);
    // The simulated crash surfaces as a thrown error from
    // saveQualificationResult, which the existing catch block turns into a
    // markFailed call - a real full-process crash would skip this catch
    // entirely, but either way the row is left recoverable with its ai_*
    // fields already durably recorded by recordGeminiResult above.
    expect(firstOutcome.outcome).toBe("failed");

    // Attempt 2: recoverStaleProcessing (or, per the failed-path above, a
    // manual/automatic reset) has put the row back into play, and
    // claimNextPending reclaims it - but now with the ai_* fields recorded
    // by attempt 1 still present, exactly like a real recordGeminiResult
    // checkpoint surviving a crash.
    const reclaimed = makeQueueRow({
      ...original,
      status: "processing",
      aiQualified: geminiResult.aiQualified,
      aiScore: geminiResult.aiScore,
      aiMatchType: geminiResult.aiMatchType,
      aiLeadSummary: geminiResult.aiLeadSummary,
      aiMatchReason: geminiResult.aiMatchReason,
      aiPossibleCompetitor: geminiResult.aiPossibleCompetitor,
      aiPossibleCompetitorReason: geminiResult.aiPossibleCompetitorReason,
      aiProvider: geminiResult.aiProvider,
      aiModel: geminiResult.aiModel,
    });
    mockedClaimNextPending.mockResolvedValueOnce(reclaimed);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const secondOutcome = await processNextGeminiQualificationCandidate();

    // The whole point: across both attempts for the same candidate, Gemini
    // was called exactly once.
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toEqual({ outcome: "processed", queueId: original.id, aiQualified: true });
  });

  it("16. end-to-end crash/recovery simulation: the same candidate is claimed twice (crash in between) but Gemini is only ever called once - comment", async () => {
    const original = makeQueueRow({
      id: "queue-crash-comment",
      redditItemId: "t1_comment1",
      itemType: "comment",
      parentPostId: "t3_abc123",
      title: null,
      numComments: null,
    });
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const geminiResult = makeQualifyResult({
      aiQualified: true,
      aiScore: 7,
      aiMatchType: "competitor_mention",
      aiPossibleCompetitor: "Syften",
      aiPossibleCompetitorReason: "The author says they currently pay for Syften.",
    });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(geminiResult);

    mockedClaimNextPending.mockResolvedValueOnce(original);
    mockedSaveQualificationResult.mockRejectedValueOnce(new Error("simulated process crash"));

    const firstOutcome = await processNextGeminiQualificationCandidate();
    expect(firstOutcome.outcome).toBe("failed");
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedRecordGeminiResult).toHaveBeenCalledWith(original.id, geminiResult);

    const reclaimed = makeQueueRow({
      ...original,
      status: "processing",
      aiQualified: geminiResult.aiQualified,
      aiScore: geminiResult.aiScore,
      aiMatchType: geminiResult.aiMatchType,
      aiLeadSummary: geminiResult.aiLeadSummary,
      aiMatchReason: geminiResult.aiMatchReason,
      aiPossibleCompetitor: geminiResult.aiPossibleCompetitor,
      aiPossibleCompetitorReason: geminiResult.aiPossibleCompetitorReason,
      aiProvider: geminiResult.aiProvider,
      aiModel: geminiResult.aiModel,
    });
    mockedClaimNextPending.mockResolvedValueOnce(reclaimed);
    mockedSaveQualificationResult.mockResolvedValueOnce(undefined);

    const secondOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toEqual({
      outcome: "processed",
      queueId: original.id,
      aiQualified: true,
    });
    // The recovered candidate's already-recorded possible-competitor
    // fields survive into the reused result and still reach Phase 10
    // persistence (unchanged Phase 10 logic, just invoked with the
    // recovered result instead of a fresh one).
    expect(mockedPersistQualifiedLead).toHaveBeenCalledWith(
      expect.objectContaining({
        redditItemId: "t1_comment1",
        itemType: "comment",
        aiPossibleCompetitor: "Syften",
        aiPossibleCompetitorReason: "The author says they currently pay for Syften.",
      }),
    );
  });

  it("17. D: crash BEFORE recordGeminiResult ever commits - marker is set, no result recorded - attempt 2 must NOT call Gemini again - post", async () => {
    // This is the exact gap the pre-call marker closes: unlike tests
    // 15/16 above (where recordGeminiResult already succeeded before the
    // crash), here the crash happens between Gemini responding and
    // recordGeminiResult committing, so NO ai_* result is ever recorded.
    // Without the pre-call marker, this row would look identical to
    // "never attempted" and recoverStaleProcessing would put it back to
    // pending. With it, recoverStaleProcessing (tested independently in
    // gemini-qualification-queue.test.ts) instead flags the row `failed`
    // and never surfaces it as pending again - represented here by
    // claimNextPending returning null on the second call, since there is
    // nothing left to claim for this candidate.
    const original = makeQueueRow({
      id: "queue-crash-before-record-post",
      itemType: "post",
      geminiCallAttemptedAt: null,
      aiScore: null,
    });
    mockedClaimNextPending.mockResolvedValueOnce(original);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const geminiResult = makeQualifyResult({ aiQualified: true, aiScore: 9 });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(geminiResult);
    // The crash: recordGeminiResult itself never commits.
    mockedRecordGeminiResult.mockRejectedValueOnce(new Error("simulated crash before checkpoint commits"));

    const firstOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedMarkGeminiCallAttempted).toHaveBeenCalledWith(original.id);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(firstOutcome.outcome).toBe("failed");

    // Attempt 2: nothing is available to claim for this candidate - the
    // real recoverStaleProcessing would have flagged it failed (marker
    // set, no ai_score) rather than resetting it to pending.
    mockedClaimNextPending.mockResolvedValueOnce(null);

    const secondOutcome = await processNextGeminiQualificationCandidate();

    // The whole point of D: across both attempts, Gemini was called
    // exactly once for this candidate.
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toEqual({ outcome: "no_pending_candidates" });
  });

  it("18. E: crash BEFORE recordGeminiResult ever commits - same protection for a comment", async () => {
    const original = makeQueueRow({
      id: "queue-crash-before-record-comment",
      redditItemId: "t1_comment2",
      itemType: "comment",
      parentPostId: "t3_abc123",
      title: null,
      numComments: null,
      geminiCallAttemptedAt: null,
      aiScore: null,
    });
    mockedClaimNextPending.mockResolvedValueOnce(original);
    mockedGetProjectById.mockResolvedValueOnce(makeProject());
    const geminiResult = makeQualifyResult({ aiQualified: true, aiScore: 8, aiMatchType: "pain_point" });
    mockedQualifyRedditCandidate.mockResolvedValueOnce(geminiResult);
    mockedRecordGeminiResult.mockRejectedValueOnce(new Error("simulated crash before checkpoint commits"));

    const firstOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedMarkGeminiCallAttempted).toHaveBeenCalledWith(original.id);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).not.toHaveBeenCalled();
    expect(firstOutcome.outcome).toBe("failed");

    mockedClaimNextPending.mockResolvedValueOnce(null);

    const secondOutcome = await processNextGeminiQualificationCandidate();

    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(secondOutcome).toEqual({ outcome: "no_pending_candidates" });
  });
});

describe("project-scoped worker claiming", () => {
  it("forwards projectId to recoverStaleProcessing and claimNextPending", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending.mockResolvedValueOnce(null);

    await runGeminiQualificationWorker({ projectId: "project-a" });

    expect(mockedRecoverStaleProcessing).toHaveBeenCalledWith(undefined, "project-a");
    expect(mockedClaimNextPending).toHaveBeenCalledWith("project-a");
  });

  it("project A cannot claim project B rows", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending.mockResolvedValueOnce(null);

    await runGeminiQualificationWorker({ projectId: "project-a" });

    expect(mockedClaimNextPending).toHaveBeenCalledWith("project-a");
    expect(mockedClaimNextPending).not.toHaveBeenCalledWith("project-b");
    expect(mockedClaimNextPending).not.toHaveBeenCalledWith();
  });

  it("omitting projectId preserves the existing global claim behavior", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending.mockResolvedValueOnce(null);

    await runGeminiQualificationWorker();

    expect(mockedRecoverStaleProcessing).toHaveBeenCalledWith(undefined, undefined);
    expect(mockedClaimNextPending).toHaveBeenCalledWith(undefined);
  });
});

describe("runGeminiQualificationWorker - forensic metrics summary", () => {
  it("records score buckets, persist failure, and duplicate Gemini skips on the shared accumulator", async () => {
    const metrics = createScanMetrics("project-1", "sync-1");
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending
      .mockResolvedValueOnce(
        makeQueueRow({
          id: "queue-dup",
          aiQualified: true,
          aiScore: 7,
          aiMatchType: "intent",
          aiLeadSummary: "Summary",
          aiMatchReason: "Reason",
          aiProvider: "google",
          aiModel: "gemini-3.5-flash",
        }),
      )
      .mockResolvedValueOnce(makeQueueRow({ id: "queue-persist-fail" }))
      .mockResolvedValueOnce(null);
    mockedGetProjectById.mockResolvedValue(makeProject());
    mockedQualifyRedditCandidate.mockResolvedValue(makeQualifyResult({ aiQualified: true, aiScore: 9 }));
    mockedPersistQualifiedLead
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Failed to persist qualified lead."));
    mockedSaveQualificationResult.mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summary = await runGeminiQualificationWorker({ projectId: "project-1", metrics });

    expect(summary.processed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.geminiDuplicateSkips).toBe(1);
    expect(summary.geminiCallsPerformed).toBe(1);
    expect(summary.partial6to7).toBe(1);
    expect(summary.strong8to10).toBe(1);
    expect(summary.leadsPersisted).toBe(1);
    expect(summary.persistFailed).toBe(1);
    expect(summary.geminiErrors).toBe(0);
    expect(metrics.geminiDuplicateSkips).toBe(1);
    expect(metrics.persistFailed).toBe(1);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });
});
