import { beforeEach, describe, expect, it, vi } from "vitest";

// This module talks to Supabase indirectly via the Phase 7 storage layer
// and Phase 9 queue layer (both `server-only`), which don't exist in a
// plain unit test. Mocking those layers - plus the AI provider factory -
// lets these tests focus entirely on NEW Phase 7's business/orchestration
// logic: claim -> AI call (with bounded retry) -> persist -> Phase 9
// handoff, without exercising real Supabase access or making a live
// Gemini call.
vi.mock("@/services/reddit-phase7-processing", () => ({
  claimPhase7Processing: vi.fn(),
  completePhase7Processing: vi.fn(),
  recordPhase7ProcessingError: vi.fn(),
}));

vi.mock("@/services/gemini-qualification-queue", () => ({
  enqueueCandidate: vi.fn(),
}));

vi.mock("@/lib/ai/providers/relevance-filter-provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/providers/relevance-filter-provider")>();
  return {
    ...actual,
    getRelevanceFilterProvider: vi.fn(),
  };
});

import { enqueueCandidate } from "@/services/gemini-qualification-queue";
import {
  claimPhase7Processing,
  completePhase7Processing,
  recordPhase7ProcessingError,
} from "@/services/reddit-phase7-processing";
import {
  getRelevanceFilterProvider,
  RelevanceFilterProviderError,
} from "@/lib/ai/providers/relevance-filter-provider";
import type {
  RelevanceFilterInput,
  RelevanceFilterOutcome,
} from "@/lib/ai/providers/relevance-filter-provider";
import {
  processPhase7ForPost,
  runPhase7RelevanceFilter,
} from "@/services/reddit-phase7-relevance-filter";
import type { Phase7ProjectContext } from "@/services/reddit-phase7-relevance-filter";
import { createScanMetrics } from "@/lib/scans/scan-metrics";
import type { Phase7ClaimResult } from "@/types/reddit-phase7-processing";
import type { RedditPostItem } from "@/types/reddit-scan";

const mockedClaim = vi.mocked(claimPhase7Processing);
const mockedComplete = vi.mocked(completePhase7Processing);
const mockedRecordError = vi.mocked(recordPhase7ProcessingError);
const mockedEnqueueCandidate = vi.mocked(enqueueCandidate);
const mockedGetProvider = vi.mocked(getRelevanceFilterProvider);

function makeProvider(
  classifyRelevance: (input: RelevanceFilterInput) => Promise<RelevanceFilterOutcome>,
) {
  return { id: "google", model: "gemini-2.5-flash-lite", classifyRelevance };
}

function makeClaimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase7-row-1",
    projectId: "project-1",
    userId: "user-1",
    redditItemId: "t3_post1",
    status: "processing" as const,
    outcome: null,
    attemptCount: 1,
    processingStartedAt: "2026-09-23T00:00:00.000Z",
    lastError: null,
    lastErrorAt: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function makePost(overrides: Partial<RedditPostItem> = {}): RedditPostItem {
  return {
    id: "t3_post1",
    type: "post",
    subreddit: "SaaS",
    title: "Looking for a lead-gen tool",
    body: "Any recommendations for finding leads on Reddit?",
    author: "some_user",
    authorId: "t2_someuser",
    url: "https://reddit.com/r/SaaS/post1",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(overrides: Partial<Phase7ProjectContext> = {}): Phase7ProjectContext {
  return {
    description: "A Reddit lead-generation tool for SaaS founders.",
    keywords: ["lead generation"],
    intentPhrases: ["looking for an alternative"],
    painPhrases: ["struggling to find leads"],
    competitors: ["Syften"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedComplete.mockResolvedValue(undefined);
  mockedRecordError.mockResolvedValue(undefined);
  mockedEnqueueCandidate.mockResolvedValue(null);
});

describe("processPhase7ForPost - classification -> handoff", () => {
  it("1. strong buying signal -> LEAD -> hands off to the existing Phase 9 enqueueCandidate() path", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    const post = makePost({
      title: "Looking for a tool that alerts me to prospective SaaS customers on Reddit",
      body: "Does anything like this exist?",
    });

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(outcome).toEqual({ outcome: "lead", enqueued: true });
    expect(mockedComplete).toHaveBeenCalledWith("phase7-row-1", "lead");
    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(1);
  });

  it("2. strong project relevance with a weaker buying signal -> still LEAD -> handed off", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-2" } as never);

    const post = makePost({ title: "How can I market my SaaS?", body: "Struggling to get traction." });

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(outcome).toEqual({ outcome: "lead", enqueued: true });
    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(1);
  });

  it("3. superficial keyword mention -> NOT_A_LEAD -> never handed off to Phase 9", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockResolvedValue("not_a_lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const post = makePost({
      title: "My favorite SaaS movie of all time",
      body: "Totally unrelated discussion that just happens to contain the word SaaS.",
    });

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(outcome).toEqual({ outcome: "not_a_lead" });
    expect(mockedComplete).toHaveBeenCalledWith("phase7-row-1", "not_a_lead");
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });

  it("4. clearly unrelated post -> NOT_A_LEAD -> never handed off", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockResolvedValue("not_a_lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const post = makePost({
      title: "Best pizza toppings?",
      body: "What do you all put on your pizza?",
    });

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(outcome).toEqual({ outcome: "not_a_lead" });
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });

  it("5. insufficient contextual evidence -> NOT_A_LEAD -> never handed off", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockResolvedValue("not_a_lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const post = makePost({ title: "hm", body: "" });

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(outcome).toEqual({ outcome: "not_a_lead" });
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });
});

describe("processPhase7ForPost - dedup", () => {
  it("A. Project A + Post X, first processing - eligible, claim() is called and the AI provider runs", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    await processPhase7ForPost("user-1", "project-a", makeProject(), makePost());

    expect(mockedClaim).toHaveBeenCalledWith(
      { projectId: "project-a", userId: "user-1", redditItemId: "t3_post1" },
      undefined,
    );
    expect(classifyRelevance).toHaveBeenCalledTimes(1);
  });

  it("B. Project A + Post X, already completed LEAD - skipped, the AI provider is never called", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>();
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "already_processed", outcome: "lead" });

    const metrics = createScanMetrics("project-a", "sync-1");
    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      metrics,
    });

    expect(outcome).toEqual({ outcome: "already_processed", existingOutcome: "lead" });
    expect(classifyRelevance).not.toHaveBeenCalled();
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
    expect(metrics.phase7DedupSkipped).toBe(1);
  });

  it("C. Project A + Post X, already completed NOT_A_LEAD - skipped, the AI provider is never called", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>();
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "already_processed", outcome: "not_a_lead" });

    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost());

    expect(outcome).toEqual({ outcome: "already_processed", existingOutcome: "not_a_lead" });
    expect(classifyRelevance).not.toHaveBeenCalled();
  });

  it("D. Project B + Post X is independently eligible - claim() is called scoped to project B", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({
      kind: "claimed",
      row: makeClaimedRow({ projectId: "project-b" }),
    } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-b" } as never);

    await processPhase7ForPost("user-2", "project-b", makeProject(), makePost());

    expect(mockedClaim).toHaveBeenCalledWith(
      { projectId: "project-b", userId: "user-2", redditItemId: "t3_post1" },
      undefined,
    );
    expect(classifyRelevance).toHaveBeenCalledTimes(1);
  });
});

describe("processPhase7ForPost - concurrency", () => {
  it("only the claimant calls the AI provider; the losing worker never does, and only one authoritative processing row is ever completed", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    // "Worker 1" wins the claim.
    mockedClaim.mockResolvedValueOnce({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    // "Worker 2" (a concurrent attempt for the exact same pair) loses -
    // the claim primitive itself is what guarantees this; this test
    // verifies the orchestrator honors that result correctly.
    mockedClaim.mockResolvedValueOnce({ kind: "in_progress" });

    const firstWorkerOutcome = await processPhase7ForPost(
      "user-1",
      "project-a",
      makeProject(),
      makePost(),
    );
    const secondWorkerOutcome = await processPhase7ForPost(
      "user-1",
      "project-a",
      makeProject(),
      makePost(),
    );

    expect(firstWorkerOutcome).toEqual({ outcome: "lead", enqueued: true });
    expect(secondWorkerOutcome).toEqual({ outcome: "in_progress" });
    // Only ONE AI call total, from the claimant - the losing worker never
    // calls the AI provider at all.
    expect(classifyRelevance).toHaveBeenCalledTimes(1);
    // Only ONE authoritative terminal write - the losing worker never
    // completes/duplicates a processing row.
    expect(mockedComplete).toHaveBeenCalledTimes(1);
  });
});

describe("processPhase7ForPost - error handling", () => {
  it("retries a transient AI failure and succeeds on a later bounded attempt", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockRejectedValueOnce(new RelevanceFilterProviderError("rate limited", "transient"))
      .mockResolvedValueOnce("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      retryDelayMs: 0,
    });

    expect(classifyRelevance).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ outcome: "lead", enqueued: true });
    expect(mockedRecordError).not.toHaveBeenCalled();
  });

  it("bounded retry: gives up after maxAiAttempts transient failures without a tight loop, and never fabricates a terminal outcome", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockRejectedValue(new RelevanceFilterProviderError("temporarily unavailable", "transient"));
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const metrics = createScanMetrics("project-a", "sync-1");
    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      maxAiAttempts: 2,
      retryDelayMs: 0,
      metrics,
    });

    expect(classifyRelevance).toHaveBeenCalledTimes(2); // bounded, not unbounded
    expect(outcome.outcome).toBe("error");
    expect(mockedComplete).not.toHaveBeenCalled(); // never a false terminal outcome
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
    expect(mockedRecordError).toHaveBeenCalledWith("phase7-row-1", expect.stringContaining("unavailable"));
    expect(metrics.phase7Errors).toBe(1);
  });

  it("a permanent AI failure aborts immediately, without retrying", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockRejectedValue(new RelevanceFilterProviderError("invalid API key", "permanent"));
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      retryDelayMs: 0,
    });

    expect(classifyRelevance).toHaveBeenCalledTimes(1); // no retry at all
    expect(outcome.outcome).toBe("error");
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(mockedRecordError).toHaveBeenCalledWith("phase7-row-1", "invalid API key");
  });

  it("malformed AI output (surfaced by the provider as a transient RelevanceFilterProviderError) is retried within the bound, then recorded as an error, never coerced into LEAD or NOT_A_LEAD", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockRejectedValue(new RelevanceFilterProviderError("invalid response: 'banana'", "transient"));
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      maxAiAttempts: 2,
      retryDelayMs: 0,
    });

    expect(outcome.outcome).toBe("error");
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });

  it("an unexpected database failure while claiming never produces a false terminal outcome and never calls the AI provider", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>();
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockRejectedValue(new Error("connection refused"));

    const metrics = createScanMetrics("project-a", "sync-1");
    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      metrics,
    });

    expect(outcome.outcome).toBe("error");
    expect(classifyRelevance).not.toHaveBeenCalled();
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(mockedRecordError).not.toHaveBeenCalled(); // no claimed row exists to attach error info to
    expect(metrics.phase7Errors).toBe(1);
  });

  it("a failure persisting the terminal outcome after a successful AI call is reported as an error and never hands the candidate to Phase 9", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedComplete.mockRejectedValueOnce(new Error("connection refused"));

    const outcome = await processPhase7ForPost("user-1", "project-a", makeProject(), makePost());

    expect(outcome.outcome).toBe("error");
    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });

  it("does not throw out of processPhase7ForPost for any of the above failure modes", async () => {
    mockedClaim.mockRejectedValue(new Error("boom"));
    mockedGetProvider.mockReturnValue(makeProvider(vi.fn()));

    await expect(
      processPhase7ForPost("user-1", "project-a", makeProject(), makePost()),
    ).resolves.toMatchObject({ outcome: "error" });
  });
});

describe("processPhase7ForPost - stale processing recovery (delegated to claimPhase7Processing)", () => {
  it("forwards a caller-provided staleTimeoutMs to claimPhase7Processing so a stale claim can be safely reclaimed", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({
      kind: "claimed",
      row: makeClaimedRow({ attemptCount: 2 }),
    } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    await processPhase7ForPost("user-1", "project-a", makeProject(), makePost(), {
      staleTimeoutMs: 60_000,
    });

    expect(mockedClaim).toHaveBeenCalledWith(
      { projectId: "project-a", userId: "user-1", redditItemId: "t3_post1" },
      60_000,
    );
  });
});

describe("processPhase7ForPost - Phase 9 handoff payload", () => {
  it("hands off the ORIGINAL Reddit post content to enqueueCandidate, with legacy OLD Phase 7/8 fields omitted (never fabricated)", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row-1" } as never);

    const post = makePost({
      title: "Looking for an alternative to Syften",
      body: "We are struggling to find leads.",
    });

    await processPhase7ForPost("user-1", "project-1", makeProject(), post);

    expect(mockedEnqueueCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        userId: "user-1",
        redditItemId: "t3_post1",
        itemType: "post",
        parentPostId: null,
        title: "Looking for an alternative to Syften",
        body: "We are struggling to find leads.",
        matchedText: "Looking for an alternative to Syften\n\nWe are struggling to find leads.",
        authorId: "t2_someuser",
        numComments: 2,
      }),
    );
    const payload = mockedEnqueueCandidate.mock.calls[0][0];
    expect(payload).not.toHaveProperty("matchedTerms");
    expect(payload).not.toHaveProperty("numericalScore");
    expect(payload).not.toHaveProperty("diversityBonus");
    expect(payload).not.toHaveProperty("finalScore");
    expect(payload).not.toHaveProperty("qualificationReason");
  });

  it("NOT_A_LEAD never calls enqueueCandidate at all", async () => {
    const classifyRelevance = vi
      .fn<() => Promise<RelevanceFilterOutcome>>()
      .mockResolvedValue("not_a_lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);

    await processPhase7ForPost("user-1", "project-1", makeProject(), makePost());

    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });

  it("a duplicate Phase 9 queue insert (enqueueCandidate resolving null) is not an error", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue(null);

    const outcome = await processPhase7ForPost("user-1", "project-1", makeProject(), makePost());

    expect(outcome).toEqual({ outcome: "lead", enqueued: false });
  });
});

describe("runPhase7RelevanceFilter", () => {
  it("processes every scanned post sequentially and tallies postsEnteringPhase7", async () => {
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row" } as never);

    const metrics = createScanMetrics("project-1", "sync-1");
    const posts = [makePost({ id: "t3_a" }), makePost({ id: "t3_b" }), makePost({ id: "t3_c" })];

    await runPhase7RelevanceFilter("user-1", "project-1", makeProject(), posts, metrics);

    expect(metrics.postsEnteringPhase7).toBe(3);
    expect(classifyRelevance).toHaveBeenCalledTimes(3);
    expect(metrics.phase7Leads).toBe(3);
  });

  it("never processes comments - only ever receives RedditPostItem[]", async () => {
    // Type-level guarantee: `runPhase7RelevanceFilter`'s signature only
    // accepts `RedditPostItem[]`, so comments can never be passed to it
    // from `RedditScanMatchingHandler` in the first place.
    const classifyRelevance = vi.fn<() => Promise<RelevanceFilterOutcome>>().mockResolvedValue("lead");
    mockedGetProvider.mockReturnValue(makeProvider(classifyRelevance));
    mockedClaim.mockResolvedValue({ kind: "claimed", row: makeClaimedRow() } as Phase7ClaimResult);
    mockedEnqueueCandidate.mockResolvedValue({ id: "queue-row" } as never);

    const metrics = createScanMetrics("project-1", "sync-1");
    await runPhase7RelevanceFilter("user-1", "project-1", makeProject(), [], metrics);

    expect(metrics.postsEnteringPhase7).toBe(0);
    expect(classifyRelevance).not.toHaveBeenCalled();
  });
});
