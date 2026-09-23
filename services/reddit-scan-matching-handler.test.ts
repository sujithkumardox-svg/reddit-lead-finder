import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RedditCommentItem, RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

// `services/projects.ts` talks to Supabase (via `server-only` + Next's
// request-scoped `cookies()`), which doesn't exist in a plain unit test.
// Mocking it here keeps this test focused on the adapter/handler wiring -
// it never exercises real Supabase access.
vi.mock("@/services/projects", () => ({
  getProjectScanData: vi.fn(),
}));

// NEW Phase 7 itself (claim -> AI call -> persist -> Phase 9 handoff) is
// fully covered by `services/reddit-phase7-relevance-filter.test.ts`.
// Mocking it here keeps this test focused on exactly one thing: does the
// handler load the project's business context correctly and hand the
// scanned posts to NEW Phase 7 at the right seam?
vi.mock("@/services/reddit-phase7-relevance-filter", () => ({
  runPhase7RelevanceFilter: vi.fn(),
}));

import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import { runPhase7RelevanceFilter } from "@/services/reddit-phase7-relevance-filter";
import { createScanMetrics } from "@/lib/scans/scan-metrics";
import {
  RedditScanMatchingHandler,
  buildPhase7ProjectContext,
} from "@/services/reddit-scan-matching-handler";

const mockedGetProjectScanData = vi.mocked(getProjectScanData);
const mockedRunPhase7RelevanceFilter = vi.mocked(runPhase7RelevanceFilter);

function makeScanData(overrides: Partial<ProjectScanData> = {}): ProjectScanData {
  return {
    id: "project-1",
    isActive: true,
    description: "A Reddit lead-generation tool.",
    keywords: ["lead generation"],
    hiddenKeywords: ["reddit lead finder"],
    intentPhrases: ["looking for an alternative"],
    painPhrases: ["struggling to find leads"],
    competitors: ["Syften"],
    subreddits: ["SaaS"],
    ...overrides,
  };
}

function makePost(overrides: Partial<RedditPostItem> = {}): RedditPostItem {
  return {
    id: "t3_post1",
    type: "post",
    subreddit: "SaaS",
    title: "Looking for an alternative to Syften",
    body: "We are struggling to find leads.",
    author: "some_user",
    authorId: "t2_someuser",
    url: "https://reddit.com/r/SaaS/post1",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeComment(overrides: Partial<RedditCommentItem> = {}): RedditCommentItem {
  return {
    id: "t1_comment1",
    type: "comment",
    subreddit: "SaaS",
    postId: "t3_post1",
    body: "Just a neutral comment with no matches at all.",
    author: "another_user",
    authorId: "t2_anotheruser",
    permalink: "https://reddit.com/r/SaaS/post1/comment1",
    score: 3,
    createdAt: "2026-08-01T00:05:00.000Z",
    ...overrides,
  };
}

function makeScanResult(overrides: Partial<RedditScanResult> = {}): RedditScanResult {
  return {
    projectId: "project-1",
    scannedAt: "2026-08-01T01:00:00.000Z",
    subredditsScanned: ["SaaS"],
    posts: [],
    comments: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockedGetProjectScanData.mockReset();
  mockedRunPhase7RelevanceFilter.mockReset();
  mockedRunPhase7RelevanceFilter.mockResolvedValue(undefined);
});

describe("buildPhase7ProjectContext", () => {
  it("maps the project's business context fields through unchanged, dropping hidden/internal-only fields", () => {
    const scanData = makeScanData();

    expect(buildPhase7ProjectContext(scanData)).toEqual({
      description: "A Reddit lead-generation tool.",
      keywords: ["lead generation"],
      intentPhrases: ["looking for an alternative"],
      painPhrases: ["struggling to find leads"],
      competitors: ["Syften"],
    });
  });
});

describe("RedditScanMatchingHandler", () => {
  it("loads the project's business context and hands every scanned post to NEW Phase 7", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    const scanResult = makeScanResult({ posts: [post], comments: [] });

    await handler.handleScanResult(scanResult);

    expect(mockedGetProjectScanData).toHaveBeenCalledWith("user-1", "project-1");
    expect(mockedRunPhase7RelevanceFilter).toHaveBeenCalledWith(
      "user-1",
      "project-1",
      {
        description: "A Reddit lead-generation tool.",
        keywords: ["lead generation"],
        intentPhrases: ["looking for an alternative"],
        painPhrases: ["struggling to find leads"],
        competitors: ["Syften"],
      },
      [post],
      undefined,
    );
  });

  it("throws if the project can no longer be found", async () => {
    mockedGetProjectScanData.mockResolvedValue(null);

    const handler = new RedditScanMatchingHandler("user-1");

    await expect(handler.handleScanResult(makeScanResult())).rejects.toThrow("Project not found.");
    expect(mockedRunPhase7RelevanceFilter).not.toHaveBeenCalled();
  });

  it("never passes scanned comments to NEW Phase 7 - only posts", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    const comment = makeComment();
    await handler.handleScanResult(makeScanResult({ posts: [post], comments: [comment] }));

    expect(mockedRunPhase7RelevanceFilter).toHaveBeenCalledTimes(1);
    const passedPosts = mockedRunPhase7RelevanceFilter.mock.calls[0][3];
    expect(passedPosts).toEqual([post]);
  });

  it("forwards the optional ScanRunMetrics accumulator through to NEW Phase 7 unchanged", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    const metrics = createScanMetrics("project-1", "sync-1");

    const handler = new RedditScanMatchingHandler("user-1", metrics);
    await handler.handleScanResult(makeScanResult({ posts: [makePost()], comments: [] }));

    expect(mockedRunPhase7RelevanceFilter).toHaveBeenCalledWith(
      "user-1",
      "project-1",
      expect.anything(),
      expect.anything(),
      metrics,
    );
  });

  it("propagates a NEW Phase 7 failure instead of silently swallowing it", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    mockedRunPhase7RelevanceFilter.mockRejectedValueOnce(new Error("unexpected failure"));

    const handler = new RedditScanMatchingHandler("user-1");

    await expect(
      handler.handleScanResult(makeScanResult({ posts: [makePost()], comments: [] })),
    ).rejects.toThrow("unexpected failure");
  });
});
