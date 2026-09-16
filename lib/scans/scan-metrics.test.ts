import { describe, expect, it } from "vitest";

import {
  createScanMetrics,
  hasAnyMatchCategory,
  recordGeminiScoreBucket,
} from "@/lib/scans/scan-metrics";

describe("createScanMetrics", () => {
  it("initializes a zeroed accumulator with project and sync log ids", () => {
    const metrics = createScanMetrics("project-1", "sync-1");

    expect(metrics.projectId).toBe("project-1");
    expect(metrics.syncLogId).toBe("sync-1");
    expect(metrics.rawPosts).toBe(0);
    expect(metrics.subreddits).toEqual([]);
    expect(metrics.durationsMs.total).toBe(0);
  });
});

describe("hasAnyMatchCategory", () => {
  it("is a matchingCandidate only when at least one category matched", () => {
    expect(
      hasAnyMatchCategory({
        keywords: [],
        intentPhrases: [],
        painPhrases: [],
        competitors: [],
        hiddenKeywordVariations: [],
      }),
    ).toBe(false);

    expect(
      hasAnyMatchCategory({
        keywords: [{ term: "lead generation", technique: "Flexible Phrase Matching" }],
        intentPhrases: [],
        painPhrases: [],
        competitors: [],
        hiddenKeywordVariations: [],
      }),
    ).toBe(true);
  });
});

describe("recordGeminiScoreBucket", () => {
  it("buckets existing aiScore values without changing them", () => {
    const metrics = createScanMetrics("project-1", "sync-1");

    recordGeminiScoreBucket(metrics, 10);
    recordGeminiScoreBucket(metrics, 8);
    recordGeminiScoreBucket(metrics, 7);
    recordGeminiScoreBucket(metrics, 6);
    recordGeminiScoreBucket(metrics, 5);
    recordGeminiScoreBucket(metrics, 0);

    expect(metrics.strong8to10).toBe(2);
    expect(metrics.partial6to7).toBe(2);
    expect(metrics.notQualified0to5).toBe(2);
  });
});
