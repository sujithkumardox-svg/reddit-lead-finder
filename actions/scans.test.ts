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

function fakeJwt(sub: string, expSeconds = Math.floor(Date.now() / 1000) + 60 * 60): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, exp: expSeconds, role: "authenticated" }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

function mockAuth(input?: {
  user?: { id: string } | null;
  accessToken?: string | null;
  getUser?: ReturnType<typeof vi.fn>;
  getSession?: ReturnType<typeof vi.fn>;
}) {
  const user = input?.user === undefined ? { id: "user-1" } : input.user;
  const accessToken =
    input && "accessToken" in input
      ? input.accessToken
      : user
        ? fakeJwt(user.id)
        : null;
  const getUser =
    input?.getUser ?? vi.fn().mockResolvedValue({ data: { user }, error: null });
  const getSession =
    input?.getSession ??
    vi.fn().mockResolvedValue({
      data: {
        session: accessToken ? { access_token: accessToken, user } : null,
      },
      error: null,
    });
  mockedCreateClient.mockResolvedValue({ auth: { getUser, getSession } } as never);
  return { getUser, getSession, accessToken };
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  mockedGetProjectScanData.mockResolvedValue({
    id: "project-1",
    isActive: true,
    description: "A Reddit lead-generation tool.",
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
    mockAuth();

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
      accessToken: expect.any(String),
    });
  });

  it("rejects a second scan while a current scan is running and does not insert another row", async () => {
    mockAuth();
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
    mockAuth({ user: null });

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({
      ok: false,
      error: "You must be signed in to start a scan.",
    });
    expect(mockedGetProjectScanData).not.toHaveBeenCalled();
    expect(mockedInsertRunning).not.toHaveBeenCalled();
  });

  it("another user's project cannot start a scan and no sync_logs row is created", async () => {
    mockAuth({ user: { id: "user-2" } });
    mockedGetProjectScanData.mockResolvedValueOnce(null);

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({ ok: false, error: "Project not found." });
    expect(mockedGetProjectScanData).toHaveBeenCalledWith("user-2", "project-1");
    expect(mockedInsertRunning).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("does not start a scan when the access token subject does not match the verified user", async () => {
    mockAuth({ user: { id: "user-1" }, accessToken: fakeJwt("user-2") });

    const result = await startProjectScanAction("project-1");

    expect(result).toEqual({
      ok: false,
      error: "You must be signed in to start a scan.",
    });
    expect(mockedInsertRunning).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("does not retry a permanent auth failure when starting a scan", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 401, code: "bad_jwt", message: "invalid JWT" },
    });
    mockAuth({ getUser });

    const result = await startProjectScanAction("project-1");

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: "You must be signed in to start a scan.",
    });
    expect(mockedInsertRunning).not.toHaveBeenCalled();
  });

  it("retries a transient auth 429 once when starting a scan, then starts with the verified token", async () => {
    vi.useFakeTimers();
    const getUser = vi
      .fn()
      .mockResolvedValueOnce({
        data: { user: null },
        error: {
          status: 429,
          code: "over_request_rate_limit",
          message: "Request rate limit reached",
        },
      })
      .mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    const { getSession } = mockAuth({ getUser });

    const pending = startProjectScanAction("project-1");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(getUser).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, syncLogId: "sync-1" });
    expect(mockedInsertRunning).toHaveBeenCalledWith("user-1", "project-1");
    vi.useRealTimers();
  });
});

describe("getProjectScanStatusAction", () => {
  it("running + empty queue = scanning", async () => {
    mockAuth();
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
    mockAuth();
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
    mockAuth();
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

  it("success with zero leads = completed and still includes the dashboard redirect path", async () => {
    mockAuth();
    mockedGetLatest.mockResolvedValueOnce({
      id: "sync-1",
      projectId: "project-1",
      userId: "user-1",
      status: "success",
      leadsFound: 0,
      errorMessage: null,
      startedAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:05:00.000Z",
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:05:00.000Z",
    });
    mockedInfer.mockReturnValueOnce("completed");

    const result = await getProjectScanStatusAction("project-1");

    // Zero leads must never be treated as an ongoing scan: "completed" and
    // its dashboard redirect must still be returned exactly as they are
    // for a non-zero lead count.
    expect(mockedCountQueue).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: {
        stage: "completed",
        syncLogId: "sync-1",
        leadsFound: 0,
        errorMessage: null,
        dashboardPath: "/projects/project-1/dashboard",
      },
    });
  });

  it("failed = failed and does not redirect", async () => {
    mockAuth();
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
    mockAuth({ user: { id: "user-2" } });
    mockedGetProjectScanData.mockResolvedValueOnce(null);

    const result = await getProjectScanStatusAction("project-1");

    expect(result).toEqual({ ok: false, error: "Project not found." });
    expect(mockedGetLatest).not.toHaveBeenCalled();
  });

  it("does not call getUser while polling and still scopes the lookup to the token subject", async () => {
    const { getUser, getSession } = mockAuth();

    await getProjectScanStatusAction("project-1");

    expect(getUser).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(mockedGetProjectScanData).toHaveBeenCalledWith("user-1", "project-1");
  });

  it("returns a retryable rate-limit result without marking the project lookup as unauthorized", async () => {
    const getSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: {
        status: 429,
        code: "over_request_rate_limit",
        message: "Request rate limit reached",
      },
    });
    const { getUser } = mockAuth({ getSession });

    const result = await getProjectScanStatusAction("project-1");

    expect(getUser).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      error: "Authentication is temporarily rate limited. Please try again.",
      retryable: true,
    });
    expect(mockedGetProjectScanData).not.toHaveBeenCalled();
  });
});
