import { normalizeText } from "@/lib/matching/normalize-text";
import { normalizeSearchTerms } from "@/lib/matching/normalize-search-terms";
import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";
import { findMatchingPhrases } from "@/lib/matching/flexible-phrase-matcher";
import { findFuzzyMatches } from "@/lib/matching/fuzzy-matcher";
import { findStemLemmaMatches } from "@/lib/matching/stem-lemma-matcher";
import { findPhraseSimilarityMatches } from "@/lib/matching/phrase-similarity-matcher";
import { findExactCompetitorMatches } from "@/lib/matching/exact-competitor-matcher";

/**
 * Matching engine integration (Phase 7, Step 7).
 *
 * The single place that wires together every matching module built in
 * Steps 1-6 - text normalization, flexible phrase matching, fuzzy
 * matching, stemming/lemmatization, exact competitor matching, and
 * rule-based phrase similarity - into one pass over one piece of Reddit
 * text against one project's full set of onboarding terms.
 *
 * This module does not modify or re-implement anything it calls; it only
 * imports and orchestrates the existing, already-tested functions from:
 *   - `normalize-text.ts` / `normalize-search-terms.ts` (Step 1)
 *   - `flexible-phrase-matcher.ts` (Step 2)
 *   - `fuzzy-matcher.ts` (Step 3)
 *   - `stem-lemma-matcher.ts` (Step 4)
 *   - `exact-competitor-matcher.ts` (Step 5)
 *   - `phrase-similarity-matcher.ts` (Step 6)
 *
 * Text normalization happens exactly ONCE per call, via `normalizeText`
 * (Step 1) - the same normalized copy of the Reddit text is then reused
 * across every category and every technique, rather than re-normalizing
 * per category.
 *
 * Categories are always processed in this locked order: Keywords, Intent
 * Phrases, Pain Phrases, Competitors, Hidden Keyword Variations. Category
 * results never influence one another - each category is matched
 * completely independently against the same normalized text, which is
 * what allows e.g. the intent phrase "alternative to syften" and the
 * competitor "Syften" to both be returned even though they overlap in
 * the text: one is found while processing Intent Phrases, the other
 * while processing Competitors, and neither run knows the other exists.
 *
 * Matching priority within Keywords, Intent Phrases, Pain Phrases, and
 * Hidden Keyword Variations (highest priority first):
 *   1. Flexible Phrase Matching
 *   2. Fuzzy Matching
 *   3. Stemming / Lemmatization
 *   4. Rule-Based Phrase Similarity
 * All four techniques are always run - this engine never stops at the
 * first match - and their results are accumulated together. Flexible,
 * Fuzzy, and Stemming/Lemmatization already refuse to re-report a term a
 * higher-priority technique in this list found (that exclusion lives
 * inside those modules themselves, from Steps 2-4). Rule-Based Phrase
 * Similarity (Step 6) is intentionally standalone and has no such
 * exclusion built in, so THIS engine is what de-duplicates its results
 * against the other three for a given category - a term already found by
 * a higher-priority technique is dropped from Phrase Similarity's
 * results rather than being reported a second time.
 *
 * Competitors use ONLY Exact Competitor Matching - no other technique
 * (flexible, fuzzy, stemming/lemmatization, or phrase similarity) is ever
 * run against competitor terms.
 *
 * Every term is returned at most once within its own category, no matter
 * how many techniques detected it or how many times it occurred in the
 * text.
 *
 * This function is a pure reader: `redditText` and every term in
 * `terms` are only ever read, never mutated - the same original strings
 * the caller passed in remain exactly as they were after this function
 * returns. No scoring, scanner integration, Gemini, or database access
 * happens here - this module only produces a clean, structured result
 * for a future scoring/scanner layer to consume.
 */

/** Every matching technique the engine can attribute a match to. */
export type MatchTechnique =
  | "Flexible Phrase Matching"
  | "Fuzzy Matching"
  | "Stemming"
  | "Lemmatization"
  | "Rule-Based Phrase Similarity"
  | "Exact Competitor Matching";

/** One onboarding term that matched, plus the technique that found it. */
export type MatchedTerm = {
  term: string;
  technique: MatchTechnique;
};

/**
 * A project's full set of onboarding search terms, grouped by category.
 * Every value is the ORIGINAL (un-normalized) term text exactly as
 * stored on the project - this engine normalizes copies internally and
 * never touches these arrays/strings.
 */
export type OnboardingSearchTerms = {
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
  hiddenKeywordVariations: string[];
};

/**
 * The matching engine's output: every matched term for each onboarding
 * category, keyed the same way as `OnboardingSearchTerms` so callers can
 * line results back up with the category they came from.
 */
export type MatchingEngineResult = {
  keywords: MatchedTerm[];
  intentPhrases: MatchedTerm[];
  painPhrases: MatchedTerm[];
  competitors: MatchedTerm[];
  hiddenKeywordVariations: MatchedTerm[];
};

/** A match produced by one of the underlying single-technique matchers, before de-duplication. */
type RawMatch = { originalTerm: string; technique: MatchTechnique };

/**
 * Appends `rawMatches` to `matches`, skipping any whose `originalTerm`
 * has already been recorded in `seenOriginals` - this is what guarantees
 * a term is only ever returned once per category, regardless of how many
 * of the four techniques detect it.
 */
function accumulate(matches: MatchedTerm[], seenOriginals: Set<string>, rawMatches: RawMatch[]): void {
  for (const { originalTerm, technique } of rawMatches) {
    if (seenOriginals.has(originalTerm)) continue;
    seenOriginals.add(originalTerm);
    matches.push({ term: originalTerm, technique });
  }
}

/**
 * Matches one category's terms (keywords, intent phrases, pain phrases,
 * or hidden keyword variations) against `normalizedText` using all four
 * general-purpose techniques, in priority order, accumulating every
 * match and de-duplicating by original term text across techniques.
 */
function matchGeneralCategory(terms: NormalizedSearchTerm[], normalizedText: string): MatchedTerm[] {
  const matches: MatchedTerm[] = [];
  const seenOriginals = new Set<string>();

  // 1. Flexible Phrase Matching - returns bare original-term strings, so
  // label them with their technique before accumulating.
  accumulate(
    matches,
    seenOriginals,
    findMatchingPhrases(terms, normalizedText).map(
      (originalTerm): RawMatch => ({ originalTerm, technique: "Flexible Phrase Matching" }),
    ),
  );

  // 2. Fuzzy Matching - already skips anything Flexible Phrase Matching found.
  accumulate(matches, seenOriginals, findFuzzyMatches(terms, normalizedText));

  // 3. Stemming / Lemmatization - already skips anything Flexible or Fuzzy found.
  accumulate(matches, seenOriginals, findStemLemmaMatches(terms, normalizedText));

  // 4. Rule-Based Phrase Similarity - standalone by design (Step 6), so
  // `accumulate`'s `seenOriginals` check is what stops it from
  // re-reporting a term any of the previous three already found.
  accumulate(matches, seenOriginals, findPhraseSimilarityMatches(terms, normalizedText));

  return matches;
}

/**
 * Matches competitor terms against `normalizedText` using ONLY Exact
 * Competitor Matching (Step 5) - no other technique ever runs against
 * competitors. `findExactCompetitorMatches` already guarantees each
 * competitor is returned at most once, so no further de-duplication is
 * needed here.
 */
function matchCompetitors(terms: NormalizedSearchTerm[], normalizedText: string): MatchedTerm[] {
  return findExactCompetitorMatches(terms, normalizedText).map(
    (match): MatchedTerm => ({ term: match.originalTerm, technique: match.technique }),
  );
}

/**
 * Runs the full matching engine for one piece of Reddit text against one
 * project's onboarding terms.
 *
 * - Normalizes `redditText` exactly once (via `normalizeText`, Step 1)
 *   and reuses that single normalized copy for every category.
 * - Processes categories in the locked order: Keywords, Intent Phrases,
 *   Pain Phrases, Competitors, Hidden Keyword Variations.
 * - Never mutates `redditText` or any term in `terms` - both are only
 *   ever read.
 */
export function runMatchingEngine(redditText: string, terms: OnboardingSearchTerms): MatchingEngineResult {
  const normalizedText = normalizeText(redditText);

  const keywords = matchGeneralCategory(normalizeSearchTerms(terms.keywords), normalizedText);
  const intentPhrases = matchGeneralCategory(normalizeSearchTerms(terms.intentPhrases), normalizedText);
  const painPhrases = matchGeneralCategory(normalizeSearchTerms(terms.painPhrases), normalizedText);
  const competitors = matchCompetitors(normalizeSearchTerms(terms.competitors), normalizedText);
  const hiddenKeywordVariations = matchGeneralCategory(
    normalizeSearchTerms(terms.hiddenKeywordVariations),
    normalizedText,
  );

  return { keywords, intentPhrases, painPhrases, competitors, hiddenKeywordVariations };
}
