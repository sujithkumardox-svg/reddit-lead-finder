import { beforeEach, describe, expect, it, vi } from "vitest";

import { RedditApiError } from "@/lib/reddit/reddit-api-client";
import type { SyncLogRow } from "@/types/sync-logs";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import {
  STALE_RUNNING_ERROR_MESSAGE,
  STALE_RUNNING_TIMEOUT_MS,
  failStaleRunningScans,
  getBlockingRunningScan,
  getLatestScan,
  inferScanStage,
  insertRunningScan,
  markScanFailed,
  markScanSuccess,
  toSafeScanErrorMessage,
} from "@/services/sync-logs";

const mockedCreateClient = vi.mocked(createClient);

function createChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    insert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    lt: vi.fn(() => chain),
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

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sync-1",
    project_id: "project-1",
    user_id: "user-1",
    status: "running",
    leads_found: 0,
    error_message: null,
    started_at: "2026-08-22T10:00:00.000Z",
    completed_at: null,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<SyncLogRow> = {}): SyncLogRow {
  return {
    id: "sync-1",
    projectId: "project-1",
    userId: "user-1",
    status: "running",
    leadsFound: 0,
    errorMessage: null,
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockedCreateClient.mockReset();
});

describe("insertRunningScan", () => {
  it("inserts a running scan row and returns the mapped record", async () => {
    const chain = createChain({ data: makeDbRow(), error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await insertRunningScan("user-1", "project-1");

    expect(from).toHaveBeenCalledWith("sync_logs");
    expect(chain.insert).toHaveBeenCalledWith({
      project_id: "project-1",
      user_id: "user-1",
      status: "running",
      leads_found: 0,
    });
    expect(row.status).toBe("running");
    expect(row.id).toBe("sync-1");
    expect(row.projectId).toBe("project-1");
  });
});

describe("markScanSuccess", () => {
  it("marks the row success with leads_found and completed_at", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await markScanSuccess("sync-1", 4);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        leads_found: 4,
        error_message: null,
        completed_at: expect.any(String),
      }),
    );
    expect(chain.eq).toHaveBeenCalledWith("id", "sync-1");
  });
});

describe("markScanFailed", () => {
  it("marks the row failed with a safe error_message and completed_at", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await markScanFailed("sync-1", "The Reddit scan failed. Please try again.");

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error_message: "The Reddit scan failed. Please try again.",
        completed_at: expect.any(String),
      }),
    );
    expect(chain.eq).toHaveBeenCalledWith("id", "sync-1");
  });
});

describe("getLatestScan", () => {
  it("returns the newest scan for the owned project", async () => {
    const chain = createChain({ data: makeDbRow({ status: "success", leads_found: 2 }), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const row = await getLatestScan("user-1", "project-1");

    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.order).toHaveBeenCalledWith("started_at", { ascending: false });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("success");
    expect(row!.leadsFound).toBe(2);
  });

  it("returns null when the project has no scan rows", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(getLatestScan("user-1", "project-1")).resolves.toBeNull();
  });
});

describe("failStaleRunningScans", () => {
  it("marks running rows older than the stale timeout as failed", async () => {
    const chain = createChain({ data: [{ id: "sync-stale" }], error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const count = await failStaleRunningScans("user-1", "project-1");

    expect(chain.update).toHaveBeenCalledWith({
      status: "failed",
      error_message: STALE_RUNNING_ERROR_MESSAGE,
      completed_at: expect.any(String),
    });
    expect(chain.eq).toHaveBeenCalledWith("status", "running");
    expect(chain.lt).toHaveBeenCalledWith("started_at", expect.any(String));
    expect(count).toBe(1);
  });
});

describe("getBlockingRunningScan", () => {
  it("returns the current running scan after recovering stale rows", async () => {
    const staleChain = createChain({ data: [], error: null });
    const runningChain = createChain({
      data: makeDbRow({ started_at: new Date().toISOString() }),
      error: null,
    });
    const from = vi.fn().mockReturnValueOnce(staleChain).mockReturnValueOnce(runningChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const row = await getBlockingRunningScan("user-1", "project-1");

    expect(row).not.toBeNull();
    expect(row!.status).toBe("running");
    expect(runningChain.eq).toHaveBeenCalledWith("status", "running");
  });

  it("returns null when no non-stale running scan exists", async () => {
    const staleChain = createChain({ data: [], error: null });
    const runningChain = createChain({ data: null, error: null });
    const from = vi.fn().mockReturnValueOnce(staleChain).mockReturnValueOnce(runningChain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await expect(getBlockingRunningScan("user-1", "project-1")).resolves.toBeNull();
  });
});

describe("inferScanStage", () => {
  it("not_started when there is no scan row", () => {
    expect(inferScanStage({ latest: null, hasQueueRowsSinceStart: false })).toBe("not_started");
  });

  it("scanning when running and the Gemini queue is still empty", () => {
    expect(inferScanStage({ latest: makeRow(), hasQueueRowsSinceStart: false })).toBe("scanning");
  });

  it("scoring when running and Gemini queue rows exist since started_at", () => {
    expect(inferScanStage({ latest: makeRow(), hasQueueRowsSinceStart: true })).toBe("scoring");
  });

  it("completed when sync_logs status is success", () => {
    expect(
      inferScanStage({
        latest: makeRow({ status: "success", leadsFound: 3 }),
        hasQueueRowsSinceStart: true,
      }),
    ).toBe("completed");
  });

  it("failed when sync_logs status is failed", () => {
    expect(
      inferScanStage({
        latest: makeRow({ status: "failed", errorMessage: "The scan failed. Please try again." }),
        hasQueueRowsSinceStart: false,
      }),
    ).toBe("failed");
  });
});

describe("toSafeScanErrorMessage", () => {
  it("does not expose Reddit credential details", () => {
    const message = toSafeScanErrorMessage(
      new RedditApiError(
        "Missing Reddit API credentials. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT.",
      ),
    );

    expect(message).toBe("Reddit scanning is not configured.");
    expect(message).not.toMatch(/REDDIT_CLIENT_SECRET|CLIENT_ID|USER_AGENT/i);
  });

  it("maps other Reddit API errors to a generic scan failure", () => {
    expect(toSafeScanErrorMessage(new RedditApiError("401 unauthorized", { status: 401 }))).toBe(
      "The Reddit scan failed. Please try again.",
    );
  });

  it("never returns raw secret-like strings from unknown errors", () => {
    expect(toSafeScanErrorMessage(new Error("token=super-secret-value"))).toBe(
      "The scan failed. Please try again.",
    );
  });
});

describe("stale-running timeout", () => {
  it("is 15 minutes so a crashed scan cannot lock the project forever", () => {
    expect(STALE_RUNNING_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});
