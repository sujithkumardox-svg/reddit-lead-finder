import { describe, expect, it, vi } from "vitest";

// `generateObject` is the only call to an external service this module
// makes. Mocking it lets the error-propagation test below simulate a
// Gemini/API failure without making a real network call.
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// `google(...)` just builds a model descriptor object that gets handed to
// `generateObject` - it makes no network call itself, so a trivial stub is
// enough to keep the module importable under test.
vi.mock("@ai-sdk/google", () => ({
  google: vi.fn(() => ({})),
}));

import { generateObject } from "ai";

import {
  normalizeAiQualified,
  qualifyRedditCandidate,
  type QualifyRedditCandidateInput,
} from "@/lib/ai/qualify-reddit-candidate";

const mockedGenerateObject = vi.mocked(generateObject);

function makeInput(): QualifyRedditCandidateInput {
  return {
    candidate: {
      itemType: "post",
      subreddit: "SaaS",
      title: "Looking for a lead-gen tool",
      matchedText: "Looking for a lead-gen tool\n\nAny recommendations?",
      permalink: "https://reddit.com/r/SaaS/comments/abc123",
      redditScore: 12,
      itemCreatedAt: "2026-08-01T00:00:00.000Z",
    },
    project: {
      description: "A Reddit lead-generation tool.",
      keywords: ["lead generation"],
      intentPhrases: ["looking for an alternative"],
      painPhrases: ["struggling to find leads"],
      competitors: ["Syften"],
    },
  };
}

describe("normalizeAiQualified", () => {
  it("1. not_relevant -> false, even if Gemini said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "not_relevant", aiScore: 9, aiQualified: true }),
    ).toBe(false);
  });

  it("2. general_discussion -> false, even if Gemini said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "general_discussion", aiScore: 8, aiQualified: true }),
    ).toBe(false);
  });

  it("3a. intent with aiScore 0-5 -> false, even if Gemini said true", () => {
    expect(normalizeAiQualified({ aiMatchType: "intent", aiScore: 5, aiQualified: true })).toBe(
      false,
    );
  });

  it("3b. pain_point with aiScore 0-5 -> false, even if Gemini said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "pain_point", aiScore: 0, aiQualified: true }),
    ).toBe(false);
  });

  it("3c. competitor_mention with aiScore 0-5 -> false, even if Gemini said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "competitor_mention", aiScore: 3, aiQualified: true }),
    ).toBe(false);
  });

  it("4a. intent with aiScore 6-10 -> preserves Gemini's true", () => {
    expect(normalizeAiQualified({ aiMatchType: "intent", aiScore: 6, aiQualified: true })).toBe(
      true,
    );
  });

  it("4b. pain_point with aiScore 6-10 -> preserves Gemini's false", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "pain_point", aiScore: 10, aiQualified: false }),
    ).toBe(false);
  });

  it("4c. competitor_mention with aiScore 6-10 -> preserves Gemini's true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "competitor_mention", aiScore: 7, aiQualified: true }),
    ).toBe(true);
  });
});

describe("qualifyRedditCandidate - error propagation", () => {
  it("propagates a Gemini/API failure to the caller instead of swallowing it", async () => {
    const apiError = new Error("Gemini API request failed");
    mockedGenerateObject.mockRejectedValueOnce(apiError);

    await expect(qualifyRedditCandidate(makeInput())).rejects.toThrow(apiError);
  });

  it("propagates a structured-output validation failure to the caller instead of swallowing it", async () => {
    // `generateObject` itself throws (typically a `NoObjectGeneratedError`
    // wrapping a Zod validation failure) when Gemini's response doesn't
    // match `qualifyRedditCandidateSchema` - simulated here directly since
    // this test only needs to prove the failure isn't swallowed, not
    // exercise the AI SDK's own validation internals.
    const validationError = new Error("Response did not match schema");
    mockedGenerateObject.mockRejectedValueOnce(validationError);

    await expect(qualifyRedditCandidate(makeInput())).rejects.toThrow(validationError);
  });
});
