import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";

/**
 * Rule-based phrase similarity matching (Phase 7, Step 6).
 *
 * Compares already-normalized onboarding search terms (see
 * `normalize-text.ts` / `normalize-search-terms.ts` from Step 1) against
 * an already-normalized piece of Reddit text and detects phrases whose
 * MEANINGFUL words appear in the text in the exact same order, tolerating
 * a small number of common FILLER words wedged between them - e.g. the
 * term "notification settings" matches "notification for the settings
 * page" (filler words "for"/"the" sit between the two meaningful words)
 * but not "notification about email settings" ("about"/"email" are real
 * content words, not filler, so they break the match).
 *
 * This is a lightweight, fully deterministic, rule-based technique - NO
 * AI, embeddings, or semantic similarity of any kind:
 *   - Filler words are a small, fixed, hardcoded closed-class list (see
 *     `FILLER_WORDS`) - articles, prepositions, and a handful of other
 *     common connector words. Nothing is "guessed" or scored.
 *   - Word order is never changed. Matching only ever scans the text
 *     left-to-right, matching the term's meaningful words one at a time
 *     in the order they appear in the term - a later meaningful word can
 *     never be found at an earlier text position than an earlier one.
 *   - Filler words already present IN the term are stripped out before
 *     matching, exactly like filler words are tolerated in the text -
 *     both sides treat them as noise, not as required content.
 *   - Only a bounded number of filler words may appear between two
 *     consecutive meaningful words (see `MAX_FILLER_WORDS_BETWEEN`); any
 *     other word - filler or not - in that gap once the budget is spent,
 *     or any single non-filler word that isn't the next meaningful word,
 *     immediately breaks the match at that position.
 *
 * This module is completely standalone and reusable:
 *   - It has no dependency on, and is never called by, any other Phase 7
 *     matching module (`flexible-phrase-matcher.ts`, `fuzzy-matcher.ts`,
 *     `stem-lemma-matcher.ts`, `exact-competitor-matcher.ts`) - it only
 *     imports the shared `NormalizedSearchTerm` type from Step 1.
 *   - It works identically no matter which onboarding category the terms
 *     came from - like the other matchers, it only ever sees plain
 *     strings, never category labels.
 *   - It performs no "already matched" exclusion of its own; combining
 *     its results with any other technique's results is left entirely to
 *     whatever future scoring/matching-engine logic calls this function -
 *     out of scope for this step.
 *
 * This function is a pure reader - it never mutates its inputs, never
 * touches the database or Gemini, computes no score, and performs no
 * scanner or matching-engine integration.
 */

/** A single rule-based phrase similarity match. Always carries the original term text and how it was found. */
export type PhraseSimilarityMatch = {
  originalTerm: string;
  technique: "Rule-Based Phrase Similarity";
};

/**
 * Small, fixed set of common English filler words - articles,
 * prepositions, and a few other frequent connector words - that are
 * ignored on both sides of a comparison: stripped out of the term before
 * matching, and allowed (in bounded numbers) to sit between the term's
 * meaningful words in the text without breaking a match.
 */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "is",
  "are",
  "my",
  "your",
  "our",
  "and",
  "or",
  "in",
  "on",
  "at",
]);

/**
 * Maximum number of consecutive filler words tolerated in the gap between
 * two consecutive meaningful term words. Kept small and bounded so this
 * stays a strict "same order, minor filler noise" matcher rather than a
 * loose "these words both appear somewhere" one - a large run of filler
 * words in a row is unusual in real text and a sign the two occurrences
 * aren't actually the same phrase.
 */
const MAX_FILLER_WORDS_BETWEEN = 3;

/** Splits normalized text into alphanumeric word tokens. */
function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Removes filler words from a tokenized term, leaving only its meaningful words, in order. */
function meaningfulWords(tokens: string[]): string[] {
  return tokens.filter((token) => !FILLER_WORDS.has(token));
}

/**
 * Scans `textTokens` forward from `fromIndex` (inclusive) looking for
 * `targetWord`. Any filler word encountered along the way is skipped, up
 * to `MAX_FILLER_WORDS_BETWEEN` of them; the first non-filler word that
 * isn't `targetWord` stops the scan immediately (no match). Returns the
 * index of `targetWord` if found within budget, otherwise `null`.
 */
function findNextMeaningfulWord(
  textTokens: string[],
  fromIndex: number,
  targetWord: string,
): number | null {
  let fillerCount = 0;

  for (let i = fromIndex; i < textTokens.length; i++) {
    const token = textTokens[i];
    if (token === targetWord) return i;

    if (!FILLER_WORDS.has(token)) return null;

    fillerCount++;
    if (fillerCount > MAX_FILLER_WORDS_BETWEEN) return null;
  }

  return null;
}

/**
 * Checks whether `termWords` (already filler-stripped, in order) appears
 * in `textTokens` in the same order, allowing only bounded runs of filler
 * words between consecutive matched words. Tries every possible starting
 * position for the first meaningful word, since the same word can appear
 * multiple times in the text.
 */
function phraseSimilarityMatches(termWords: string[], textTokens: string[]): boolean {
  if (termWords.length === 0) return false;

  const [firstWord, ...restWords] = termWords;

  for (let start = 0; start < textTokens.length; start++) {
    if (textTokens[start] !== firstWord) continue;

    let currentIndex = start;
    let allWordsMatched = true;

    for (const nextWord of restWords) {
      const foundIndex = findNextMeaningfulWord(textTokens, currentIndex + 1, nextWord);
      if (foundIndex === null) {
        allWordsMatched = false;
        break;
      }
      currentIndex = foundIndex;
    }

    if (allWordsMatched) return true;
  }

  return false;
}

/**
 * Finds every onboarding term whose meaningful words appear in
 * `normalizedText`, in the same order, with only a small number of
 * common filler words tolerated between them.
 *
 * - Every term is checked; this does not stop at the first match.
 * - Each term appears at most once in the result, however many positions
 *   or filler-word variants of it were found in the text.
 * - Terms that are entirely filler words (nothing meaningful left after
 *   stripping) never match anything - there's nothing to compare.
 */
export function findPhraseSimilarityMatches(
  terms: NormalizedSearchTerm[],
  normalizedText: string,
): PhraseSimilarityMatch[] {
  if (!normalizedText) return [];

  const textTokens = tokenize(normalizedText);
  if (textTokens.length === 0) return [];

  const matches: PhraseSimilarityMatch[] = [];
  const seenNormalized = new Set<string>();

  for (const term of terms) {
    if (!term.normalized || seenNormalized.has(term.normalized)) continue;

    const termWords = meaningfulWords(tokenize(term.normalized));
    if (termWords.length === 0) continue;

    if (phraseSimilarityMatches(termWords, textTokens)) {
      seenNormalized.add(term.normalized);
      matches.push({ originalTerm: term.original, technique: "Rule-Based Phrase Similarity" });
    }
  }

  return matches;
}
