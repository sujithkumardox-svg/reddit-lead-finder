import { beforeEach, describe, expect, it, vi } from "vitest";

import { RedditApiError } from "@/lib/reddit/reddit-api-client";
import { Phase7ClaimAuthError } from "@/lib/scans/phase7-claim-error";

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
      accessToken: "scan-access-token",
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
      accessToken: "scan-access-token",
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
      accessToken: "scan-access-token",
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

  it("marks the scan failed when Phase 7 authorization is rejected and does not mark it successful", async () => {
    mockedScanProjectReddit.mockRejectedValueOnce(new Phase7ClaimAuthError("42501"));

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "The scan could not be authorized. Please sign in again.",
      expect.objectContaining({
        projectId: "project-1",
        syncLogId: "sync-1",
      }),
    );
  });

  it("marks the scan failed when a Phase 9 candidate fails and does not mark it successful", async () => {
    mockedRunWorker.mockResolvedValueOnce({
      processed: 1,
      qualified: 0,
      failed: 1,
      geminiCallsPerformed: 1,
      geminiDuplicateSkips: 0,
      geminiErrors: 1,
      strong8to10: 0,
      partial6to7: 0,
      notQualified0to5: 0,
      leadsPersisted: 0,
      persistFailed: 0,
    });

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "The scan could not finish qualifying every lead.",
      expect.objectContaining({ projectId: "project-1", syncLogId: "sync-1" }),
    );
  });

  it("marks the scan failed when a Phase 7 lead could not be queued", async () => {
    mockedScanProjectReddit.mockImplementationOnce(async (_userId, _projectId, _handler, options) => {
      if (options?.metrics) {
        options.metrics.queueInsertFailed = 1;
      }
      return {
        projectId: "project-1",
        scannedAt: "2026-08-22T10:00:00.000Z",
        subredditsScanned: [],
        posts: [],
        comments: [],
      };
    });
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

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "The scan could not queue one or more leads for qualification.",
      expect.objectContaining({ queueInsertFailed: 1 }),
    );
  });

  it("marks the scan failed when Phase 7 reports errors and still succeeds when it does not", async () => {
    mockedScanProjectReddit.mockImplementationOnce(async (_userId, _projectId, _handler, options) => {
      if (options?.metrics) {
        options.metrics.phase7Errors = 1;
      }
      return {
        projectId: "project-1",
        scannedAt: "2026-08-22T10:00:00.000Z",
        subredditsScanned: [],
        posts: [],
        comments: [],
      };
    });

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "The scan could not finish classifying every post.",
      expect.objectContaining({ phase7Errors: 1 }),
    );

    mockedMarkSuccess.mockClear();
    mockedMarkFailed.mockClear();
    mockedScanProjectReddit.mockResolvedValueOnce({
      projectId: "project-1",
      scannedAt: "2026-08-22T10:00:00.000Z",
      subredditsScanned: [],
      posts: [],
      comments: [],
    });

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(mockedMarkSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not mark the scan successful when a live Phase 7 claim was skipped", async () => {
    mockedScanProjectReddit.mockImplementationOnce(async (_userId, _projectId, _handler, options) => {
      if (options?.metrics) {
        options.metrics.phase7ConcurrentSkipped = 1;
      }
      return {
        projectId: "project-1",
        scannedAt: "2026-08-22T10:00:00.000Z",
        subredditsScanned: [],
        posts: [],
        comments: [],
      };
    });

    await runProjectScan({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
      accessToken: "scan-access-token",
    });

    expect(mockedMarkSuccess).not.toHaveBeenCalled();
    expect(mockedMarkFailed).toHaveBeenCalledWith(
      "sync-1",
      "The scan could not finish classifying every post.",
      expect.objectContaining({ phase7ConcurrentSkipped: 1, phase7Errors: 0 }),
    );
  });

  it("runs from an explicit user, project, and access token", async () => {
    await runProjectScan({
      userId: "scheduler-user",
      projectId: "scheduler-project",
      syncLogId: "sync-sched",
      accessToken: "scheduler-access-token",
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
