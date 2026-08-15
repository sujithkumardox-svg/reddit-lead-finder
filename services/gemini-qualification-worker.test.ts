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

import { qualifyRedditCandidate } from "@/lib/ai/qualify-reddit-candidate";
import type { QualifyRedditCandidateResult } from "@/lib/ai/qualify-reddit-candidate";
import {
  claimNextPending,
  markFailed,
  recoverStaleProcessing,
  saveQualificationResult,
} from "@/services/gemini-qualification-queue";
import {
  processNextGeminiQualificationCandidate,
  runGeminiQualificationWorker,
} from "@/services/gemini-qualification-worker";
import { getProjectById } from "@/services/projects";
import type { GeminiQualificationQueueRow } from "@/types/gemini-qualification-queue";
import type { Project } from "@/types/project";

const mockedClaimNextPending = vi.mocked(claimNextPending);
const mockedMarkFailed = vi.mocked(markFailed);
const mockedRecoverStaleProcessing = vi.mocked(recoverStaleProcessing);
const mockedSaveQualificationResult = vi.mocked(saveQualificationResult);
const mockedGetProjectById = vi.mocked(getProjectById);
const mockedQualifyRedditCandidate = vi.mocked(qualifyRedditCandidate);

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
    permalink: "https://reddit.com/r/SaaS/comments/abc123",
    redditScore: 12,
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
    aiQualified: null,
    aiScore: null,
    aiMatchType: null,
    aiLeadSummary: null,
    aiMatchReason: null,
    aiPossibleCompetitor: null,
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
    aiProvider: "google",
    aiModel: "gemini-3.5-flash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(mockedGetProjectById).toHaveBeenCalledWith(claimedRow.userId, claimedRow.projectId);
    expect(mockedQualifyRedditCandidate).toHaveBeenCalledTimes(1);
    expect(mockedSaveQualificationResult).toHaveBeenCalledWith(claimedRow.id, result);
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(outcome).toEqual({ outcome: "processed", queueId: claimedRow.id, aiQualified: true });
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
    expect(summary).toEqual({ processed: 2, qualified: 1, failed: 1 });
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
    expect(summary).toEqual({ processed: 2, qualified: 2, failed: 0 });
  });

  it("6c. exits immediately with a zero summary when the queue starts empty", async () => {
    mockedRecoverStaleProcessing.mockResolvedValueOnce(0);
    mockedClaimNextPending.mockResolvedValueOnce(null);

    const summary = await runGeminiQualificationWorker();

    expect(summary).toEqual({ processed: 0, qualified: 0, failed: 0 });
  });
});
