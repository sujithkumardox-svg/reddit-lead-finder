import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";

/**
 * Exact competitor matching (Phase 7, Step 5).
 *
 * Compares already-normalized competitor names (see `normalize-text.ts`
 * and `normalize-search-terms.ts` from Step 1) against an
 * already-normalized piece of Reddit text and reports which competitors
 * appear in the text as an exact, whole-word/whole-phrase match - the
 * literal normalized name, nothing else.
 *
 * This is deliberately narrower than every other Phase 7 matching
 * technique:
 *   - Unlike `flexible-phrase-matcher.ts` (Step 2), punctuation BETWEEN a
 *     multi-word competitor's words is NOT treated as flexible - "google
 *     analytics" matches "Google Analytics" (case/whitespace differences
 *     only, handled by normalization) but not "google-analytics" or
 *     "google.analytics". A competitor's exact name - including any
 *     punctuation that's genuinely part of it, e.g. "Notifier.so" - is
 *     what must be found, not a loosely-punctuated variant of it.
 *   - Unlike `fuzzy-matcher.ts` (Step 3), there is no typo tolerance -
 *     "brand24" never matches "brnad24".
 *   - Unlike `stem-lemma-matcher.ts` (Step 4), there is no stemming or
 *     lemmatization - this module has no concept of morphological
 *     variants at all.
 *
 * What IS still guaranteed, exactly like Steps 2-4:
 *   - Whole-word/whole-phrase safety: "apollo" matches "Apollo" and
 *     "using apollo daily" but never matches inside "apollos" or
 *     "myapolloapp" - a match can never be a substring of a larger word.
 *   - Both single-word ("apollo") and multi-word ("google analytics")
 *     competitor names are supported the same way.
 *
 * Competitors are entirely independent of every other onboarding
 * category and every other matching technique:
 *   - This module never calls, and is never called by,
 *     `flexible-phrase-matcher.ts`, `fuzzy-matcher.ts`, or
 *     `stem-lemma-matcher.ts` - it has no "already matched" exclusion
 *     logic, because none of those other techniques are ever run against
 *     competitor terms (Step 4 explicitly skips competitors, and this
 *     step is the one dedicated matcher for them).
 *   - This independence is what lets e.g. the intent phrase "alternative
 *     to syften" (matched elsewhere, over the intent-phrase list) and
 *     the competitor "Syften" (matched here, over the competitor list)
 *     both match against the same Reddit text at the same time - neither
 *     one's match suppresses or depends on the other.
 *
 * This function is a pure reader - like Steps 2-4, it never mutates its
 * inputs, never touches the database or Gemini, computes no score, and
 * performs no scanner or matching-engine integration.
 */

/** A single exact competitor match. Always carries the original competitor name and how it was found. */
export type CompetitorMatch = {
  originalTerm: string;
  technique: "Exact Competitor Matching";
};

/**
 * Builds a regex that matches `normalizedTerm` literally (including the
 * single spaces between its words, exactly as normalized), with boundary
 * assertions so it can never match as part of a larger word/number - e.g.
 * "apollo" must not match inside "apollos" or "myapolloapp". Any
 * punctuation that's genuinely part of the competitor's name (".", "-",
 * etc.) is matched literally, never treated as a flexible separator.
 *
 * Returns `null` for an empty term - there is nothing to search for.
 */
function buildExactPhraseRegex(normalizedTerm: string): RegExp | null {
  if (!normalizedTerm) return null;

  const escaped = escapeRegExp(normalizedTerm);
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks `normalizedText` for every competitor in `competitors` and
 * returns the ORIGINAL (un-normalized) name of each one that matched
 * exactly, so callers can display/store the competitor name exactly as
 * the user/AI onboarding wrote it.
 *
 * - Never mutates `competitors` or `normalizedText` - both are only read.
 * - Does not stop at the first match; every competitor is checked.
 * - Each matched competitor appears at most once in the result, no
 *   matter how many times or where it occurs in the text.
 * - Performs no fuzzy matching, stemming, lemmatization, punctuation
 *   flexibility, or scoring - see the module doc comment above.
 */
export function findExactCompetitorMatches(
  competitors: NormalizedSearchTerm[],
  normalizedText: string,
): CompetitorMatch[] {
  if (!normalizedText) return [];

  const matches: CompetitorMatch[] = [];
  const seenNormalized = new Set<string>();

  for (const competitor of competitors) {
    if (!competitor.normalized || seenNormalized.has(competitor.normalized)) continue;

    const regex = buildExactPhraseRegex(competitor.normalized);
    if (regex && regex.test(normalizedText)) {
      seenNormalized.add(competitor.normalized);
      matches.push({ originalTerm: competitor.original, technique: "Exact Competitor Matching" });
    }
  }

  return matches;
}
