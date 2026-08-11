import { describe, expect, it } from "vitest";

import { evaluateGeminiEligibility } from "@/lib/matching/gemini-eligibility";
import type { MatchedTerm, MatchingEngineResult } from "@/lib/matching/matching-engine";

/** Builds `count` distinct `MatchedTerm`s. The technique never affects scoring - only the count/category does. */
function matchedTerms(count: number): MatchedTerm[] {
  return Array.from({ length: count }, (_, i) => ({
    term: `term-${i}`,
    technique: "Flexible Phrase Matching",
  }));
}

function makeResult(overrides: Partial<MatchingEngineResult> = {}): MatchingEngineResult {
  return {
    keywords: [],
    intentPhrases: [],
    painPhrases: [],
    competitors: [],
    hiddenKeywordVariations: [],
    ...overrides,
  };
}

describe("evaluateGeminiEligibility - Path 1: Intent/Pain direct trigger", () => {
  it("1. intent match with numerical score 0 -> qualifies", () => {
    const result = evaluateGeminiEligibility(makeResult({ intentPhrases: matchedTerms(1) }));

    expect(result.numericalScore).toBe(0);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("intent_or_pain");
  });

  it("2. pain match with numerical score below 25 -> qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ painPhrases: matchedTerms(1), keywords: matchedTerms(1) }),
    );

    expect(result.numericalScore).toBe(10);
    expect(result.numericalScore).toBeLessThan(25);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("intent_or_pain");
  });

  it("3. intent + pain with a low numerical score -> qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ intentPhrases: matchedTerms(1), painPhrases: matchedTerms(1) }),
    );

    expect(result.numericalScore).toBe(0);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("intent_or_pain");
  });

  it("does not let the numerical score reject a candidate that has an intent/pain match", () => {
    // Every numerical category empty, but a pain match is present - the
    // fallback score (0) would fail Path 2, yet this must still qualify.
    const result = evaluateGeminiEligibility(makeResult({ painPhrases: matchedTerms(1) }));

    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("intent_or_pain");
  });
});

describe("evaluateGeminiEligibility - Path 2: numerical keyword scoring fallback", () => {
  it("4. no intent/pain + score 24 -> does not qualify", () => {
    // 2 distinct competitors = 24 points, one non-empty category = +0 diversity.
    const result = evaluateGeminiEligibility(makeResult({ competitors: matchedTerms(2) }));

    expect(result.finalScore).toBe(24);
    expect(result.qualifiesForGemini).toBe(false);
    expect(result.qualificationReason).toBe("below_threshold");
  });

  it("5. no intent/pain + score 25 -> qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ keywords: matchedTerms(1), hiddenKeywordVariations: matchedTerms(1) }),
    );

    expect(result.finalScore).toBe(25);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("6. one keyword -> 10, below threshold", () => {
    const result = evaluateGeminiEligibility(makeResult({ keywords: matchedTerms(1) }));

    expect(result.numericalScore).toBe(10);
    expect(result.diversityBonus).toBe(0);
    expect(result.finalScore).toBe(10);
    expect(result.qualifiesForGemini).toBe(false);
    expect(result.qualificationReason).toBe("below_threshold");
  });

  it("7. one hidden keyword variation -> 10, below threshold", () => {
    const result = evaluateGeminiEligibility(makeResult({ hiddenKeywordVariations: matchedTerms(1) }));

    expect(result.numericalScore).toBe(10);
    expect(result.finalScore).toBe(10);
    expect(result.qualifiesForGemini).toBe(false);
    expect(result.qualificationReason).toBe("below_threshold");
  });

  it("8. one competitor -> 12, below threshold", () => {
    const result = evaluateGeminiEligibility(makeResult({ competitors: matchedTerms(1) }));

    expect(result.numericalScore).toBe(12);
    expect(result.finalScore).toBe(12);
    expect(result.qualifiesForGemini).toBe(false);
    expect(result.qualificationReason).toBe("below_threshold");
  });

  it("9. keyword + hidden variation -> 25, qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ keywords: matchedTerms(1), hiddenKeywordVariations: matchedTerms(1) }),
    );

    expect(result.numericalScore).toBe(20);
    expect(result.diversityCategoryCount).toBe(2);
    expect(result.diversityBonus).toBe(5);
    expect(result.finalScore).toBe(25);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("10. keyword + competitor -> 27, qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ keywords: matchedTerms(1), competitors: matchedTerms(1) }),
    );

    expect(result.numericalScore).toBe(22);
    expect(result.diversityBonus).toBe(5);
    expect(result.finalScore).toBe(27);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("11. hidden variation + competitor -> 27, qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({ hiddenKeywordVariations: matchedTerms(1), competitors: matchedTerms(1) }),
    );

    expect(result.numericalScore).toBe(22);
    expect(result.diversityBonus).toBe(5);
    expect(result.finalScore).toBe(27);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("12. three distinct keywords -> 30, qualifies", () => {
    const result = evaluateGeminiEligibility(makeResult({ keywords: matchedTerms(3) }));

    expect(result.numericalScore).toBe(30);
    expect(result.diversityCategoryCount).toBe(1);
    expect(result.diversityBonus).toBe(0);
    expect(result.finalScore).toBe(30);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("13. all three numerical categories -> 42, qualifies", () => {
    const result = evaluateGeminiEligibility(
      makeResult({
        keywords: matchedTerms(1),
        competitors: matchedTerms(1),
        hiddenKeywordVariations: matchedTerms(1),
      }),
    );

    expect(result.numericalScore).toBe(32);
    expect(result.diversityCategoryCount).toBe(3);
    expect(result.diversityBonus).toBe(10);
    expect(result.finalScore).toBe(42);
    expect(result.qualifiesForGemini).toBe(true);
    expect(result.qualificationReason).toBe("score_threshold");
  });

  it("14. no matches at all -> score 0, below threshold", () => {
    const result = evaluateGeminiEligibility(makeResult());

    expect(result.numericalScore).toBe(0);
    expect(result.diversityCategoryCount).toBe(0);
    expect(result.diversityBonus).toBe(0);
    expect(result.finalScore).toBe(0);
    expect(result.qualifiesForGemini).toBe(false);
    expect(result.qualificationReason).toBe("below_threshold");
  });

  it("15. diversity is based on distinct non-empty categories, not the number of individual matches", () => {
    const fewMatches = evaluateGeminiEligibility(
      makeResult({ keywords: matchedTerms(1), competitors: matchedTerms(1) }),
    );
    const manyMatches = evaluateGeminiEligibility(
      makeResult({ keywords: matchedTerms(5), competitors: matchedTerms(5) }),
    );

    // Same two categories populated in both cases -> same diversity count/bonus,
    // even though the second fixture has far more individual matches.
    expect(fewMatches.diversityCategoryCount).toBe(2);
    expect(manyMatches.diversityCategoryCount).toBe(2);
    expect(fewMatches.diversityBonus).toBe(5);
    expect(manyMatches.diversityBonus).toBe(5);

    // The numerical score DOES scale with match count - only diversity doesn't.
    expect(manyMatches.numericalScore).toBeGreaterThan(fewMatches.numericalScore);
  });
});
