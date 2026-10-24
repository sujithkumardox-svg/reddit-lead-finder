import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QualifyRedditCandidateResult } from "@/lib/ai/qualify-reddit-candidate";
import { Phase7ClaimAuthError } from "@/lib/scans/phase7-claim-error";
import type { MatchingEngineResult } from "@/lib/matching/matching-engine";
import type { EnqueueGeminiCandidateInput } from "@/types/gemini-qualification-queue";

// `services/gemini-qualification-queue.ts` talks to Supabase via
// `@/lib/supabase/server` (`server-only` + Next's request-scoped
// `cookies()`), which doesn't exist in a plain unit test. Mocking the
// Supabase client itself (rather than this whole service) lets these tests
// verify the exact column lists/filters sent to Postgres - the queue's
// actual persistence contract - without a real database.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import {
  AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE,
  MAX_QUALIFICATION_ATTEMPTS,
  claimNextPending,
  countProjectQueueRowsSince,
  enqueueCandidate,
  hasQueuedRedditItemForProject,
  markCompleted,
  markFailed,
  markGeminiCallAttempted,
  recordGeminiResult,
  recoverStaleProcessing,
  reopenEligibleFailedRows,
  requeueAfterPersistFailure,
  saveQualificationResult,
} from "@/services/gemini-qualification-queue";

const mockedCreateClient = vi.mocked(createClient);

/**
 * A minimal stand-in for Supabase's chainable PostgREST query builder.
 * Every chain method (`insert`, `select`, `update`, `eq`, `lt`, `not`,
 * `is`, `order`, `limit`) records its call and returns the same chain
 * object, so tests can assert on exactly what was sent to Postgres.
 * `single`/`maybeSingle` resolve immediately with `result`; the chain is
 * also directly `await`-able (via `then`) for calls that never terminate
 * with either - mirroring how the real query builder behaves.
 */
function createChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    insert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    is: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

function makeMatchedTerms(): MatchingEngineResult {
  return {
    keywords: [{ term: "lead generation", technique: "Flexible Phrase Matching" }],
    intentPhrases: [{ term: "looking for an alternative", technique: "Flexible Phrase Matching" }],
    painPhrases: [{ term: "struggling to find leads", technique: "Fuzzy Matching" }],
    competitors: [{ term: "Syften", technique: "Exact Competitor Matching" }],
    hiddenKeywordVariations: [{ term: "reddit lead finder", technique: "Stemming" }],
  };
}

function makePostCandidateInput(
  overrides: Partial<EnqueueGeminiCandidateInput> = {},
): EnqueueGeminiCandidateInput {
  return {
    projectId: "project-1",
    userId: "user-1",
    redditItemId: "t3_post1",
    itemType: "post",
    parentPostId: null,
    subreddit: "SaaS",
    title: "Looking for an alternative to Syften",
    body: "We are struggling to find leads.",
    matchedText: "Looking for an alternative to Syften\n\nWe are struggling to find leads.",
    author: "some_user",
    authorId: "t2_someuser",
    permalink: "https://reddit.com/r/SaaS/post1",
    redditScore: 10,
    numComments: 5,
    itemCreatedAt: "2026-08-01T00:00:00.000Z",
    matchedTerms: makeMatchedTerms(),
    numericalScore: 22,
    diversityBonus: 5,
    finalScore: 27,
    qualificationReason: "intent_or_pain",
    ...overrides,
  };
}

function makeCommentCandidateInput(
  overrides: Partial<EnqueueGeminiCandidateInput> = {},
): EnqueueGeminiCandidateInput {
  return {
    projectId: "project-1",
    userId: "user-1",
    redditItemId: "t1_comment1",
    itemType: "comment",
    parentPostId: "t3_post1",
    subreddit: "SaaS",
    title: null,
    body: "I've been struggling to find qualified leads too.",
    matchedText: "I've been struggling to find qualified leads too.",
    author: "another_user",
    authorId: "t2_anotheruser",
    permalink: "https://reddit.com/r/SaaS/post1/comment1",
    redditScore: 3,
    numComments: null,
    itemCreatedAt: "2026-08-01T00:05:00.000Z",
    matchedTerms: makeMatchedTerms(),
    numericalScore: 0,
    diversityBonus: 0,
    finalScore: 0,
    qualificationReason: "intent_or_pain",
    ...overrides,
  };
}

/** A fully-populated DB row (snake_case), as Postgres/PostgREST would return it. */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "queue-row-1",
    project_id: "project-1",
    user_id: "user-1",
    reddit_item_id: "t3_post1",
    item_type: "post",
    parent_post_id: null,
    subreddit: "SaaS",
    title: "Looking for an alternative to Syften",
    body: "We are struggling to find leads.",
    matched_text: "Looking for an alternative to Syften\n\nWe are struggling to find leads.",
    author: "some_user",
    author_id: "t2_someuser",
    permalink: "https://reddit.com/r/SaaS/post1",
    reddit_score: 10,
    num_comments: 5,
    item_created_at: "2026-08-01T00:00:00.000Z",
    matched_terms: makeMatchedTerms(),
    numerical_score: 22,
    diversity_bonus: 5,
    final_score: 27,
    qualification_reason: "intent_or_pain",
    status: "pending",
    processing_started_at: null,
    attempt_count: 0,
    error_message: null,
    ai_qualified: null,
    ai_score: null,
    ai_match_type: null,
    ai_lead_summary: null,
    ai_match_reason: null,
    ai_possible_competitor: null,
    ai_possible_competitor_reason: null,
    ai_provider: null,
    ai_model: null,
    created_at: "2026-08-01T00:00:01.000Z",
    updated_at: "2026-08-01T00:00:01.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockedCreateClient.mockReset();
});

describe("enqueueCandidate", () => {
  it("1. persists a Gemini-qualified post", async () => {
    const chain = createChain({ data: makeDbRow(), error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await enqueueCandidate(makePostCandidateInput());

    expect(from).toHaveBeenCalledWith("gemini_qualification_queue");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        reddit_item_id: "t3_post1",
        item_type: "post",
        parent_post_id: null,
        title: "Looking for an alternative to Syften",
        author_id: "t2_someuser",
        num_comments: 5,
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.itemType).toBe("post");
    expect(row!.authorId).toBe("t2_someuser");
    expect(row!.numComments).toBe(5);
  });

  it("2. persists a Gemini-qualified comment, including its parent post id", async () => {
    const chain = createChain({
      data: makeDbRow({
        id: "queue-row-2",
        reddit_item_id: "t1_comment1",
        item_type: "comment",
        parent_post_id: "t3_post1",
        title: null,
        body: "I've been struggling to find qualified leads too.",
        matched_text: "I've been struggling to find qualified leads too.",
        numerical_score: 0,
        diversity_bonus: 0,
        final_score: 0,
      }),
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const row = await enqueueCandidate(makeCommentCandidateInput());

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        reddit_item_id: "t1_comment1",
        item_type: "comment",
        parent_post_id: "t3_post1",
        title: null,
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.itemType).toBe("comment");
    expect(row!.parentPostId).toBe("t3_post1");
  });

  it("3. stores the complete MatchingEngineResult as matched_terms", async () => {
    const chain = createChain({ data: makeDbRow(), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const matchedTerms = makeMatchedTerms();
    await enqueueCandidate(makePostCandidateInput({ matchedTerms }));

    expect(chain.insert).toHaveBeenCalledWith(expect.objectContaining({ matched_terms: matchedTerms }));
    expect(matchedTerms).toEqual(
      expect.objectContaining({
        keywords: expect.any(Array),
        intentPhrases: expect.any(Array),
        painPhrases: expect.any(Array),
        competitors: expect.any(Array),
        hiddenKeywordVariations: expect.any(Array),
      }),
    );
  });

  it("4-7. persists numericalScore, diversityBonus, finalScore, and qualificationReason from Phase 8", async () => {
    const chain = createChain({ data: makeDbRow(), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await enqueueCandidate(
      makePostCandidateInput({
        numericalScore: 32,
        diversityBonus: 10,
        finalScore: 42,
        qualificationReason: "score_threshold",
      }),
    );

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        numerical_score: 32,
        diversity_bonus: 10,
        final_score: 42,
        qualification_reason: "score_threshold",
      }),
    );
  });

  it("8. treats a unique-violation (23505) as an expected duplicate, not an error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(enqueueCandidate(makePostCandidateInput())).resolves.toBeNull();
  });

  it("throws an authorization error on RLS 42501 and does not retry the insert", async () => {
    const chain = createChain({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy",
        details: "",
        hint: "",
      },
    });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(enqueueCandidate(makePostCandidateInput())).rejects.toBeInstanceOf(Phase7ClaimAuthError);
    expect(from).toHaveBeenCalledTimes(1);
    expect(chain.insert).toHaveBeenCalledTimes(1);
  });

  it("9. relies on the pending default - never sends an explicit status on insert", async () => {
    const chain = createChain({ data: makeDbRow({ status: "pending" }), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const row = await enqueueCandidate(makePostCandidateInput());

    const insertPayload = (chain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(insertPayload).not.toHaveProperty("status");
    expect(row!.status).toBe("pending");
  });

  it("throws (not the duplicate/23505 path) on a genuine, non-duplicate database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(enqueueCandidate(makePostCandidateInput())).rejects.toThrow(
      "Failed to queue Gemini candidate.",
    );
  });
});

describe("claimNextPending", () => {
  it("10. sets processing_started_at and increments attempt_count when claiming a pending row", async () => {
    const selectChain = createChain({ data: { id: "queue-row-1", attempt_count: 2 }, error: null });
    const updateChain = createChain({
      data: makeDbRow({ status: "processing", attempt_count: 3, processing_started_at: "2026-08-01T02:00:00.000Z" }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await claimNextPending();

    expect(selectChain.eq).toHaveBeenCalledWith("status", "pending");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "processing",
        attempt_count: 3,
        processing_started_at: expect.any(String),
      }),
    );
    expect(updateChain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(updateChain.eq).toHaveBeenCalledWith("status", "pending");
    expect(row).not.toBeNull();
    expect(row!.attemptCount).toBe(3);
    expect(row!.status).toBe("processing");
  });

  it("returns null when there is nothing pending", async () => {
    const selectChain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => selectChain) } as never);

    await expect(claimNextPending()).resolves.toBeNull();
  });

  it("when projectId is provided, only selects pending rows for that project", async () => {
    const selectChain = createChain({ data: { id: "queue-row-a", attempt_count: 0 }, error: null });
    const updateChain = createChain({
      data: makeDbRow({ project_id: "project-a", status: "processing", attempt_count: 1 }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await claimNextPending("project-a");

    expect(selectChain.eq).toHaveBeenCalledWith("status", "pending");
    expect(selectChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(selectChain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
    expect(row).not.toBeNull();
    expect(row!.projectId).toBe("project-a");
  });

  it("when projectId is omitted, does not filter the claim by project", async () => {
    const selectChain = createChain({ data: { id: "queue-row-1", attempt_count: 0 }, error: null });
    const updateChain = createChain({
      data: makeDbRow({ status: "processing", attempt_count: 1 }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await claimNextPending();

    const projectFilters = (selectChain.eq as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([column]) => column === "project_id",
    );
    expect(projectFilters).toHaveLength(0);
  });

  it("returns null (does not throw) when another worker wins the claim race", async () => {
    const selectChain = createChain({ data: { id: "queue-row-1", attempt_count: 0 }, error: null });
    const updateChain = createChain({ data: null, error: null });
    const from = vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(claimNextPending()).resolves.toBeNull();
  });
});

describe("recoverStaleProcessing", () => {
  it("11. resets a stale processing row to pending when Gemini was never attempted (gemini_call_attempted_at is null) - B", async () => {
    const flagChain = createChain({ data: [], error: null });
    const resetChain = createChain({ data: [{ id: "queue-row-1" }, { id: "queue-row-2" }], error: null });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const recovered = await recoverStaleProcessing(15 * 60 * 1000);

    // Step 1 (flag ambiguous attempts) always runs first and filters on
    // gemini_call_attempted_at IS NOT NULL AND ai_score IS NULL - a
    // never-attempted row (attempted_at null) never matches this, so it's
    // untouched by step 1 and falls through to step 2's plain reset.
    expect(flagChain.not).toHaveBeenCalledWith("gemini_call_attempted_at", "is", null);
    expect(flagChain.is).toHaveBeenCalledWith("ai_score", null);
    expect(flagChain.update).toHaveBeenCalledWith({
      status: "failed",
      error_message: AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE,
    });

    // Step 2 (safe reset) is a plain "still stale processing" reset -
    // safe because step 1 already moved every ambiguous row out of
    // 'processing' first.
    expect(resetChain.update).toHaveBeenCalledWith({ status: "pending", processing_started_at: null });
    expect(resetChain.eq).toHaveBeenCalledWith("status", "processing");
    expect(resetChain.lt).toHaveBeenCalledWith("processing_started_at", expect.any(String));
    expect(recovered).toBe(2);
  });

  it("reports zero recovered rows when nothing is stale", async () => {
    const flagChain = createChain({ data: [], error: null });
    const resetChain = createChain({ data: [], error: null });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(recoverStaleProcessing()).resolves.toBe(0);
  });

  it("12. does NOT reset an ambiguous stale row to pending - flags it failed with the manual-review message instead - C", async () => {
    // gemini_call_attempted_at is set (a Gemini call may have been made)
    // but no ai_* result was ever recorded (ai_score still null) - Gemini
    // may have already answered right before the crash. This must never
    // be silently retried.
    const flagChain = createChain({ data: [{ id: "queue-row-ambiguous" }], error: null });
    const resetChain = createChain({ data: [], error: null });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const recovered = await recoverStaleProcessing();

    expect(flagChain.update).toHaveBeenCalledWith({
      status: "failed",
      error_message: AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE,
    });
    expect(AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE).toContain("Gemini may have already been called");
    expect(AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE.toLowerCase()).toContain("manual verification");
    // The row was moved to 'failed' by step 1 before step 2's (separate,
    // unconditional) reset query ever runs, so step 2 finds nothing left
    // to reset for it - not counted as "recovered".
    expect(recovered).toBe(0);
  });

  it("13. resets a stale row to pending when a full Gemini result was already recorded (attempted_at set AND ai_score set) - already safe via candidateAlreadyHasGeminiResult downstream", async () => {
    // This row is NOT flagged by step 1 (ai_score is non-null, so the
    // ai_score IS NULL filter excludes it) and so is still 'processing'
    // when step 2 runs - step 2 resets every remaining stale row
    // unconditionally, which is safe here because the worker's
    // candidateAlreadyHasGeminiResult check will reuse the recorded
    // result instead of calling Gemini again once reclaimed.
    const flagChain = createChain({ data: [], error: null });
    const resetChain = createChain({ data: [{ id: "queue-row-checkpointed" }], error: null });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const recovered = await recoverStaleProcessing();

    expect(recovered).toBe(1);
  });

  it("14. returns only the count reset to pending, not the count flagged for manual review", async () => {
    const flagChain = createChain({
      data: [{ id: "ambiguous-1" }, { id: "ambiguous-2" }, { id: "ambiguous-3" }],
      error: null,
    });
    const resetChain = createChain({
      data: [{ id: "safe-1" }, { id: "safe-2" }, { id: "safe-3" }, { id: "safe-4" }, { id: "safe-5" }],
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(recoverStaleProcessing()).resolves.toBe(5);
  });

  it("when projectId is provided, both recovery steps filter to that project only", async () => {
    const flagChain = createChain({ data: [], error: null });
    const resetChain = createChain({ data: [{ id: "queue-row-a" }], error: null });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const recovered = await recoverStaleProcessing(15 * 60 * 1000, "project-a");

    expect(flagChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(flagChain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
    expect(resetChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(resetChain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
    expect(recovered).toBe(1);
  });

  it("throws if flagging ambiguous Gemini attempts fails", async () => {
    const flagChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => flagChain) } as never);

    await expect(recoverStaleProcessing()).rejects.toThrow(
      "Failed to flag ambiguous Gemini candidates for manual review.",
    );
  });

  it("throws if the safe reset step fails", async () => {
    const flagChain = createChain({ data: [], error: null });
    const resetChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    const from = vi.fn().mockReturnValueOnce(flagChain).mockReturnValueOnce(resetChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(recoverStaleProcessing()).rejects.toThrow("Failed to recover stale Gemini candidates.");
  });
});

describe("reopenEligibleFailedRows", () => {
  function reopenPayload(chain: Record<string, unknown>): Record<string, unknown> {
    return (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
  }

  it("reopens a stored Gemini result without clearing the result or the attempt marker", async () => {
    const storedChain = createChain({ data: [{ id: "stored-1" }], error: null });
    const retryableChain = createChain({ data: [], error: null });
    const from = vi.fn().mockReturnValueOnce(storedChain).mockReturnValueOnce(retryableChain);
    mockedCreateClient.mockResolvedValue({ from } as never);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reopened = await reopenEligibleFailedRows("project-a");

    expect(reopenPayload(storedChain)).toEqual({
      status: "pending",
      processing_started_at: null,
    });
    expect(reopenPayload(storedChain)).not.toHaveProperty("ai_score");
    expect(reopenPayload(storedChain)).not.toHaveProperty("ai_qualified");
    expect(reopenPayload(storedChain)).not.toHaveProperty("gemini_call_attempted_at");
    expect(reopenPayload(storedChain)).not.toHaveProperty("attempt_count");
    expect(reopenPayload(storedChain)).not.toHaveProperty("error_message");
    expect(storedChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(storedChain.eq).toHaveBeenCalledWith("status", "failed");
    expect(storedChain.not).toHaveBeenCalledWith("ai_score", "is", null);
    expect(storedChain.lt).not.toHaveBeenCalled();
    expect(storedChain.neq).not.toHaveBeenCalled();
    expect(reopened.storedResults).toBe(1);
    expect(reopened.retryableFailures).toBe(0);
    consoleWarnSpy.mockRestore();
  });

  it("reopens a qualification or enrichment failure that has no stored result and is under the attempt cap", async () => {
    const storedChain = createChain({ data: [], error: null });
    const retryableChain = createChain({ data: [{ id: "retry-1" }], error: null });
    const from = vi.fn().mockReturnValueOnce(storedChain).mockReturnValueOnce(retryableChain);
    mockedCreateClient.mockResolvedValue({ from } as never);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reopened = await reopenEligibleFailedRows("project-a");

    expect(reopenPayload(retryableChain)).toEqual({
      status: "pending",
      processing_started_at: null,
    });
    expect(reopenPayload(retryableChain)).not.toHaveProperty("attempt_count");
    expect(reopenPayload(retryableChain)).not.toHaveProperty("gemini_call_attempted_at");
    expect(retryableChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(retryableChain.eq).toHaveBeenCalledWith("status", "failed");
    expect(retryableChain.is).toHaveBeenCalledWith("ai_score", null);
    expect(retryableChain.neq).toHaveBeenCalledWith("error_message", AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE);
    expect(retryableChain.lt).toHaveBeenCalledWith("attempt_count", MAX_QUALIFICATION_ATTEMPTS);
    expect(MAX_QUALIFICATION_ATTEMPTS).toBe(3);
    expect(reopened.retryableFailures).toBe(1);
    consoleWarnSpy.mockRestore();
  });

  it("does not match an ambiguous Gemini outcome or a row already at the attempt limit", async () => {
    const storedChain = createChain({ data: [], error: null });
    const retryableChain = createChain({ data: [], error: null });
    const from = vi.fn().mockReturnValueOnce(storedChain).mockReturnValueOnce(retryableChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const reopened = await reopenEligibleFailedRows("project-a");

    expect(retryableChain.neq).toHaveBeenCalledWith("error_message", AMBIGUOUS_GEMINI_ATTEMPT_MESSAGE);
    expect(retryableChain.lt).toHaveBeenCalledWith("attempt_count", 3);
    expect(retryableChain.is).toHaveBeenCalledWith("ai_score", null);
    expect(storedChain.not).toHaveBeenCalledWith("ai_score", "is", null);
    expect(reopened).toEqual({ storedResults: 0, retryableFailures: 0 });
  });

  it("does not reopen failed rows for another project", async () => {
    const storedChain = createChain({ data: [], error: null });
    const retryableChain = createChain({ data: [], error: null });
    const from = vi.fn().mockReturnValueOnce(storedChain).mockReturnValueOnce(retryableChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await reopenEligibleFailedRows("project-a");

    expect(storedChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(retryableChain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(storedChain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
    expect(retryableChain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
  });

  it("a repeated recovery still requires status failed, so a row that already left failed is not updated", async () => {
    const firstStored = createChain({ data: [{ id: "stored-1" }], error: null });
    const firstRetryable = createChain({ data: [{ id: "retry-1" }], error: null });
    const secondStored = createChain({ data: [], error: null });
    const secondRetryable = createChain({ data: [], error: null });
    const from = vi
      .fn()
      .mockReturnValueOnce(firstStored)
      .mockReturnValueOnce(firstRetryable)
      .mockReturnValueOnce(secondStored)
      .mockReturnValueOnce(secondRetryable);
    mockedCreateClient.mockResolvedValue({ from } as never);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await reopenEligibleFailedRows("project-a");
    const second = await reopenEligibleFailedRows("project-a");

    for (const chain of [firstStored, firstRetryable, secondStored, secondRetryable]) {
      expect(chain.eq).toHaveBeenCalledWith("status", "failed");
      expect(chain.eq).toHaveBeenCalledWith("project_id", "project-a");
      expect(reopenPayload(chain)).not.toHaveProperty("attempt_count");
    }
    expect(first).toEqual({ storedResults: 1, retryableFailures: 1 });
    expect(second).toEqual({ storedResults: 0, retryableFailures: 0 });
    consoleWarnSpy.mockRestore();
  });

  it("throws instead of reporting a stored-result reopen when the update fails", async () => {
    const storedChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => storedChain) } as never);

    await expect(reopenEligibleFailedRows("project-a")).rejects.toThrow(
      "Failed to reopen stored Gemini results.",
    );
  });

  it("throws instead of reporting a retryable reopen when that update fails", async () => {
    const storedChain = createChain({ data: [], error: null });
    const retryableChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    const from = vi.fn().mockReturnValueOnce(storedChain).mockReturnValueOnce(retryableChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(reopenEligibleFailedRows("project-a")).rejects.toThrow(
      "Failed to reopen retryable qualification failures.",
    );
  });
});

describe("markGeminiCallAttempted", () => {
  it("15. durably writes gemini_call_attempted_at for the given row - works identically for posts and comments (no item_type involved)", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await markGeminiCallAttempted("queue-row-1");

    expect(from).toHaveBeenCalledWith("gemini_qualification_queue");
    expect(chain.update).toHaveBeenCalledWith({ gemini_call_attempted_at: expect.any(String) });
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.select).toHaveBeenCalledWith("id");
    expect(chain.update).toHaveBeenCalledTimes(1);
  });

  it("throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(markGeminiCallAttempted("queue-row-1")).rejects.toThrow(
      "Failed to record that a Gemini call was attempted.",
    );
  });

  it("does not treat a zero-row update as a recorded Gemini attempt", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(markGeminiCallAttempted("queue-row-1")).rejects.toThrow(
      "Failed to record that a Gemini call was attempted.",
    );
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id");
  });
});

describe("markCompleted", () => {
  it("12. marks a candidate completed (retained, not deleted)", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await markCompleted("queue-row-1");

    expect(chain.update).toHaveBeenCalledWith({ status: "completed", error_message: null });
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.select).toHaveBeenCalledWith("id");
    expect(chain).not.toHaveProperty("delete");
  });

  it("does not treat a zero-row update as a completed queue row", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(markCompleted("queue-row-1")).rejects.toThrow(
      "Failed to mark Gemini candidate as completed.",
    );
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id");
    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe("completed");
  });
});

describe("hasQueuedRedditItemForProject", () => {
  it("matches only the same project and reddit item", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(hasQueuedRedditItemForProject("project-a", "t3_post1")).resolves.toBe(true);

    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(chain.eq).toHaveBeenCalledWith("reddit_item_id", "t3_post1");
    expect(chain.eq).not.toHaveBeenCalledWith("project_id", "project-b");
  });

  it("returns false when this project has no queue row, including when another project might", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(hasQueuedRedditItemForProject("project-a", "t3_post1")).resolves.toBe(false);
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-a");
  });
});

describe("markFailed", () => {
  it("13. marks a candidate failed with an error message (retained, not deleted, available for retry/inspection)", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await markFailed("queue-row-1", "Gemini request timed out");

    expect(chain.update).toHaveBeenCalledWith({
      status: "failed",
      error_message: "Gemini request timed out",
    });
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.select).toHaveBeenCalledWith("id");
    expect(chain).not.toHaveProperty("delete");
  });

  it("does not treat a zero-row update as a failed queue row", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(markFailed("queue-row-1", "Gemini request timed out")).rejects.toThrow(
      "Failed to mark Gemini candidate as failed.",
    );
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id");
    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.status).not.toBe("pending");
  });
});

describe("requeueAfterPersistFailure", () => {
  it("returns the row to pending without clearing the stored Gemini result", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await requeueAfterPersistFailure("queue-row-1", "Failed to persist qualified lead.");

    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({
      status: "pending",
      processing_started_at: null,
      error_message: "Failed to persist qualified lead.",
    });
    expect(payload).not.toHaveProperty("ai_score");
    expect(payload).not.toHaveProperty("gemini_call_attempted_at");
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.eq).toHaveBeenCalledWith("status", "processing");
  });
});

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

describe("saveQualificationResult", () => {
  it("14. persists the full Gemini result, including ai_possible_competitor_reason, and marks the row completed", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const result = makeQualifyResult({
      aiPossibleCompetitor: "Syften",
      aiPossibleCompetitorReason: "The author says they currently use Syften for the same purpose.",
    });
    await saveQualificationResult("queue-row-1", result);

    expect(chain.update).toHaveBeenCalledWith({
      ai_qualified: true,
      ai_score: 9,
      ai_match_type: "intent",
      ai_lead_summary: "Actively looking for a lead-gen tool.",
      ai_match_reason: "Explicitly asks for recommendations.",
      ai_possible_competitor: "Syften",
      ai_possible_competitor_reason: "The author says they currently use Syften for the same purpose.",
      ai_provider: "google",
      ai_model: "gemini-3.5-flash",
      status: "completed",
      error_message: null,
    });
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.select).toHaveBeenCalledWith("id");
  });

  it("15. persists a null ai_possible_competitor_reason when there is no possible competitor", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await saveQualificationResult("queue-row-1", makeQualifyResult());

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_possible_competitor: null,
        ai_possible_competitor_reason: null,
      }),
    );
  });

  it("does not treat a zero-row update as a completed qualification", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(saveQualificationResult("queue-row-1", makeQualifyResult())).rejects.toThrow(
      "Failed to save Gemini qualification result.",
    );
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id");
  });
});

describe("recordGeminiResult", () => {
  it("16. writes every ai_* column but never touches status or error_message", async () => {
    const chain = createChain({ data: { id: "queue-row-1" }, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const result = makeQualifyResult({
      aiPossibleCompetitor: "Syften",
      aiPossibleCompetitorReason: "The author says they currently use Syften for the same purpose.",
    });
    await recordGeminiResult("queue-row-1", result);

    expect(chain.update).toHaveBeenCalledWith({
      ai_qualified: true,
      ai_score: 9,
      ai_match_type: "intent",
      ai_lead_summary: "Actively looking for a lead-gen tool.",
      ai_match_reason: "Explicitly asks for recommendations.",
      ai_possible_competitor: "Syften",
      ai_possible_competitor_reason: "The author says they currently use Syften for the same purpose.",
      ai_provider: "google",
      ai_model: "gemini-3.5-flash",
    });
    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("error_message");
    expect(chain.eq).toHaveBeenCalledWith("id", "queue-row-1");
    expect(chain.select).toHaveBeenCalledWith("id");
  });

  it("does not treat a zero-row update as a stored Gemini result", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(recordGeminiResult("queue-row-1", makeQualifyResult())).rejects.toThrow(
      "Failed to record Gemini qualification result.",
    );
    expect(chain.update).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id");
    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("status");
  });

  it("17. throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(recordGeminiResult("queue-row-1", makeQualifyResult())).rejects.toThrow(
      "Failed to record Gemini qualification result.",
    );
  });
});

describe("countProjectQueueRowsSince", () => {
  it("counts this project's queue rows created at or after the given timestamp", async () => {
    const chain = createChain({ data: null, error: null });
    (chain as { then: unknown }).then = (
      onFulfilled: (value: { data: unknown; error: unknown; count: number }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: null, error: null, count: 3 }).then(onFulfilled, onRejected);
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const count = await countProjectQueueRowsSince("project-1", "2026-08-22T10:00:00.000Z");

    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.gte).toHaveBeenCalledWith("created_at", "2026-08-22T10:00:00.000Z");
    expect(count).toBe(3);
  });
});
