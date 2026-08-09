import { describe, expect, it, vi } from "vitest";

import type { OnboardingSearchTerms } from "@/lib/matching/matching-engine";
import { combineRedditPostText, matchRedditScanResult } from "@/lib/matching/reddit-scan-matcher";
import type { RedditCommentItem, RedditPostItem, RedditScanResult } from "@/types/reddit-scan";

function makePost(overrides: Partial<RedditPostItem> = {}): RedditPostItem {
  return {
    id: "t3_post1",
    type: "post",
    subreddit: "SaaS",
    title: "Looking for a Reddit lead tool",
    body: "Does anyone know a good alternative to Syften?",
    author: "some_user",
    url: "https://reddit.com/r/SaaS/post1",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 2,
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
    body: "I've been struggling to find qualified leads too.",
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

const emptyTerms: OnboardingSearchTerms = {
  keywords: [],
  intentPhrases: [],
  painPhrases: [],
  competitors: [],
  hiddenKeywordVariations: [],
};

describe("combineRedditPostText", () => {
  it("combines title and body into one string", () => {
    const post = makePost({ title: "Title here", body: "Body here" });
    expect(combineRedditPostText(post)).toBe("Title here\n\nBody here");
  });

  it("falls back to just the title when the post has no body (link posts)", () => {
    const post = makePost({ title: "Just a link", body: "" });
    expect(combineRedditPostText(post)).toBe("Just a link");
  });
});

describe("matchRedditScanResult", () => {
  it("matches each post's title+body as ONE combined string, and each comment's body on its own", () => {
    const post = makePost({ title: "Title here", body: "Body here" });
    const comment = makeComment({ body: "Comment body here" });
    const result = makeScanResult({ posts: [post], comments: [comment] });

    const matchText = vi.fn().mockReturnValue({
      keywords: [],
      intentPhrases: [],
      painPhrases: [],
      competitors: [],
      hiddenKeywordVariations: [],
    });

    matchRedditScanResult(result, emptyTerms, matchText);

    // Exactly one call per post, exactly one call per comment - never
    // combined together, never split apart.
    expect(matchText).toHaveBeenCalledTimes(2);
    expect(matchText).toHaveBeenNthCalledWith(1, "Title here\n\nBody here", emptyTerms);
    expect(matchText).toHaveBeenNthCalledWith(2, "Comment body here", emptyTerms);
  });

  it("never lets a comment's text include its parent post's title or body", () => {
    const post = makePost({ title: "Parent post title", body: "Parent post body" });
    const comment = makeComment({ body: "Just the comment" });
    const result = makeScanResult({ posts: [post], comments: [comment] });

    const matched = matchRedditScanResult(result, emptyTerms, () => ({
      keywords: [],
      intentPhrases: [],
      painPhrases: [],
      competitors: [],
      hiddenKeywordVariations: [],
    }));

    expect(matched.comments[0].text).toBe("Just the comment");
    expect(matched.comments[0].text).not.toContain("Parent post");
  });

  it("collects a Matching Engine result for every scanned post and every scanned comment", () => {
    const posts = [makePost({ id: "t3_a" }), makePost({ id: "t3_b" })];
    const comments = [
      makeComment({ id: "t1_a" }),
      makeComment({ id: "t1_b" }),
      makeComment({ id: "t1_c" }),
    ];
    const result = makeScanResult({ posts, comments });

    const matched = matchRedditScanResult(result, emptyTerms, () => ({
      keywords: [],
      intentPhrases: [],
      painPhrases: [],
      competitors: [],
      hiddenKeywordVariations: [],
    }));

    expect(matched.posts).toHaveLength(2);
    expect(matched.comments).toHaveLength(3);
    expect(matched.posts.map((p) => p.post.id)).toEqual(["t3_a", "t3_b"]);
    expect(matched.comments.map((c) => c.comment.id)).toEqual(["t1_a", "t1_b", "t1_c"]);
  });

  it("passes all five onboarding term categories through to the matcher untouched, and uses the real Matching Engine by default", () => {
    const terms: OnboardingSearchTerms = {
      keywords: ["lead generation"],
      intentPhrases: ["looking for an alternative"],
      painPhrases: ["struggling to find leads"],
      competitors: ["Syften"],
      hiddenKeywordVariations: ["reddit lead finder"],
    };

    const post = makePost({
      title: "Looking for an alternative to Syften",
      body: "We are struggling to find leads via reddit lead finder tools.",
    });
    const comment = makeComment({ body: "Lead generation is hard without the right tool." });
    const result = makeScanResult({ posts: [post], comments: [comment] });

    // No `matchText` override here - this exercises the REAL, existing
    // `runMatchingEngine` end-to-end, confirming the connection actually
    // works and every category is wired through correctly.
    const matched = matchRedditScanResult(result, terms);

    expect(matched.posts[0].result.intentPhrases.map((m) => m.term)).toContain(
      "looking for an alternative",
    );
    expect(matched.posts[0].result.painPhrases.map((m) => m.term)).toContain(
      "struggling to find leads",
    );
    expect(matched.posts[0].result.competitors.map((m) => m.term)).toContain("Syften");
    expect(matched.posts[0].result.hiddenKeywordVariations.map((m) => m.term)).toContain(
      "reddit lead finder",
    );
    expect(matched.comments[0].result.keywords.map((m) => m.term)).toContain("lead generation");
  });
});
