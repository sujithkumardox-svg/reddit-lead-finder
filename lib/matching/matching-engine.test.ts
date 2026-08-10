import { describe, expect, it } from "vitest";

import { runMatchingEngine } from "@/lib/matching/matching-engine";
import type { OnboardingSearchTerms } from "@/lib/matching/matching-engine";

describe("runMatchingEngine - duplicate match guarantee", () => {
  it("reports a term only once per category even when it occurs multiple times in the text", () => {
    const terms: OnboardingSearchTerms = {
      keywords: ["lead generation"],
      intentPhrases: [],
      painPhrases: [],
      competitors: ["Syften"],
      hiddenKeywordVariations: [],
    };

    // "lead generation" (a general-category term, matched via
    // `matchGeneralCategory`) and "Syften" (a competitor, matched via
    // `matchCompetitors`) each occur 3x - repeated in-text occurrences
    // must not multiply the reported matches for either code path.
    const text =
      "Lead generation is hard. We tried Syften, but Syften didn't help " +
      "our lead generation. Syften is fine, but lead generation is what we need.";

    const result = runMatchingEngine(text, terms);

    expect(result.keywords).toHaveLength(1);
    expect(result.keywords[0].term).toBe("lead generation");

    expect(result.competitors).toHaveLength(1);
    expect(result.competitors[0].term).toBe("Syften");
  });
});
