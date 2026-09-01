import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCall, mockListItems, mockActor, mockDataset } = vi.hoisted(() => ({
  mockCall: vi.fn(),
  mockListItems: vi.fn(),
  mockActor: vi.fn(),
  mockDataset: vi.fn(),
}));

vi.mock("apify-client", () => ({
  ApifyClient: class MockApifyClient {
    actor(id: string) {
      mockActor(id);
      return { call: mockCall };
    }
    dataset(id: string) {
      mockDataset(id);
      return { listItems: mockListItems };
    }
  },
}));

import {
  HarshMaurRedditScraper,
  buildHarshMaurActorInput,
  mapHarshMaurDatasetItem,
} from "@/lib/reddit/providers/harsh-maur-reddit-scraper";
import { RedditProviderError } from "@/lib/reddit/providers/reddit-post-search-provider";

const originalToken = process.env.APIFY_TOKEN;

function makeActorPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataType: "post",
    id: "t3_abc123",
    parsedCommunityName: "SaaS",
    communityName: "r/SaaS",
    title: "Looking for a lead tool",
    body: "Any recommendations?",
    authorName: "some_user",
    authorId: "t2_someuser",
    contentUrl: "https://www.reddit.com/r/SaaS/comments/abc123/looking/",
    postUrl: "https://www.reddit.com/r/SaaS/comments/abc123/looking/",
    score: 12,
    commentsCount: 4,
    createdAt: "2026-08-28T10:00:00.000Z",
    extraActorField: "must-not-leak",
    ...overrides,
  };
}

function listItemsResult(allItems: unknown[], pageSize = 1) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of allItems) {
        yield item;
      }
    },
    then(onFulfilled: (value: { items: unknown[]; total: number }) => unknown) {
      return Promise.resolve({
        items: allItems.slice(0, pageSize),
        total: allItems.length,
      }).then(onFulfilled);
    },
  };
}

beforeEach(() => {
  mockCall.mockReset();
  mockListItems.mockReset();
  mockActor.mockReset();
  mockDataset.mockReset();
  process.env.APIFY_TOKEN = "test-token";
  mockCall.mockResolvedValue({ status: "SUCCEEDED", defaultDatasetId: "dataset-1" });
  mockListItems.mockReturnValue(listItemsResult([]));
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.APIFY_TOKEN;
  } else {
    process.env.APIFY_TOKEN = originalToken;
  }
});

describe("buildHarshMaurActorInput", () => {
  it("passes the full search-term list, one subreddit, and posts-only flags", () => {
    const searchTerms = ["lead generation", "looking for an alternative", "Syften"];

    expect(
      buildHarshMaurActorInput({
        subreddit: "SaaS",
        searchTerms,
        postsPerQuery: 25,
      }),
    ).toEqual({
      searchTerms,
      withinCommunity: "r/SaaS",
      searchPosts: true,
      searchComments: false,
      searchCommunities: false,
      crawlCommentsPerPost: false,
      searchTime: "week",
      searchSort: "new",
      includeNSFW: false,
      aiAnalysis: false,
      maxPostsCount: 75,
    });
  });

  it("does not quote multi-word terms", () => {
    const input = buildHarshMaurActorInput({
      subreddit: "technology",
      searchTerms: ["machine learning", "project management software"],
      postsPerQuery: 25,
    });

    expect(input.searchTerms).toEqual(["machine learning", "project management software"]);
    expect(input.searchTerms.some((term) => term.includes('"'))).toBe(false);
  });
});

describe("mapHarshMaurDatasetItem", () => {
  it("maps a Harsh Maur post onto RedditPostItem and drops unknown Actor fields", () => {
    const mapped = mapHarshMaurDatasetItem(makeActorPost());

    expect(mapped).toEqual({
      id: "t3_abc123",
      type: "post",
      subreddit: "SaaS",
      title: "Looking for a lead tool",
      body: "Any recommendations?",
      author: "some_user",
      authorId: "t2_someuser",
      url: "https://www.reddit.com/r/SaaS/comments/abc123/looking/",
      permalink: "https://www.reddit.com/r/SaaS/comments/abc123/looking/",
      score: 12,
      numComments: 4,
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    expect(mapped).not.toHaveProperty("extraActorField");
    expect(mapped).not.toHaveProperty("dataType");
    expect(mapped).not.toHaveProperty("postUrl");
    expect(mapped).not.toHaveProperty("contentUrl");
  });

  it("ignores comment and community dataset items", () => {
    expect(mapHarshMaurDatasetItem({ dataType: "comment", id: "t1_abc" })).toBeNull();
    expect(mapHarshMaurDatasetItem({ dataType: "community", id: "saas" })).toBeNull();
  });

  it("falls back to communityName without r/ when parsedCommunityName is missing", () => {
    const mapped = mapHarshMaurDatasetItem(
      makeActorPost({ parsedCommunityName: undefined, communityName: "r/startups" }),
    );

    expect(mapped?.subreddit).toBe("startups");
  });

  it("converts Date createdAt values to ISO strings without unix conversion", () => {
    const mapped = mapHarshMaurDatasetItem(
      makeActorPost({ createdAt: new Date("2026-08-28T10:00:00.000Z") }),
    );

    expect(mapped?.createdAt).toBe("2026-08-28T10:00:00.000Z");
  });
});

describe("HarshMaurRedditScraper", () => {
  it("starts one Actor run with the full term list and posts-only input", async () => {
    const searchTerms = ["lead generation", "machine learning"];
    mockListItems.mockReturnValue(listItemsResult([makeActorPost()]));

    const provider = new HarshMaurRedditScraper();
    const posts = await provider.searchPosts({
      subreddit: "SaaS",
      searchTerms,
      postsPerQuery: 25,
    });

    expect(mockActor).toHaveBeenCalledTimes(1);
    expect(mockActor).toHaveBeenCalledWith("harshmaur/reddit-scraper");
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall.mock.calls[0][0]).toEqual(
      buildHarshMaurActorInput({
        subreddit: "SaaS",
        searchTerms,
        postsPerQuery: 25,
      }),
    );
    expect(mockCall.mock.calls[0][0].searchComments).toBe(false);
    expect(mockCall.mock.calls[0][0].crawlCommentsPerPost).toBe(false);
    expect(mockCall.mock.calls[0][0].searchPosts).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("t3_abc123");
  });

  it("drains every listItems page via for-await rather than a single awaited page", async () => {
    const items = [
      makeActorPost({ id: "t3_a" }),
      makeActorPost({ id: "t3_b" }),
      makeActorPost({ id: "t3_c" }),
    ];
    mockListItems.mockReturnValue(listItemsResult(items, 1));

    const provider = new HarshMaurRedditScraper();
    const posts = await provider.searchPosts({
      subreddit: "SaaS",
      searchTerms: ["leads"],
      postsPerQuery: 25,
    });

    expect(mockListItems).toHaveBeenCalledWith({ chunkSize: 1000 });
    expect(posts.map((post) => post.id)).toEqual(["t3_a", "t3_b", "t3_c"]);
  });

  it("throws a fatal missing-credentials error without calling the Actor", async () => {
    delete process.env.APIFY_TOKEN;

    const provider = new HarshMaurRedditScraper();

    await expect(
      provider.searchPosts({
        subreddit: "SaaS",
        searchTerms: ["leads"],
        postsPerQuery: 25,
      }),
    ).rejects.toMatchObject({
      name: "RedditProviderError",
      code: "missing_credentials",
      fatal: true,
    });
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("does not retry a finished FAILED Actor run", async () => {
    mockCall.mockResolvedValue({ status: "FAILED", defaultDatasetId: "dataset-1" });

    const provider = new HarshMaurRedditScraper();

    await expect(
      provider.searchPosts({
        subreddit: "SaaS",
        searchTerms: ["leads"],
        postsPerQuery: 25,
      }),
    ).rejects.toBeInstanceOf(RedditProviderError);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockListItems).not.toHaveBeenCalled();
  });

  it("retries Apify start/network failures then succeeds", async () => {
    mockCall
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: "SUCCEEDED", defaultDatasetId: "dataset-1" });
    mockListItems.mockReturnValue(listItemsResult([makeActorPost()]));

    const provider = new HarshMaurRedditScraper();
    const posts = await provider.searchPosts({
      subreddit: "SaaS",
      searchTerms: ["leads"],
      postsPerQuery: 25,
    });

    expect(mockCall).toHaveBeenCalledTimes(3);
    expect(posts).toHaveLength(1);
  });
});
