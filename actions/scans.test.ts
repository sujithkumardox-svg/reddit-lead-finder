import { beforeEach, describe, expect, it, vi } from "vitest";

const afterCallbacks: Array<() => void> = [];

vi.mock("next/server", () => ({
  after: vi.fn((fn: () => void) => {
    afterCallbacks.push(fn);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("@/services/projects", () => ({
  getProjectScanData: vi.fn(),
}));

vi.mock("@/services/sync-logs", () => ({
  getBlockingRunningScan: vi.fn(),
  getLatestScan: vi.fn(),
  inferScanStage: vi.fn(),
  insertRunningScan: vi.fn(),
}));

vi.mock("@/services/scan-orchestrator", () => ({
  runProjectScan: vi.fn(),
}));

vi.mock("@/services/gemini-qualification-queue", () => ({
  countProjectQueueRowsSince: vi.fn(),
}));

import { getProjectScanStatusAction, startProjectScanAction } from "@/actions/scans";
import { createClient } from "@/lib/supabase/server";
import { countProjectQueueRowsSince } from "@/services/gemini-qualification-queue";
import { getProjectScanData } from "@/services/projects";
import { runProjectScan } from "@/services/scan-orchestrator";
import {
  getBlockingRunningScan,
  getLatestScan,
  inferScanStage,
  insertRunningScan,
} from "@/services/sync-logs";

const mockedCreateClient = vi.mocked(createClient);
const mockedGetProjectScanData = vi.mocked(getProjectScanData);
const mockedGetBlocking = vi.mocked(getBlockingRunningScan);
const mockedInsertRunning = vi.mocked(insertRunningScan);
const mockedRunProjectScan = vi.mocked(runProjectScan);
const mockedGetLatest = vi.mocked(getLatestScan);
const mockedInfer = vi.mocked(inferScanStage);
const mockedCountQueue = vi.mocked(countProjectQueueRowsSince);

function mockUser(user: { id: string } | null) {
  mockedCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  mockedGetProjectScanData.mockResolvedValue({
    id: "project-1",
    isActive: true,
    keywords: [],
    hiddenKeywords: [],
    intentPhrases: [],
    painPhrases: [],
    competitors: [],
    subreddits: [],
  });
  mockedGetBlocking.mockResolvedValue(null);
  mockedInsertRunning.mockResolvedValue({
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
  mockedRunProjectScan.mockResolvedValue(undefined);
});

describe("startProjectScanAction", () => {
  it("returns immediately with syncLogId and does not await the full scan", async () => {
    mockUser({ id: "user-1" });

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({ ok: true, syncLogId: "sync-1" });
    expect(mockedInsertRunning).toHaveBeenCalledWith("user-1", "project-1");
    expect(mockedRunProjectScan).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    afterCallbacks[0]();
    expect(mockedRunProjectScan).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      syncLogId: "sync-1",
    });
  });

  it("rejects a second scan while a current scan is running and does not insert another row", async () => {
    mockUser({ id: "user-1" });
    mockedGetBlocking.mockResolvedValueOnce({
      id: "sync-running",
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

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({
      ok: false,
      error: "A scan is already running for this project.",
    });
    expect(mockedInsertRunning).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("unauthorized user cannot start a scan and no sync_logs row is created", async () => {
    mockUser(null);

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({
      ok: false,
      error: "You must be signed in to start a scan.",
    });
    expect(mockedGetProjectScanData).not.toHaveBeenCalled();
    expect(mockedInsertRunning).not.toHaveBeenCalled();
  });

  it("another user's project cannot start a scan and no sync_logs row is created", async () => {
    mockUser({ id: "user-2" });
    mockedGetProjectScanData.mockResolvedValueOnce(null);

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({ ok: false, error: "Project not found." });
    expect(mockedGetProjectScanData).toHaveBeenCalledWith("user-2", "project-1");
    expect(mockedInsertRunning).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("getProjectScanStatusAction", () => {
  it("running + empty queue = scanning", async () => {
    mockUser({ id: "user-1" });
    mockedGetLatest.mockResolvedValueOnce({
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
    mockedCountQueue.mockResolvedValueOnce(0);
    mockedInfer.mockReturnValueOnce("scanning");

    const result = await getProjectScanStatusAction("project-1");

    expect(mockedCountQueue).toHaveBeenCalledWith("project-1", "2026-08-22T10:00:00.000Z");
    expect(mockedInfer).toHaveBeenCalledWith({
      latest: expect.objectContaining({ status: "running" }),
      hasQueueRowsSinceStart: false,
    });
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        stage: "scanning",
        dashboardPath: null,
      }),
    });
  });

  it("running + queue rows = scoring", async () => {
    mockUser({ id: "user-1" });
    mockedGetLatest.mockResolvedValueOnce({
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
    mockedCountQueue.mockResolvedValueOnce(2);
    mockedInfer.mockReturnValueOnce("scoring");

    const result = await getProjectScanStatusAction("project-1");

    expect(mockedInfer).toHaveBeenCalledWith({
      latest: expect.objectContaining({ status: "running" }),
      hasQueueRowsSinceStart: true,
    });
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({ stage: "scoring", dashboardPath: null }),
    });
  });

  it("success = completed and includes the dashboard redirect path", async () => {
    mockUser({ id: "user-1" });
    mockedGetLatest.mockResolvedValueOnce({
      id: "sync-1",
      projectId: "project-1",
      userId: "user-1",
      status: "success",
      leadsFound: 3,
      errorMessage: null,
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:05:00.000Z",
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:05:00.000Z",
    });
    mockedInfer.mockReturnValueOnce("completed");

    const result = await getProjectScanStatusAction("project-1");

    expect(mockedCountQueue).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: {
        stage: "completed",
        syncLogId: "sync-1",
        leadsFound: 3,
        errorMessage: null,
        dashboardPath: "/projects/project-1/dashboard",
      },
    });
  });

  it("failed = failed and does not redirect", async () => {
    mockUser({ id: "user-1" });
    mockedGetLatest.mockResolvedValueOnce({
      id: "sync-1",
      projectId: "project-1",
      userId: "user-1",
      status: "failed",
      leadsFound: 0,
      errorMessage: "The Reddit scan failed. Please try again.",
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:02:00.000Z",
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:02:00.000Z",
    });
    mockedInfer.mockReturnValueOnce("failed");

    const result = await getProjectScanStatusAction("project-1");

    expect(result).toEqual({
      ok: true,
      data: {
        stage: "failed",
        syncLogId: "sync-1",
        leadsFound: 0,
        errorMessage: "The Reddit scan failed. Please try again.",
        dashboardPath: null,
      },
    });
  });

  it("rejects status polling for another user's project", async () => {
    mockUser({ id: "user-2" });
    mockedGetProjectScanData.mockResolvedValueOnce(null);

    const result = await getProjectScanStatusAction("project-1");

    expect(result).toEqual({ ok: false, error: "Project not found." });
    expect(mockedGetLatest).not.toHaveBeenCalled();
  });
});
