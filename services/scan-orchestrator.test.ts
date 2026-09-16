import { beforeEach, describe, expect, it, vi } from "vitest";

import { RedditApiError } from "@/lib/reddit/reddit-api-client";

vi.mock("@/services/reddit-scanner", () => ({
  scanProjectReddit: vi.fn(),
}));

vi.mock("@/services/reddit-scan-matching-handler", () => ({
  RedditScanMatchingHandler: class {
    constructor(public userId: string) {}
  },
}));

vi.mock("@/services/gemini-qualification-worker", () => ({
  runGeminiQualificationWorker: vi.fn(),
}));

vi.mock("@/services/reddit-leads", () => ({
  countLeadsCreatedSince: vi.fn(),
}));

vi.mock("@/services/sync-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync-logs")>();
  return {
    ...actual,
    getScanById: vi.fn(),
    markScanSuccess: vi.fn(),
    markScanFailed: vi.fn(),
  };
});

import { runGeminiQualificationWorker } from "@/services/gemini-qualification-worker";
import { countLeadsCreatedSince } from "@/services/reddit-leads";
import { RedditScanMatchingHandler } from "@/services/reddit-scan-matching-handler";
import { scanProjectReddit } from "@/services/reddit-scanner";
import { runProjectScan } from "@/services/scan-orchestrator";
import { getScanById, markScanFailed, markScanSuccess } from "@/services/sync-logs";

const mockedScanProjectReddit = vi.mocked(scanProjectReddit);
const mockedRunWorker = vi.mocked(runGeminiQualificationWorker);
const mockedCountLeads = vi.mocked(countLeadsCreatedSince);
const mockedGetScanById = vi.mocked(getScanById);
const mockedMarkSuccess = vi.mocked(markScanSuccess);
const mockedMarkFailed = vi.mocked(markScanFailed);

beforeEach(() => {
  vi.clearAllMocks();
  mockedScanProjectReddit.mockResolvedValue({
    projectId: "project-1",
    scannedAt: "2026-08-22T10:00:00.000Z",
    subredditsScanned: [],
    posts: [],
    comments: [],
  });
  mockedRunWorker.mockResolvedValue({
    processed: 1,
    qualified: 1,
    failed: 0,
    geminiCallsPerformed: 1,
    geminiDuplicateSkips: 0,
    geminiErrors: 0,
    strong8to10: 1,
    partial6to7: 0,
    notQualified0to5: 0,
    leadsPersisted: 1,
    persistFailed: 0,
  });
  mockedGetScanById.mockResolvedValue({
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
  });
  mockedCountLeads.mockResolvedValue(1);
  mockedMarkSuccess.mockResolvedValue(undefined);
  mockedMarkFailed.mockResolvedValue(undefined);
});

describe("runProjectScan", () => {
  it("happy path: scanner, project-scoped worker, persist count, sync_logs success", async () => {
    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
    });

    expect(mockedScanProjectReddit).toHaveBeenCalledTimes(1);
    const [, , handler] = mockedScanProjectReddit.mock.calls[0];
    expect(handler).toBeInstanceOf(RedditScanMatchingHandler);
    expect(mockedRunWorker).toHaveBeenCalledWith({
      projectId: "project-1",
      metrics: expect.objectContaining({
        projectId: "project-1",
        syncLogId: "sync-1",
      }),
    });
    expect(mockedCountLeads).toHaveBeenCalledWith(
      "user-1",
      "project-1",
      "2026-08-22T10:00:00.000Z",
    );
    expect(mockedMarkSuccess).toHaveBeenCalledWith(
      "sync-1",
      1,
      expect.objectContaining({
        projectId: "project-1",
        syncLogId: "sync-1",
        leadsFound: 1,
        qualified: 1,
      }),
    );
    expect(mockedMarkFailed).not.toHaveBeenCalled();
  });

  it("marks sync_logs success even when zero leads are found - completion must not depend on lead count", async () => {
    mockedRunWorker.mockResolvedValueOnce({
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
    mockedCountLeads.mockResolvedValueOnce(0);

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
    });

    expect(mockedMarkSuccess).toHaveBeenCalledWith(
      "sync-1",
      0,
      expect.objectContaining({
        projectId: "project-1",
        syncLogId: "sync-1",
        leadsFound: 0,
        qualified: 0,
      }),
    );
    expect(mockedMarkFailed).not.toHaveBeenCalled();
  });

  it("marks sync_logs failed with a safe message when Reddit scanning throws", async () => {
    mockedScanProjectReddit.mockRejectedValueOnce(
      new RedditApiError(
        "Missing Reddit API credentials. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT.",
      ),
    );

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
    });

    expect(mockedRunWorker).not.toHaveBeenCalled();
    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "Reddit scanning is not configured.",
      expect.objectContaining({
        projectId: "project-1",
        syncLogId: "sync-1",
      }),
    );
    const [, message] = mockedMarkFailed.mock.calls[0];
    expect(message).not.toMatch(/REDDIT_CLIENT_SECRET|CLIENT_ID/i);
  });

  it("can be invoked with explicit userId/projectId and no cookie/session arguments", async () => {
    await runProjectScan({
      userId: "scheduler-user",
      projectId: "scheduler-project",
      syncLogId: "sync-sched",
    });

    expect(mockedScanProjectReddit).toHaveBeenCalledWith(
      "scheduler-user",
      "scheduler-project",
      expect.any(RedditScanMatchingHandler),
      expect.objectContaining({
        metrics: expect.objectContaining({
          projectId: "scheduler-project",
          syncLogId: "sync-sched",
        }),
      }),
    );
    expect(mockedRunWorker).toHaveBeenCalledWith({
      projectId: "scheduler-project",
      metrics: expect.objectContaining({
        projectId: "scheduler-project",
        syncLogId: "sync-sched",
      }),
    });
    expect(mockedScanProjectReddit.mock.calls[0].length).toBe(4);
  });
});
