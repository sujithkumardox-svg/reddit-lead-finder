import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordPhase7OutcomeInput } from "@/types/reddit-phase7-processing";

// `services/reddit-phase7-processing.ts` talks to Supabase via
// `@/lib/supabase/server` (`server-only` + Next's request-scoped
// `cookies()`), which doesn't exist in a plain unit test. Mocking the
// Supabase client itself (rather than this whole service) lets these
// tests verify the exact filters/payloads sent to Postgres - the storage/
// dedup contract - without a real database, mirroring the convention used
// in `services/gemini-qualification-queue.test.ts` and
// `services/reddit-leads.test.ts`.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import {
  claimPhase7Processing,
  completePhase7Processing,
  getPhase7ProcessingRecord,
  hasProcessedRedditItem,
  recordPhase7Outcome,
  recordPhase7ProcessingError,
} from "@/services/reddit-phase7-processing";

const mockedCreateClient = vi.mocked(createClient);

/**
 * A minimal stand-in for Supabase's chainable PostgREST query builder,
 * mirroring `gemini-qualification-queue.test.ts`/`reddit-leads.test.ts`.
 * `single`/`maybeSingle` resolve immediately with `result`; every other
 * chain method records its call and returns the same chain object.
 */
function createChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    insert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

/** A fully-populated DB row (snake_case), as Postgres/PostgREST would return it - defaults to a "completed" terminal row, matching what every Prompt 1 row looks like after `20260923090000_reddit_phase7_processing_claim.sql`'s backward-safe column defaults. */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase7-row-1",
    project_id: "project-a",
    user_id: "user-1",
    reddit_item_id: "t3_postx",
    status: "completed",
    outcome: "lead",
    attempt_count: 1,
    processing_started_at: null,
    last_error: null,
    last_error_at: null,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

/** A fully-populated "in-flight" row (status still `processing`, no terminal outcome yet), as Postgres/PostgREST would return it right after a fresh claim. */
function makeProcessingDbRow(overrides: Record<string, unknown> = {}) {
  return makeDbRow({
    status: "processing",
    outcome: null,
    attempt_count: 1,
    processing_started_at: "2026-09-23T00:00:00.000Z",
    last_error: null,
    last_error_at: null,
    ...overrides,
  });
}

function makeRecordInput(
  overrides: Partial<RecordPhase7OutcomeInput> = {},
): RecordPhase7OutcomeInput {
  return {
    projectId: "project-a",
    userId: "user-1",
    redditItemId: "t3_postx",
    outcome: "lead",
    ...overrides,
  };
}

beforeEach(() => {
  mockedCreateClient.mockReset();
});

describe("getPhase7ProcessingRecord / hasProcessedRedditItem", () => {
  it("A. Project A + Post X with no existing record - eligible for processing", async () => {
    const chain = createChain({ data: null, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const record = await getPhase7ProcessingRecord("project-a", "t3_postx");

    expect(from).toHaveBeenCalledWith("reddit_phase7_processing");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-a");
    expect(chain.eq).toHaveBeenCalledWith("reddit_item_id", "t3_postx");
    expect(record).toBeNull();

    // hasProcessedRedditItem builds on the same lookup.
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => createChain({ data: null, error: null })) } as never);
    await expect(hasProcessedRedditItem("project-a", "t3_postx")).resolves.toBe(false);
  });

  it("B. Project A + Post X with an existing LEAD record - treated as already processed", async () => {
    const chain = createChain({ data: makeDbRow({ outcome: "lead" }), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const record = await getPhase7ProcessingRecord("project-a", "t3_postx");
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe("lead");

    mockedCreateClient.mockResolvedValue({
      from: vi.fn(() => createChain({ data: makeDbRow({ outcome: "lead" }), error: null })),
    } as never);
    await expect(hasProcessedRedditItem("project-a", "t3_postx")).resolves.toBe(true);
  });

  it("C. Project A + Post X with an existing NOT_A_LEAD record - treated as already processed", async () => {
    const chain = createChain({ data: makeDbRow({ outcome: "not_a_lead" }), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const record = await getPhase7ProcessingRecord("project-a", "t3_postx");
    expect(record).not.toBeNull();
    expect(record!.outcome).toBe("not_a_lead");

    mockedCreateClient.mockResolvedValue({
      from: vi.fn(() => createChain({ data: makeDbRow({ outcome: "not_a_lead" }), error: null })),
    } as never);
    await expect(hasProcessedRedditItem("project-a", "t3_postx")).resolves.toBe(true);
  });

  it("D. Project B + Post X is still eligible even though Project A + Post X already exists", async () => {
    // The lookup is always scoped by project_id, so Project A's existing
    // record is never returned (and never even matched) for Project B's
    // query - a real database would simply find zero rows for this filter.
    const chain = createChain({ data: null, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const record = await getPhase7ProcessingRecord("project-b", "t3_postx");

    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-b");
    expect(chain.eq).not.toHaveBeenCalledWith("project_id", "project-a");
    expect(record).toBeNull();
  });

  it("throws on a genuine, non-duplicate database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(getPhase7ProcessingRecord("project-a", "t3_postx")).rejects.toThrow(
      "Failed to look up the Phase 7 processing record.",
    );
  });
});

describe("recordPhase7Outcome", () => {
  it("persists a LEAD outcome for a (project, reddit item) pair", async () => {
    const chain = createChain({ data: makeDbRow({ outcome: "lead" }), error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await recordPhase7Outcome(makeRecordInput({ outcome: "lead" }));

    expect(from).toHaveBeenCalledWith("reddit_phase7_processing");
    expect(chain.insert).toHaveBeenCalledWith({
      project_id: "project-a",
      user_id: "user-1",
      reddit_item_id: "t3_postx",
      outcome: "lead",
    });
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("lead");
  });

  it("persists a NOT_A_LEAD outcome - it counts as processed just like LEAD", async () => {
    const chain = createChain({ data: makeDbRow({ outcome: "not_a_lead" }), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const row = await recordPhase7Outcome(makeRecordInput({ outcome: "not_a_lead" }));

    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not_a_lead" }),
    );
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("not_a_lead");
  });

  it("E. a second insert for the same (project, reddit item) pair is rejected by the database's uniqueness constraint (23505) and treated as an expected duplicate, not an error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(recordPhase7Outcome(makeRecordInput())).resolves.toBeNull();
  });

  it("throws (not the duplicate/23505 path) on a genuine, non-duplicate database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(recordPhase7Outcome(makeRecordInput())).rejects.toThrow(
      "Failed to record Phase 7 processing outcome.",
    );
  });
});

describe("claimPhase7Processing", () => {
  it("F. a fresh (project, reddit item) pair is claimed via a plain insert - no existing row lookup needed", async () => {
    const insertChain = createChain({ data: makeProcessingDbRow(), error: null });
    const from = vi.fn(() => insertChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing({
      projectId: "project-a",
      userId: "user-1",
      redditItemId: "t3_postx",
    });

    expect(from).toHaveBeenCalledTimes(1);
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-a",
        user_id: "user-1",
        reddit_item_id: "t3_postx",
        status: "processing",
        outcome: null,
        attempt_count: 1,
      }),
    );
    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.row.status).toBe("processing");
      expect(result.row.outcome).toBeNull();
    }
  });

  it("G. Project A + Post X already completed LEAD - the insert conflict resolves to already_processed with the recorded outcome, and the AI must never be called", async () => {
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({ data: makeDbRow({ status: "completed", outcome: "lead" }), error: null });
    const from = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(selectChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing({
      projectId: "project-a",
      userId: "user-1",
      redditItemId: "t3_postx",
    });

    expect(result).toEqual({ kind: "already_processed", outcome: "lead" });
  });

  it("H. Project A + Post X already completed NOT_A_LEAD - resolves to already_processed with that outcome", async () => {
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      data: makeDbRow({ status: "completed", outcome: "not_a_lead" }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(selectChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing({
      projectId: "project-a",
      userId: "user-1",
      redditItemId: "t3_postx",
    });

    expect(result).toEqual({ kind: "already_processed", outcome: "not_a_lead" });
  });

  it("I. Concurrency: a second worker's claim attempt on the same, still-active (non-stale) row resolves to in_progress and never reaches the AI call site", async () => {
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      // Freshly claimed just now by the "first worker" - not stale.
      data: makeProcessingDbRow({ processing_started_at: new Date().toISOString() }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(selectChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing({
      projectId: "project-a",
      userId: "user-1",
      redditItemId: "t3_postx",
    });

    expect(result).toEqual({ kind: "in_progress" });
    // Only two calls total (insert attempt + lookup) - no update/reclaim
    // attempt for a non-stale active claim.
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("J. Stale processing recovery: a processing row far older than the timeout is safely reclaimed, incrementing attempt_count and clearing prior error info", async () => {
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      data: makeProcessingDbRow({
        processing_started_at: staleStartedAt,
        attempt_count: 1,
        last_error: "previous transient failure",
        last_error_at: staleStartedAt,
      }),
      error: null,
    });
    const reclaimChain = createChain({
      data: makeProcessingDbRow({ processing_started_at: new Date().toISOString(), attempt_count: 2 }),
      error: null,
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(reclaimChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing(
      { projectId: "project-a", userId: "user-1", redditItemId: "t3_postx" },
      5 * 60 * 1000, // 5-minute staleness timeout - shorter than the 10-minute-old claim above
    );

    expect(reclaimChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt_count: 2,
        last_error: null,
        last_error_at: null,
      }),
    );
    expect(reclaimChain.eq).toHaveBeenCalledWith("status", "processing");
    expect(reclaimChain.eq).toHaveBeenCalledWith("processing_started_at", staleStartedAt);
    expect(result.kind).toBe("claimed");
    if (result.kind === "claimed") {
      expect(result.row.attemptCount).toBe(2);
    }
    // Never a second inserted row for this pair - the same row (id) is
    // reused in place via UPDATE, not a fresh INSERT.
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("K. Stale reclaim race: a second reclaimer's guarded update matches zero rows and resolves to in_progress instead of double-claiming", async () => {
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      data: makeProcessingDbRow({ processing_started_at: staleStartedAt, attempt_count: 1 }),
      error: null,
    });
    // Another reclaimer already won - this guarded update matches 0 rows.
    const reclaimChain = createChain({ data: null, error: null });
    const from = vi
      .fn()
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(reclaimChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing(
      { projectId: "project-a", userId: "user-1", redditItemId: "t3_postx" },
      5 * 60 * 1000,
    );

    expect(result).toEqual({ kind: "in_progress" });
  });

  it("L. Project B + Post X is independently claimable even though Project A + Post X is already claimed/completed", async () => {
    const insertChain = createChain({ data: makeProcessingDbRow({ project_id: "project-b" }), error: null });
    const from = vi.fn(() => insertChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const result = await claimPhase7Processing({
      projectId: "project-b",
      userId: "user-2",
      redditItemId: "t3_postx",
    });

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "project-b", reddit_item_id: "t3_postx" }),
    );
    expect(result.kind).toBe("claimed");
  });

  it("throws on a genuine, non-duplicate insert error", async () => {
    const insertChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => insertChain) } as never);

    await expect(
      claimPhase7Processing({ projectId: "project-a", userId: "user-1", redditItemId: "t3_postx" }),
    ).rejects.toThrow("Failed to claim the Phase 7 processing row.");
  });

  it("throws if the post-conflict lookup fails with a genuine database error", async () => {
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    const from = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(selectChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(
      claimPhase7Processing({ projectId: "project-a", userId: "user-1", redditItemId: "t3_postx" }),
    ).rejects.toThrow("Failed to look up the existing Phase 7 processing row after a claim conflict.");
  });

  it("throws if the reclaim update fails with a genuine database error", async () => {
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const insertChain = createChain({
      data: null,
      error: { code: "23505", message: "duplicate key value", details: "", hint: "" },
    });
    const selectChain = createChain({
      data: makeProcessingDbRow({ processing_started_at: staleStartedAt }),
      error: null,
    });
    const reclaimChain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    const from = vi
      .fn()
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(selectChain)
      .mockReturnValueOnce(reclaimChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(
      claimPhase7Processing(
        { projectId: "project-a", userId: "user-1", redditItemId: "t3_postx" },
        5 * 60 * 1000,
      ),
    ).rejects.toThrow("Failed to reclaim the stale Phase 7 processing row.");
  });
});

describe("completePhase7Processing", () => {
  it("M. marks a claimed row completed with its terminal outcome, clearing any prior error info", async () => {
    const chain = createChain({ data: null, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await completePhase7Processing("phase7-row-1", "lead");

    expect(from).toHaveBeenCalledWith("reddit_phase7_processing");
    expect(chain.update).toHaveBeenCalledWith({
      status: "completed",
      outcome: "lead",
      last_error: null,
      last_error_at: null,
    });
    expect(chain.eq).toHaveBeenCalledWith("id", "phase7-row-1");
  });

  it("persists a NOT_A_LEAD terminal outcome identically", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await completePhase7Processing("phase7-row-1", "not_a_lead");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", outcome: "not_a_lead" }),
    );
  });

  it("throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(completePhase7Processing("phase7-row-1", "lead")).rejects.toThrow(
      "Failed to complete the Phase 7 processing row.",
    );
  });
});

describe("recordPhase7ProcessingError", () => {
  it("N. records diagnostic error info WITHOUT touching status/outcome - the row stays retryable, never a false terminal outcome", async () => {
    const chain = createChain({ data: null, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await recordPhase7ProcessingError("phase7-row-1", "Gemini request timed out");

    expect(from).toHaveBeenCalledWith("reddit_phase7_processing");
    const payload = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("outcome");
    expect(payload.last_error).toBe("Gemini request timed out");
    expect(payload.last_error_at).toEqual(expect.any(String));
    expect(chain.eq).toHaveBeenCalledWith("id", "phase7-row-1");
  });

  it("throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(recordPhase7ProcessingError("phase7-row-1", "boom")).rejects.toThrow(
      "Failed to record the Phase 7 processing error.",
    );
  });
});
