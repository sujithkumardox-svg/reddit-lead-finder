import { beforeEach, describe, expect, it, vi } from "vitest";

// `qualifyRedditCandidate` is now a thin orchestrator over the
// `QualificationProvider` contract (Phase 9 provider abstraction) - it
// never calls Gemini/AI-SDK code directly. Mocking `getQualificationProvider`
// here keeps these tests focused purely on the orchestrator's own wiring
// (core call -> normalize -> score-first gate -> optional enrichment call ->
// result assembly), not on Gemini's actual prompt/schema logic, which is
// covered by `lib/ai/providers/gemini-qualification-provider.test.ts`.
vi.mock("@/lib/ai/providers/qualification-provider", () => ({
  getQualificationProvider: vi.fn(),
}));

import type {
  CoreQualificationResult,
  EnrichmentResult,
  QualificationProvider,
} from "@/lib/ai/providers/qualification-provider";
import { getQualificationProvider } from "@/lib/ai/providers/qualification-provider";
import {
  normalizeAiQualified,
  qualifyRedditCandidate,
  type QualifyRedditCandidateInput,
} from "@/lib/ai/qualify-reddit-candidate";

const mockedGetQualificationProvider = vi.mocked(getQualificationProvider);

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

function makeCore(overrides: Partial<CoreQualificationResult> = {}): CoreQualificationResult {
  return {
    aiScore: 9,
    aiMatchType: "intent",
    aiQualified: true,
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    aiLeadSummary: "Actively looking for a lead-gen tool.",
    aiMatchReason: "Explicitly asks for recommendations.",
    aiPossibleCompetitor: null,
    aiPossibleCompetitorReason: null,
    ...overrides,
  };
}

/** A fully mocked `QualificationProvider`, plus its two method mocks for direct assertions. */
function makeMockProvider(overrides: Partial<Pick<QualificationProvider, "id" | "model">> = {}): {
  provider: QualificationProvider;
  qualifyCore: ReturnType<typeof vi.fn>;
  generateEnrichment: ReturnType<typeof vi.fn>;
} {
  const qualifyCore = vi.fn();
  const generateEnrichment = vi.fn();
  const provider: QualificationProvider = {
    id: "google",
    model: "gemini-3.5-flash",
    qualifyCore,
    generateEnrichment,
    ...overrides,
  };
  return { provider, qualifyCore, generateEnrichment };
}

describe("normalizeAiQualified", () => {
  it("1. not_relevant -> false, even if the provider said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "not_relevant", aiScore: 9, aiQualified: true }),
    ).toBe(false);
  });

  it("2. general_discussion -> false, even if the provider said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "general_discussion", aiScore: 8, aiQualified: true }),
    ).toBe(false);
  });

  it("3a. intent with aiScore 0-5 -> false, even if the provider said true", () => {
    expect(normalizeAiQualified({ aiMatchType: "intent", aiScore: 5, aiQualified: true })).toBe(
      false,
    );
  });

  it("3b. pain_point with aiScore 0-5 -> false, even if the provider said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "pain_point", aiScore: 0, aiQualified: true }),
    ).toBe(false);
  });

  it("3c. competitor_mention with aiScore 0-5 -> false, even if the provider said true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "competitor_mention", aiScore: 3, aiQualified: true }),
    ).toBe(false);
  });

  it("4a. intent with aiScore 6-10 -> preserves the provider's true", () => {
    expect(normalizeAiQualified({ aiMatchType: "intent", aiScore: 6, aiQualified: true })).toBe(
      true,
    );
  });

  it("4b. pain_point with aiScore 6-10 -> preserves the provider's false", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "pain_point", aiScore: 10, aiQualified: false }),
    ).toBe(false);
  });

  it("4c. competitor_mention with aiScore 6-10 -> preserves the provider's true", () => {
    expect(
      normalizeAiQualified({ aiMatchType: "competitor_mention", aiScore: 7, aiQualified: true }),
    ).toBe(true);
  });
});

describe("qualifyRedditCandidate - score-first gating (score < 6)", () => {
  it("1. score 0 -> enrichment NOT called, enrichment fields null", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(
      makeCore({ aiScore: 0, aiMatchType: "not_relevant", aiQualified: false }),
    );
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(generateEnrichment).not.toHaveBeenCalled();
    expect(result.aiScore).toBe(0);
    expect(result.aiQualified).toBe(false);
    expect(result.aiLeadSummary).toBeNull();
    expect(result.aiMatchReason).toBeNull();
    expect(result.aiPossibleCompetitor).toBeNull();
    expect(result.aiPossibleCompetitorReason).toBeNull();
  });

  it("2. score 5 -> enrichment NOT called, enrichment fields null, aiQualified forced false", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    // The provider's own raw judgment says true, but aiScore 5 is below the
    // qualifying threshold - normalizeAiQualified must still force false,
    // and the score-first gate must still skip enrichment.
    qualifyCore.mockResolvedValueOnce(
      makeCore({ aiScore: 5, aiMatchType: "intent", aiQualified: true }),
    );
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(generateEnrichment).not.toHaveBeenCalled();
    expect(result.aiScore).toBe(5);
    expect(result.aiQualified).toBe(false);
    expect(result.aiLeadSummary).toBeNull();
    expect(result.aiMatchReason).toBeNull();
  });

  it("3. score < 6 result is a fully valid QualifyRedditCandidateResult for the existing worker/persistence contract", async () => {
    const { provider, qualifyCore } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(
      makeCore({ aiScore: 3, aiMatchType: "pain_point", aiQualified: true }),
    );
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(result).toEqual({
      aiQualified: false,
      aiScore: 3,
      aiMatchType: "pain_point",
      aiLeadSummary: null,
      aiMatchReason: null,
      aiPossibleCompetitor: null,
      aiPossibleCompetitorReason: null,
      aiProvider: "google",
      aiModel: "gemini-3.5-flash",
    });
  });

  it("4. exactly one provider call is made for a score < 6 candidate", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(makeCore({ aiScore: 4 }));
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    await qualifyRedditCandidate(makeInput());

    expect(qualifyCore).toHaveBeenCalledTimes(1);
    expect(generateEnrichment).not.toHaveBeenCalled();
  });
});

describe("qualifyRedditCandidate - score-first gating (score >= 6)", () => {
  it.each([6, 7, 8, 10])(
    "1. score %i -> enrichment IS called exactly once, fields populated",
    async (score) => {
      const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
      qualifyCore.mockResolvedValueOnce(
        makeCore({ aiScore: score, aiMatchType: "intent", aiQualified: true }),
      );
      generateEnrichment.mockResolvedValueOnce(makeEnrichment());
      mockedGetQualificationProvider.mockReturnValueOnce(provider);

      const result = await qualifyRedditCandidate(makeInput());

      expect(generateEnrichment).toHaveBeenCalledTimes(1);
      expect(result.aiScore).toBe(score);
      expect(result.aiQualified).toBe(true);
      expect(result.aiLeadSummary).toBe("Actively looking for a lead-gen tool.");
      expect(result.aiMatchReason).toBe("Explicitly asks for recommendations.");
    },
  );

  it("2. enrichment receives the already-determined core result (score/match type) as an argument, not just the raw input", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    const core = makeCore({ aiScore: 8, aiMatchType: "competitor_mention", aiQualified: true });
    qualifyCore.mockResolvedValueOnce(core);
    generateEnrichment.mockResolvedValueOnce(makeEnrichment());
    mockedGetQualificationProvider.mockReturnValueOnce(provider);
    const input = makeInput();

    await qualifyRedditCandidate(input);

    expect(generateEnrichment).toHaveBeenCalledWith(input, core);
  });

  it("3. preserves the existing aiPossibleCompetitor/aiPossibleCompetitorReason pass-through", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(
      makeCore({ aiScore: 8, aiMatchType: "competitor_mention", aiQualified: true }),
    );
    generateEnrichment.mockResolvedValueOnce(
      makeEnrichment({
        aiPossibleCompetitor: "Syften",
        aiPossibleCompetitorReason: "The author says they currently pay for Syften.",
      }),
    );
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(result.aiPossibleCompetitor).toBe("Syften");
    expect(result.aiPossibleCompetitorReason).toBe(
      "The author says they currently pay for Syften.",
    );
  });
});

describe("qualifyRedditCandidate - provider abstraction", () => {
  it("1. obtains the provider via getQualificationProvider and delegates to qualifyCore/generateEnrichment, never calling Gemini/AI-SDK code directly", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(makeCore());
    generateEnrichment.mockResolvedValueOnce(makeEnrichment());
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    await qualifyRedditCandidate(makeInput());

    expect(mockedGetQualificationProvider).toHaveBeenCalledTimes(1);
    expect(qualifyCore).toHaveBeenCalledTimes(1);
    expect(generateEnrichment).toHaveBeenCalledTimes(1);
  });

  it("2. reads aiProvider/aiModel provenance from the provider instance rather than hardcoding it", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider({
      id: "future-provider",
      model: "future-model-v1",
    });
    qualifyCore.mockResolvedValueOnce(makeCore({ aiScore: 7 }));
    generateEnrichment.mockResolvedValueOnce(makeEnrichment());
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(result.aiProvider).toBe("future-provider");
    expect(result.aiModel).toBe("future-model-v1");
  });

  it("3. reads aiProvider/aiModel provenance from the provider instance on the score < 6 path too", async () => {
    const { provider, qualifyCore } = makeMockProvider({
      id: "future-provider",
      model: "future-model-v1",
    });
    qualifyCore.mockResolvedValueOnce(makeCore({ aiScore: 2, aiMatchType: "not_relevant" }));
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    const result = await qualifyRedditCandidate(makeInput());

    expect(result.aiProvider).toBe("future-provider");
    expect(result.aiModel).toBe("future-model-v1");
  });
});

describe("qualifyRedditCandidate - error propagation", () => {
  it("propagates a core qualification failure to the caller instead of swallowing it", async () => {
    const { provider, qualifyCore } = makeMockProvider();
    const apiError = new Error("Gemini API request failed");
    qualifyCore.mockRejectedValueOnce(apiError);
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    await expect(qualifyRedditCandidate(makeInput())).rejects.toThrow(apiError);
  });

  it("propagates an enrichment failure to the caller instead of swallowing it", async () => {
    const { provider, qualifyCore, generateEnrichment } = makeMockProvider();
    qualifyCore.mockResolvedValueOnce(makeCore({ aiScore: 9 }));
    const apiError = new Error("Gemini API request failed");
    generateEnrichment.mockRejectedValueOnce(apiError);
    mockedGetQualificationProvider.mockReturnValueOnce(provider);

    await expect(qualifyRedditCandidate(makeInput())).rejects.toThrow(apiError);
  });
});
