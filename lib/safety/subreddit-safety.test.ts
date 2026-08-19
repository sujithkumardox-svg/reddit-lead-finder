import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/reddit/reddit-rules.ts` calls Reddit's OAuth API (via
// `lib/reddit/reddit-api-client.ts`), which doesn't run in a plain unit
// test. Mocking it here keeps these tests focused on the classifier/cache
// logic itself, without a real network call.
vi.mock("@/lib/reddit/reddit-rules", () => ({
  fetchSubredditRules: vi.fn(),
}));

import { fetchSubredditRules } from "@/lib/reddit/reddit-rules";
import type { RawSubredditRule } from "@/lib/reddit/reddit-rules";
import { classifySubredditSafety, getSubredditSafety } from "@/lib/safety/subreddit-safety";
import type { SubredditSafetyResult } from "@/types/reddit-leads";

const mockedFetchSubredditRules = vi.mocked(fetchSubredditRules);

function makeRule(overrides: Partial<RawSubredditRule> = {}): RawSubredditRule {
  return {
    short_name: "Be nice",
    description: "Be respectful to other users.",
    ...overrides,
  };
}

beforeEach(() => {
  mockedFetchSubredditRules.mockReset();
});

describe("classifySubredditSafety", () => {
  it("1. returns without_rules when the subreddit has no rules at all", () => {
    expect(classifySubredditSafety([])).toEqual({
      badge: "without_rules",
      explanation: "This subreddit has no posted rules.",
    });
  });

  it("2. returns without_rules when no rule mentions promotion at all", () => {
    const result = classifySubredditSafety([
      makeRule({ short_name: "Be nice" }),
      makeRule({ short_name: "No spoilers", description: "Use spoiler tags." }),
    ]);

    expect(result.badge).toBe("without_rules");
  });

  it("3. returns promo_not_safe when a rule explicitly bans self-promotion", () => {
    const result = classifySubredditSafety([
      makeRule({
        short_name: "No self-promotion",
        description: "Self-promotion is not allowed and will result in a ban.",
      }),
    ]);

    expect(result.badge).toBe("promo_not_safe");
    expect(result.explanation).toContain("No self-promotion");
  });

  it("4. returns promo_conditional when a rule allows promotion under conditions", () => {
    const result = classifySubredditSafety([
      makeRule({
        short_name: "Self-promotion rules",
        description: "Self-promotion is allowed with mod approval and following the 9:1 ratio.",
      }),
    ]);

    expect(result.badge).toBe("promo_conditional");
    expect(result.explanation).toContain("Self-promotion rules");
  });

  it("5. defaults to promo_conditional (not promo_not_safe) when promotion is mentioned but the wording is ambiguous", () => {
    const result = classifySubredditSafety([
      makeRule({ short_name: "Advertising", description: "See our advertising policy on the wiki." }),
    ]);

    expect(result.badge).toBe("promo_conditional");
  });

  it("6. prioritizes an outright ban over a conditional rule when both are present", () => {
    const result = classifySubredditSafety([
      makeRule({
        short_name: "Flair-only promo",
        description: "Promotion allowed with the Promo flair.",
      }),
      makeRule({
        short_name: "No advertising",
        description: "Advertising is not allowed anywhere in this subreddit.",
      }),
    ]);

    expect(result.badge).toBe("promo_not_safe");
  });

  it("7. is case-insensitive when matching rule text", () => {
    const result = classifySubredditSafety([
      makeRule({ short_name: "NO SELF-PROMOTION", description: "SELF-PROMOTION IS NOT ALLOWED." }),
    ]);

    expect(result.badge).toBe("promo_not_safe");
  });
});

describe("getSubredditSafety", () => {
  it("8. fetches and classifies a subreddit not yet in the cache", async () => {
    mockedFetchSubredditRules.mockResolvedValueOnce([
      makeRule({ short_name: "No self-promotion", description: "Self-promotion is not allowed." }),
    ]);
    const cache = new Map<string, SubredditSafetyResult>();

    const result = await getSubredditSafety("SaaS", cache);

    expect(mockedFetchSubredditRules).toHaveBeenCalledWith("SaaS");
    expect(result.badge).toBe("promo_not_safe");
    expect(cache.get("SaaS")).toEqual(result);
  });

  it("9. reuses a cached result and never calls fetchSubredditRules again for the same subreddit", async () => {
    const cache = new Map<string, SubredditSafetyResult>([
      ["SaaS", { badge: "without_rules", explanation: "This subreddit has no posted rules." }],
    ]);

    const result = await getSubredditSafety("SaaS", cache);

    expect(mockedFetchSubredditRules).not.toHaveBeenCalled();
    expect(result).toEqual({ badge: "without_rules", explanation: "This subreddit has no posted rules." });
  });

  it("10. fetches once per distinct subreddit but not again for a repeated one within the same cache", async () => {
    mockedFetchSubredditRules
      .mockResolvedValueOnce([makeRule({ short_name: "No promotion", description: "No promotion allowed." })])
      .mockResolvedValueOnce([]);
    const cache = new Map<string, SubredditSafetyResult>();

    await getSubredditSafety("SaaS", cache);
    await getSubredditSafety("startups", cache);
    await getSubredditSafety("SaaS", cache);

    expect(mockedFetchSubredditRules).toHaveBeenCalledTimes(2);
    expect(mockedFetchSubredditRules).toHaveBeenNthCalledWith(1, "SaaS");
    expect(mockedFetchSubredditRules).toHaveBeenNthCalledWith(2, "startups");
  });
});
