import { beforeEach, describe, expect, it, vi } from "vitest";

// `generateObject` is the only call to an external service this module
// makes. Mocking it lets the error-propagation tests below simulate a
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

import type { CoreQualificationResult } from "@/lib/ai/providers/qualification-provider";
import { geminiQualificationProvider } from "@/lib/ai/providers/gemini-qualification-provider";
import type { QualifyRedditCandidateInput } from "@/lib/ai/qualify-reddit-candidate";

const mockedGenerateObject = vi.mocked(generateObject);

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("geminiQualificationProvider - provenance", () => {
  it("exposes id/model matching the current, unchanged Gemini configuration", () => {
    expect(geminiQualificationProvider.id).toBe("google");
    expect(geminiQualificationProvider.model).toBe("gemini-3.5-flash");
  });
});

describe("geminiQualificationProvider.qualifyCore", () => {
  it("1. returns the core aiScore/aiMatchType/aiQualified fields from Gemini's structured output", async () => {
    const object = { aiScore: 8, aiMatchType: "competitor_mention" as const, aiQualified: true };
    mockedGenerateObject.mockResolvedValueOnce({ object } as never);

    const result = await geminiQualificationProvider.qualifyCore(makeInput());

    expect(result).toEqual(object);
  });

  it("2. never mentions enrichment fields in its schema/system prompt (score-first: core call cannot produce enrichment)", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { aiScore: 5, aiMatchType: "not_relevant", aiQualified: false },
    } as never);

    await geminiQualificationProvider.qualifyCore(makeInput());

    const callArgs = mockedGenerateObject.mock.calls[0][0] as { system: string };
    expect(callArgs.system).not.toContain("aiLeadSummary");
    expect(callArgs.system).not.toContain("aiMatchReason");
    expect(callArgs.system).not.toContain("aiPossibleCompetitor");
  });

  it("propagates a Gemini/API failure to the caller instead of swallowing it", async () => {
    const apiError = new Error("Gemini API request failed");
    mockedGenerateObject.mockRejectedValueOnce(apiError);

    await expect(geminiQualificationProvider.qualifyCore(makeInput())).rejects.toThrow(apiError);
  });

  it("propagates a structured-output validation failure to the caller instead of swallowing it", async () => {
    // `generateObject` itself throws (typically a `NoObjectGeneratedError`
    // wrapping a Zod validation failure) when Gemini's response doesn't
    // match the core schema - simulated here directly since this test only
    // needs to prove the failure isn't swallowed, not exercise the AI SDK's
    // own validation internals.
    const validationError = new Error("Response did not match schema");
    mockedGenerateObject.mockRejectedValueOnce(validationError);

    await expect(geminiQualificationProvider.qualifyCore(makeInput())).rejects.toThrow(
      validationError,
    );
  });
});

describe("geminiQualificationProvider.generateEnrichment", () => {
  const core: CoreQualificationResult = {
    aiScore: 8,
    aiMatchType: "competitor_mention",
    aiQualified: true,
  };

  it("1. passes through aiPossibleCompetitorReason from Gemini's structured output", async () => {
    const object = {
      aiLeadSummary: "Currently using a competitor and open to switching.",
      aiMatchReason: "Explicitly compares this project to a named competitor.",
      aiPossibleCompetitor: "Syften",
      aiPossibleCompetitorReason:
        "The author says they currently pay for Syften and dislike its pricing.",
    };
    mockedGenerateObject.mockResolvedValueOnce({ object } as never);

    const result = await geminiQualificationProvider.generateEnrichment(makeInput(), core);

    expect(result).toEqual(object);
  });

  it("2. leaves aiPossibleCompetitorReason null when there is no possible competitor", async () => {
    const object = {
      aiLeadSummary: "Actively looking for a lead-gen tool.",
      aiMatchReason: "Explicitly asks for recommendations.",
      aiPossibleCompetitor: null,
      aiPossibleCompetitorReason: null,
    };
    mockedGenerateObject.mockResolvedValueOnce({ object } as never);

    const result = await geminiQualificationProvider.generateEnrichment(makeInput(), core);

    expect(result.aiPossibleCompetitor).toBeNull();
    expect(result.aiPossibleCompetitorReason).toBeNull();
  });

  it("3. the prompt sent to Gemini states the already-determined aiScore/aiMatchType as an established fact, not a new decision", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        aiLeadSummary: "x",
        aiMatchReason: "y",
        aiPossibleCompetitor: null,
        aiPossibleCompetitorReason: null,
      },
    } as never);

    await geminiQualificationProvider.generateEnrichment(makeInput(), core);

    const callArgs = mockedGenerateObject.mock.calls[0][0] as { prompt: string; system: string };
    expect(callArgs.prompt).toContain("aiMatchType: competitor_mention");
    expect(callArgs.prompt).toContain("aiScore: 8");
    expect(callArgs.prompt).toContain("do not re-decide");
    expect(callArgs.prompt).toContain("do not propose a different score");
    // The enrichment system prompt must not re-explain scoring/classification
    // rules - it only explains/enriches the already-made decision.
    expect(callArgs.system).not.toContain("SCORING: aiScore");
  });

  it("4. the system prompt explicitly forbids returning aiScore/aiMatchType from the enrichment call", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        aiLeadSummary: "x",
        aiMatchReason: "y",
        aiPossibleCompetitor: null,
        aiPossibleCompetitorReason: null,
      },
    } as never);

    await geminiQualificationProvider.generateEnrichment(makeInput(), core);

    const callArgs = mockedGenerateObject.mock.calls[0][0] as { system: string };
    expect(callArgs.system).toContain("do not include aiScore or aiMatchType");
  });

  it("propagates a Gemini/API failure to the caller instead of swallowing it", async () => {
    const apiError = new Error("Gemini API request failed");
    mockedGenerateObject.mockRejectedValueOnce(apiError);

    await expect(
      geminiQualificationProvider.generateEnrichment(makeInput(), core),
    ).rejects.toThrow(apiError);
  });

  it("propagates a structured-output validation failure to the caller instead of swallowing it", async () => {
    const validationError = new Error("Response did not match schema");
    mockedGenerateObject.mockRejectedValueOnce(validationError);

    await expect(
      geminiQualificationProvider.generateEnrichment(makeInput(), core),
    ).rejects.toThrow(validationError);
  });
});
