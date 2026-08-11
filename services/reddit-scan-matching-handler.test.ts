import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

// `services/projects.ts` talks to Supabase (via `server-only` + Next's
// request-scoped `cookies()`), which doesn't exist in a plain unit test.
// Mocking it here keeps this test focused on the adapter/handler logic -
// it never exercises real Supabase access.
vi.mock("@/services/projects", () => ({
  getProjectScanData: vi.fn(),
}));

// `services/gemini-qualification-queue.ts` talks to Supabase (via
// `server-only`), which doesn't exist in a plain unit test. Mocking it here
// keeps these tests focused on the handler's wiring - whether it calls
// `enqueueCandidate` for qualifying candidates and skips non-qualifying
// ones - without exercising real Supabase access.
vi.mock("@/services/gemini-qualification-queue", () => ({
  enqueueCandidate: vi.fn(),
}));

import { getProjectScanData } from "@/services/projects";
import type { ProjectScanData } from "@/services/projects";
import { enqueueCandidate } from "@/services/gemini-qualification-queue";
import {
  RedditScanMatchingHandler,
  mapProjectScanDataToOnboardingTerms,
} from "@/services/reddit-scan-matching-handler";
import type { RedditCommentItem } from "@/types/reddit-scan";

const mockedGetProjectScanData = vi.mocked(getProjectScanData);
const mockedEnqueueCandidate = vi.mocked(enqueueCandidate);

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

function makeComment(overrides: Partial<RedditCommentItem> = {}): RedditCommentItem {
  return {
    id: "t1_comment1",
    type: "comment",
    subreddit: "SaaS",
    postId: "t3_post1",
    body: "Just a neutral comment with no matches at all.",
    author: "another_user",
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
  mockedEnqueueCandidate.mockReset();
  mockedEnqueueCandidate.mockResolvedValue(null);
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

  it("enqueues a Gemini-eligible post (intent/pain match) into the database queue immediately after matching", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost(); // title/body trigger an intent + pain + competitor match
    await handler.handleScanResult(makeScanResult({ posts: [post], comments: [] }));

    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        userId: "user-1",
        redditItemId: "t3_post1",
        itemType: "post",
        parentPostId: null,
        title: "Looking for an alternative to Syften",
        body: "We are struggling to find leads.",
        qualificationReason: "intent_or_pain",
      }),
    );
  });

  it("enqueues a Gemini-eligible comment into the database queue with its parent post id", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const comment = makeComment({ body: "Struggling to find leads for my SaaS." });
    await handler.handleScanResult(makeScanResult({ posts: [], comments: [comment] }));

    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        redditItemId: "t1_comment1",
        itemType: "comment",
        parentPostId: "t3_post1",
        title: null,
        body: "Struggling to find leads for my SaaS.",
        qualificationReason: "intent_or_pain",
      }),
    );
  });

  it("does not enqueue a post/comment that does not qualify for Gemini", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost({ title: "Just chatting", body: "Nothing relevant here." });
    const comment = makeComment({ body: "Nothing relevant here either." });
    await handler.handleScanResult(makeScanResult({ posts: [post], comments: [comment] }));

    expect(mockedEnqueueCandidate).not.toHaveBeenCalled();
  });
});

describe("RedditScanMatchingHandler - Gemini queue insertion error handling", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("1. still safely ignores a duplicate candidate (enqueueCandidate resolving null) without throwing or logging an error", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    mockedEnqueueCandidate.mockResolvedValue(null); // mirrors the real 23505 duplicate outcome

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    await expect(
      handler.handleScanResult(makeScanResult({ posts: [post], comments: [] })),
    ).resolves.toBeUndefined();

    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("2. logs a genuine DB insertion error for a candidate", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    const dbError = new Error("connection refused");
    mockedEnqueueCandidate.mockRejectedValueOnce(dbError);

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    await handler.handleScanResult(makeScanResult({ posts: [post], comments: [] }));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("t3_post1"),
      dbError,
    );
  });

  it("3. still processes later candidates after an earlier one fails to enqueue", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    mockedEnqueueCandidate
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(null);

    const handler = new RedditScanMatchingHandler("user-1");
    const failingPost = makePost({ id: "t3_fails" });
    const survivingComment = makeComment({ id: "t1_survives", body: "Struggling to find leads for my SaaS." });
    await handler.handleScanResult(
      makeScanResult({ posts: [failingPost], comments: [survivingComment] }),
    );

    expect(mockedEnqueueCandidate).toHaveBeenCalledTimes(2);
    expect(mockedEnqueueCandidate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ redditItemId: "t3_fails" }),
    );
    expect(mockedEnqueueCandidate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ redditItemId: "t1_survives" }),
    );
  });

  it("4. does not fail the scan/handler because one queue insertion errored", async () => {
    mockedGetProjectScanData.mockResolvedValue(makeScanData());
    mockedEnqueueCandidate.mockRejectedValueOnce(new Error("connection refused"));

    const handler = new RedditScanMatchingHandler("user-1");
    const post = makePost();
    const scanResult = makeScanResult({ posts: [post], comments: [] });

    await expect(handler.handleScanResult(scanResult)).resolves.toBeUndefined();

    // Matching results collected earlier in the same call are unaffected -
    // the queue failure isn't retried and doesn't corrupt/discard them.
    expect(handler.getMatchingResult()).not.toBeNull();
    expect(handler.getMatchingResult()!.posts).toHaveLength(1);
  });
});
