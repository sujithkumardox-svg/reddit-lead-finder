import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

// `services/projects.ts` talks to Supabase (via `server-only` + Next's
// request-scoped `cookies()`), which doesn't exist in a plain unit test.
// Mocking it here keeps this test focused on the adapter/handler logic -
// it never exercises real Supabase access.
vi.mock("@/services/projects", () => ({
  getProjectScanData: vi.fn(),
}));

import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import {
  RedditScanMatchingHandler,
  mapProjectScanDataToOnboardingTerms,
} from "@/services/reddit-scan-matching-handler";

const mockedGetProjectScanData = vi.mocked(getProjectScanData);

function makeScanData(overrides: Partial<ProjectScanData> = {}): ProjectScanData {
  return {
    id: "project-1",
    isActive: true,
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
    url: "https://reddit.com/r/SaaS/post1",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
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
});

describe("mapProjectScanDataToOnboardingTerms", () => {
  it("maps all five onboarding categories, renaming hiddenKeywords to hiddenKeywordVariations", () => {
    const scanData = makeScanData();

    expect(mapProjectScanDataToOnboardingTerms(scanData)).toEqual({
      keywords: ["lead generation"],
      intentPhrases: ["looking for an alternative"],
      painPhrases: ["struggling to find leads"],
      competitors: ["Syften"],
      hiddenKeywordVariations: ["reddit lead finder"],
    });
  });
});

describe("RedditScanMatchingHandler", () => {
  it("returns null before handleScanResult has run", () => {
    const handler = new RedditScanMatchingHandler("user-1");
    expect(handler.getMatchingResult()).toBeNull();
  });

  it("loads the project's onboarding terms and matches every post/comment, exposing results via getMatchingResult()", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    const scanResult = makeScanResult({ posts: [post], comments: [] });

    await handler.handleScanResult(scanResult);

    expect(mockedGetProjectScanData).toHaveBeenCalledWith("user-1", "project-1");

    const matchingResult = handler.getMatchingResult();
    expect(matchingResult).not.toBeNull();
    expect(matchingResult!.posts).toHaveLength(1);
    expect(matchingResult!.posts[0].text).toBe(
      "Looking for an alternative to Syften\n\nWe are struggling to find leads.",
    );
    expect(matchingResult!.posts[0].result.competitors.map((m) => m.term)).toContain("Syften");
  });

  it("throws if the project can no longer be found", async () => {
    mockedGetProjectScanData.mockResolvedValue(null);

    const handler = new RedditScanMatchingHandler("user-1");

    await expect(handler.handleScanResult(makeScanResult())).rejects.toThrow("Project not found.");
  });
});
