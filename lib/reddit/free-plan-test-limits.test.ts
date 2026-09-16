import { afterEach, describe, expect, it } from "vitest";

import {
  applyFreePlanTestLimits,
  FREE_PLAN_TEST_LIMITS,
  isFreePlanTestLimitsEnabled,
} from "@/lib/reddit/free-plan-test-limits";
import type { FreePlanTestLimitSource } from "@/lib/reddit/free-plan-test-limits";

const originalFlag = process.env.USE_FREE_PLAN_TEST_LIMITS;

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.USE_FREE_PLAN_TEST_LIMITS;
  } else {
    process.env.USE_FREE_PLAN_TEST_LIMITS = originalFlag;
  }
});

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

function makeSource(overrides: Partial<FreePlanTestLimitSource> = {}): FreePlanTestLimitSource {
  return {
    keywords: numbered("kw", 20),
    hiddenKeywords: numbered("hidden", 20),
    intentPhrases: numbered("intent", 15),
    painPhrases: numbered("pain", 15),
    competitors: numbered("comp", 8),
    subreddits: numbered("sub", 10),
    ...overrides,
  };
}

describe("applyFreePlanTestLimits", () => {
  it("is a no-op when the flag is unset: same reference, no slicing", () => {
    delete process.env.USE_FREE_PLAN_TEST_LIMITS;
    const source = makeSource();

    expect(isFreePlanTestLimitsEnabled()).toBe(false);

    const result = applyFreePlanTestLimits(source);

    expect(result).toBe(source);
    expect(result.keywords).toHaveLength(20);
    expect(result.intentPhrases).toHaveLength(15);
    expect(result.painPhrases).toHaveLength(15);
    expect(result.competitors).toHaveLength(8);
    expect(result.hiddenKeywords).toHaveLength(20);
    expect(result.subreddits).toHaveLength(10);
  });

  it("is a no-op when the flag is any value other than true", () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "false";
    const source = makeSource();

    expect(isFreePlanTestLimitsEnabled()).toBe(false);
    expect(applyFreePlanTestLimits(source)).toBe(source);
  });

  it("slices each category to the Free-plan test limits when the flag is true", () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "true";
    const source = makeSource();

    expect(isFreePlanTestLimitsEnabled()).toBe(true);

    const result = applyFreePlanTestLimits(source);

    expect(result).not.toBe(source);
    expect(result.keywords).toEqual(numbered("kw", FREE_PLAN_TEST_LIMITS.keywords));
    expect(result.intentPhrases).toEqual(numbered("intent", FREE_PLAN_TEST_LIMITS.intentPhrases));
    expect(result.painPhrases).toEqual(numbered("pain", FREE_PLAN_TEST_LIMITS.painPhrases));
    expect(result.competitors).toEqual(numbered("comp", FREE_PLAN_TEST_LIMITS.competitors));
    expect(result.hiddenKeywords).toEqual(numbered("hidden", FREE_PLAN_TEST_LIMITS.hiddenKeywords));
    expect(result.subreddits).toEqual(numbered("sub", FREE_PLAN_TEST_LIMITS.subreddits));
  });

  it("does not mutate the original arrays when slicing", () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "true";
    const source = makeSource();
    const originalKeywordCount = source.keywords.length;
    const originalSubredditCount = source.subreddits.length;

    applyFreePlanTestLimits(source);

    expect(source.keywords).toHaveLength(originalKeywordCount);
    expect(source.subreddits).toHaveLength(originalSubredditCount);
  });

  it("leaves categories shorter than the cap unchanged", () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "true";
    const source = makeSource({
      keywords: ["only-one"],
      competitors: ["a", "b"],
      subreddits: ["saas"],
    });

    const result = applyFreePlanTestLimits(source);

    expect(result.keywords).toEqual(["only-one"]);
    expect(result.competitors).toEqual(["a", "b"]);
    expect(result.subreddits).toEqual(["saas"]);
  });

  it("preserves extra fields on the source object", () => {
    process.env.USE_FREE_PLAN_TEST_LIMITS = "true";
    const source = { ...makeSource(), id: "project-1", isActive: true };

    const result = applyFreePlanTestLimits(source);

    expect(result.id).toBe("project-1");
    expect(result.isActive).toBe(true);
  });
});
