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
  getPhase7ProcessingRecord,
  hasProcessedRedditItem,
  recordPhase7Outcome,
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

/** A fully-populated DB row (snake_case), as Postgres/PostgREST would return it. */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase7-row-1",
    project_id: "project-a",
    user_id: "user-1",
    reddit_item_id: "t3_postx",
    outcome: "lead",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
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
