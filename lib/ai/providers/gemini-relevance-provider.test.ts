import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

// `generateText` is the only call to an external service this module
// makes. Mocking it lets every test below simulate Gemini's raw text
// response (or a failure) without making a real network call.
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

// `google(...)` just builds a model descriptor object that gets handed to
// `generateText` - it makes no network call itself, so a trivial stub is
// enough to keep the module importable under test.
vi.mock("@ai-sdk/google", () => ({
  google: vi.fn(() => ({})),
}));

import { generateText } from "ai";

import { RelevanceFilterProviderError } from "@/lib/ai/providers/relevance-filter-provider";
import type { RelevanceFilterInput } from "@/lib/ai/providers/relevance-filter-provider";
import { geminiRelevanceFilterProvider } from "@/lib/ai/providers/gemini-relevance-provider";

const mockedGenerateText = vi.mocked(generateText);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeInput(overrides: Partial<RelevanceFilterInput> = {}): RelevanceFilterInput {
  return {
    candidate: {
      subreddit: "SaaS",
      title: "Looking for a lead-gen tool",
      text: "Looking for a lead-gen tool\n\nAny recommendations for finding leads on Reddit?",
    },
    project: {
      description: "A Reddit lead-generation tool.",
      keywords: ["lead generation"],
      intentPhrases: ["looking for an alternative"],
      painPhrases: ["struggling to find leads"],
      competitors: ["Syften"],
    },
    ...overrides,
  };
}

function mockGeneratedText(text: string): void {
  mockedGenerateText.mockResolvedValueOnce({ text } as never);
}

describe("geminiRelevanceFilterProvider - provenance", () => {
  it("exposes id/model from the LIGHTWEIGHT_AI_PROVIDER/LIGHTWEIGHT_AI_MODEL configuration, defaulting to google/gemini-2.5-flash-lite", () => {
    expect(geminiRelevanceFilterProvider.id).toBe("google");
    expect(geminiRelevanceFilterProvider.model).toBe("gemini-2.5-flash-lite");
  });
});

describe("geminiRelevanceFilterProvider.classifyRelevance - strict output parsing", () => {
  it("1. parses an exact 'LEAD' response as 'lead'", async () => {
    mockGeneratedText("LEAD");

    await expect(geminiRelevanceFilterProvider.classifyRelevance(makeInput())).resolves.toBe("lead");
  });

  it("2. parses an exact 'NOT_A_LEAD' response as 'not_a_lead'", async () => {
    mockGeneratedText("NOT_A_LEAD");

    await expect(geminiRelevanceFilterProvider.classifyRelevance(makeInput())).resolves.toBe(
      "not_a_lead",
    );
  });

  it("3. normalizes harmless surrounding whitespace and casing only", async () => {
    mockGeneratedText("  lead  \n");

    await expect(geminiRelevanceFilterProvider.classifyRelevance(makeInput())).resolves.toBe("lead");
  });

  it("4. treats any other output as an invalid AI response, never as LEAD", async () => {
    mockGeneratedText("Maybe, it depends.");

    await expect(geminiRelevanceFilterProvider.classifyRelevance(makeInput())).rejects.toThrow(
      RelevanceFilterProviderError,
    );
  });

  it("5. treats any other output as an invalid AI response, never as NOT_A_LEAD", async () => {
    mockGeneratedText("NOT A LEAD"); // missing underscores - not the exact required token

    const promise = geminiRelevanceFilterProvider.classifyRelevance(makeInput());
    await expect(promise).rejects.toThrow(RelevanceFilterProviderError);
    // Confirm it's rejected, not silently resolved to either outcome.
    await promise.catch((error: unknown) => {
      expect(error).not.toBe("lead");
      expect(error).not.toBe("not_a_lead");
    });
  });

  it("6. never fabricates a fallback classification for empty/blank output", async () => {
    mockGeneratedText("   ");

    await expect(geminiRelevanceFilterProvider.classifyRelevance(makeInput())).rejects.toThrow(
      RelevanceFilterProviderError,
    );
  });

  it("sends the exact combined candidate text and project context in the prompt", async () => {
    mockGeneratedText("LEAD");

    await geminiRelevanceFilterProvider.classifyRelevance(makeInput());

    const callArgs = mockedGenerateText.mock.calls[0][0] as { prompt: string; system: string };
    expect(callArgs.prompt).toContain("Looking for a lead-gen tool");
    expect(callArgs.prompt).toContain("Any recommendations for finding leads on Reddit?");
    expect(callArgs.prompt).toContain("A Reddit lead-generation tool.");
    expect(callArgs.system).toContain("LEAD");
    expect(callArgs.system).toContain("NOT_A_LEAD");
  });
});

describe("geminiRelevanceFilterProvider.classifyRelevance - error classification", () => {
  it("7. classifies a rate-limit failure as transient", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("429 Too Many Requests: rate limit exceeded"));

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelevanceFilterProviderError);
    expect((error as InstanceType<typeof RelevanceFilterProviderError>).kind).toBe("transient");
  });

  it("8. classifies a timeout failure as transient", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("Request timed out after 30000ms"));

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelevanceFilterProviderError);
    expect((error as InstanceType<typeof RelevanceFilterProviderError>).kind).toBe("transient");
  });

  it("9. classifies a 503 server error as transient", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("503 Service Unavailable"));

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelevanceFilterProviderError);
    expect((error as InstanceType<typeof RelevanceFilterProviderError>).kind).toBe("transient");
  });

  it("10. classifies an authentication/configuration failure as permanent", async () => {
    mockedGenerateText.mockRejectedValueOnce(new Error("401 Unauthorized: invalid API key"));

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelevanceFilterProviderError);
    expect((error as InstanceType<typeof RelevanceFilterProviderError>).kind).toBe("permanent");
  });

  it("11. classifies a malformed/invalid model response as a RelevanceFilterProviderError with a transient (bounded-retry) kind", async () => {
    mockGeneratedText("banana");

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelevanceFilterProviderError);
    expect((error as InstanceType<typeof RelevanceFilterProviderError>).kind).toBe("transient");
  });

  it("preserves the original error as `cause` for diagnosis", async () => {
    const original = new Error("boom");
    mockedGenerateText.mockRejectedValueOnce(original);

    const error = await geminiRelevanceFilterProvider
      .classifyRelevance(makeInput())
      .catch((caught: unknown) => caught);

    expect((error as InstanceType<typeof RelevanceFilterProviderError>).cause).toBe(original);
  });
});
