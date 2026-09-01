import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

vi.mock("@/services/projects", () => ({
  getProjectScanData: vi.fn(),
}));

vi.mock("@/lib/reddit/providers/create-reddit-post-search-provider", () => ({
  createRedditPostSearchProvider: vi.fn(() => ({
    searchPosts: vi.fn(async () => []),
  })),
}));

vi.mock("@/lib/reddit/reddit-listings", () => ({
  getPostComments: vi.fn(),
  searchSubredditPosts: vi.fn(),
}));

import { buildSearchTerms } from "@/lib/reddit/build-search-terms";
import { applyFreePlanTestLimits } from "@/lib/reddit/free-plan-test-limits";
import type { RedditPostSearchProvider } from "@/lib/reddit/providers/reddit-post-search-provider";
import { RedditProviderError } from "@/lib/reddit/providers/reddit-post-search-provider";
import { getPostComments } from "@/lib/reddit/reddit-listings";
import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import { scanProjectReddit } from "@/services/reddit-scanner";

const mockedGetProjectScanData = vi.mocked(getProjectScanData);
const mockedGetPostComments = vi.mocked(getPostComments);

const originalFlag = process.env.USE_FREE_PLAN_TEST_LIMITS;

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

function makeScanData(overrides: Partial<ProjectScanData> = {}): ProjectScanData {
  return {
    id: "project-1",
    isActive: true,
    keywords: ["lead generation"],
    hiddenKeywords: ["reddit lead finder"],
    intentPhrases: ["looking for an alternative"],
    painPhrases: ["struggling to find leads"],
    competitors: ["Syften"],
    subreddits: ["SaaS", "startups"],
    ...overrides,
  };
}

function makePost(overrides: Partial<RedditPostItem> = {}): RedditPostItem {
  return {
    id: "t3_post1",
    type: "post",
    subreddit: "SaaS",
    title: "Looking for an alternative",
    body: "We are struggling to find leads.",
    author: "some_user",
    authorId: "t2_someuser",
    url: "https://reddit.com/r/SaaS/post1",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 0,
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeHandler() {
  return {
    handleScanResult: vi.fn(async (_result: RedditScanResult) => undefined),
  };
}

function makeFakeProvider(
  impl: RedditPostSearchProvider["searchPosts"] = async () => [],
): RedditPostSearchProvider & { searchPosts: ReturnType<typeof vi.fn> } {
  return {
    searchPosts: vi.fn(impl),
  };
}

beforeEach(() => {
  mockedGetProjectScanData.mockReset();
  mockedGetPostComments.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
  delete process.env.USE_FREE_PLAN_TEST_LIMITS;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalFlag === undefined) {
    delete process.env.USE_FREE_PLAN_TEST_LIMITS;
  } else {
    process.env.USE_FREE_PLAN_TEST_LIMITS = originalFlag;
  }
});

describe("scanProjectReddit", () => {
  it("makes one provider call per subreddit with the full buildSearchTerms() list", async () => {
    const scanData = makeScanData();
    mockedGetProjectScanData.mockResolvedValue(scanData);
    const expectedTerms = buildSearchTerms(scanData);
    const provider = makeFakeProvider(async () => [makePost()]);
    const handler = makeHandler();

    const result = await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(provider.searchPosts).toHaveBeenCalledTimes(scanData.subreddits.length);
    for (const [index, subreddit] of scanData.subreddits.entries()) {
      expect(provider.searchPosts).toHaveBeenNthCalledWith(index + 1, {
        subreddit,
        searchTerms: expectedTerms,
        postsPerQuery: 25,
      });
    }
    expect(result.comments).toEqual([]);
    expect(mockedGetPostComments).not.toHaveBeenCalled();
    expect(handler.handleScanResult).toHaveBeenCalledWith(
      expect.objectContaining({ comments: [] }),
    );
  });

  it("with the temporary overlay on, 4 test subreddits produce exactly 4 provider calls of 39 test terms", async () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "true";
    const scanData = makeScanData({
      keywords: numbered("kw", 20),
      hiddenKeywords: numbered("hidden", 20),
      intentPhrases: numbered("intent", 15),
      painPhrases: numbered("pain", 15),
      competitors: numbered("comp", 8),
      subreddits: numbered("sub", 10),
    });
    mockedGetProjectScanData.mockResolvedValue(scanData);

    const overlay = applyFreePlanTestLimits(scanData);
    const expectedTerms = buildSearchTerms(overlay);
    const provider = makeFakeProvider(async () => []);
    const handler = makeHandler();

    await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(overlay.subreddits).toHaveLength(4);
    expect(expectedTerms).toHaveLength(39);
    expect(provider.searchPosts).toHaveBeenCalledTimes(4);
    for (const call of provider.searchPosts.mock.calls) {
      expect(call[0].searchTerms).toEqual(expectedTerms);
      expect(call[0].searchTerms).toHaveLength(39);
    }
    expect(provider.searchPosts.mock.calls.map((call) => call[0].subreddit)).toEqual(
      overlay.subreddits,
    );
  });

  it("N production subreddits produce N provider calls with no overlay", async () => {
    const scanData = makeScanData({
      subreddits: ["SaaS", "startups", "entrepreneur"],
    });
    mockedGetProjectScanData.mockResolvedValue(scanData);
    const provider = makeFakeProvider(async () => []);
    const handler = makeHandler();

    await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(provider.searchPosts).toHaveBeenCalledTimes(3);
    expect(provider.searchPosts.mock.calls.map((call) => call[0].subreddit)).toEqual([
      "SaaS",
      "startups",
      "entrepreneur",
    ]);
  });

  it("drops posts older than 7 days and keeps in-window posts", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData({ subreddits: ["SaaS"] }));
    const provider = makeFakeProvider(async () => [
      makePost({ id: "t3_old", createdAt: "2026-08-20T12:00:00.000Z" }),
      makePost({ id: "t3_new", createdAt: "2026-08-28T12:00:00.000Z" }),
    ]);
    const handler = makeHandler();

    const result = await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(result.posts.map((post) => post.id)).toEqual(["t3_new"]);
  });

  it("dedupes posts by id after all subreddits", async () => {
    mockedGetProjectScanData.mockResolvedValue(
      makeScanData({ subreddits: ["SaaS", "startups"] }),
    );
    const duplicate = makePost({ id: "t3_dup", subreddit: "SaaS" });
    const provider = makeFakeProvider(async ({ subreddit }) => [
      { ...duplicate, subreddit },
    ]);
    const handler = makeHandler();

    const result = await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].id).toBe("t3_dup");
  });

  it("applies the per-subreddit cap after the 7-day filter", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData({ subreddits: ["SaaS"] }));
    const provider = makeFakeProvider(async () =>
      Array.from({ length: 60 }, (_, i) =>
        makePost({ id: `t3_${i}`, createdAt: "2026-08-28T12:00:00.000Z" }),
      ),
    );
    const handler = makeHandler();

    const result = await scanProjectReddit("user-1", "project-1", handler, {
      provider,
      maxPostsPerSubreddit: 50,
    });

    expect(result.posts).toHaveLength(50);
  });

  it("skips a subreddit on a non-fatal provider error and continues others", async () => {
    mockedGetProjectScanData.mockResolvedValue(
      makeScanData({ subreddits: ["SaaS", "startups"] }),
    );
    const provider = makeFakeProvider(async ({ subreddit }) => {
      if (subreddit === "SaaS") {
        throw new RedditProviderError("The Reddit scan provider run did not succeed.", {
          code: "actor_failed",
          fatal: false,
        });
      }
      return [makePost({ id: "t3_ok", subreddit: "startups" })];
    });
    const handler = makeHandler();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await scanProjectReddit("user-1", "project-1", handler, { provider });

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].id).toBe("t3_ok");
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toMatch(/APIFY_TOKEN/);
    consoleErrorSpy.mockRestore();
  });

  it("fails the scan on a fatal missing-credentials provider error", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData({ subreddits: ["SaaS"] }));
    const provider = makeFakeProvider(async () => {
      throw new RedditProviderError("The Reddit scan provider is not configured.", {
        code: "missing_credentials",
        fatal: true,
      });
    });
    const handler = makeHandler();

    await expect(scanProjectReddit("user-1", "project-1", handler, { provider })).rejects.toMatchObject({
      code: "missing_credentials",
      fatal: true,
    });
    expect(handler.handleScanResult).not.toHaveBeenCalled();
  });
});
