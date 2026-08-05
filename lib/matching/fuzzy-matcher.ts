import { findMatchingPhrases } from "@/lib/matching/flexible-phrase-matcher";
import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";

/**
 * Fuzzy matching (Phase 7, Step 3).
 *
 * Compares already-normalized onboarding search terms (see
 * `normalize-text.ts` / `normalize-search-terms.ts` from Step 1) against
 * an already-normalized piece of Reddit text and detects genuine human
 * spelling mistakes - single-character insertions, deletions,
 * substitutions, and adjacent-character transpositions - using the
 * Damerau-Levenshtein distance.
 *
 * This is deliberately narrower than "any two similar-looking words":
 *   - "brand24" must NOT match "brand42" (digits are never fuzzy-tolerant).
 *   - "video" must NOT match "audio" (too many edits for a real typo).
 *   - Very short words are never fuzzy-matched (too easy to collide with a
 *     genuinely different short word).
 *   - Exact matches always win: if `findMatchingPhrases` (Step 2) already
 *     finds a term in the text, this module skips it entirely rather than
 *     re-reporting it as a fuzzy match.
 *
 * This function is a pure reader - it never mutates `terms` or
 * `normalizedText`, never touches the database or Gemini, and never
 * computes a score. It works identically no matter which onboarding
 * category (keywords, intent phrases, pain phrases, competitors, hidden
 * keyword variations) the terms came from - it only ever sees plain
 * strings, never category labels.
 */

/**
 * Maximum Damerau-Levenshtein distance (per word) that counts as a typo.
 * Kept at 1 - every "should match" example in the spec (moniter,
 * analyticcs, notifcation, qualificaiton, reddiit, leadfnder) is exactly 1
 * edit away from its correct spelling, while every "must not match"
 * example (moneytor, video/audio, reddit/twitter) is 2+ edits away. A
 * larger threshold would start accepting genuinely different words, not
 * just typos - this is the conservative end of what still catches real
 * mistakes.
 */
const FUZZY_DISTANCE_THRESHOLD = 1;

/**
 * Words shorter than this are never fuzzy-matched, only exact-matched.
 * A 1-edit difference on a 2-3 letter word ("to" -> "go", "at" -> "as")
 * usually produces a completely different, still-valid word - too risky
 * to treat as a typo.
 */
const MIN_WORD_LENGTH_FOR_FUZZY = 4;

/** A single fuzzy match result. Always carries the original term text and how it was found. */
export type FuzzyMatch = {
  originalTerm: string;
  technique: "Fuzzy Matching";
};

/**
 * Finds every onboarding term that appears in `normalizedText` as a
 * near-match (within `FUZZY_DISTANCE_THRESHOLD` edits per word) rather
 * than an exact one, and hasn't already been found by exact/flexible
 * phrase matching.
 *
 * - Every term is checked; this does not stop at the first match.
 * - Each term appears at most once in the result, however many
 *   punctuation/typo variants of it were found.
 * - Multi-word terms match if EVERY word lines up with a corresponding
 *   word in the text (in order) - each word either exactly or, for at
 *   least one word, within the fuzzy threshold. A phrase where all words
 *   matched exactly is left for Step 2 to report, not this function.
 */
export function findFuzzyMatches(
  terms: NormalizedSearchTerm[],
  normalizedText: string,
): FuzzyMatch[] {
  if (!normalizedText) return [];

  const textTokens = tokenize(normalizedText);
  if (textTokens.length === 0) return [];

  // Exact matches always take priority - never re-report (or override) a
  // term that Step 2 already found via exact/flexible phrase matching.
  const alreadyExactlyMatched = new Set(findMatchingPhrases(terms, normalizedText));

  const fuzzyMatches: FuzzyMatch[] = [];
  const seenNormalized = new Set<string>();

  for (const term of terms) {
    if (!term.normalized || seenNormalized.has(term.normalized)) continue;
    if (alreadyExactlyMatched.has(term.original)) continue;

    const termTokens = tokenize(term.normalized);
    if (termTokens.length === 0) continue;

    if (phraseHasFuzzyMatch(termTokens, textTokens)) {
      seenNormalized.add(term.normalized);
      fuzzyMatches.push({ originalTerm: term.original, technique: "Fuzzy Matching" });
    }
  }

  return fuzzyMatches;
}

/** Splits normalized text into alphanumeric word tokens (the unit typos happen at). */
function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Slides a window the size of `termTokens` across `textTokens` looking for
 * a position where every term word lines up with the corresponding text
 * word - each pair either identical or within the fuzzy threshold - with
 * AT LEAST ONE pair actually needing the fuzzy tolerance (otherwise the
 * whole phrase would already be an exact match, which this function isn't
 * responsible for reporting).
 */
function phraseHasFuzzyMatch(termTokens: string[], textTokens: string[]): boolean {
  const windowSize = termTokens.length;
  if (textTokens.length < windowSize) return false;

  for (let start = 0; start <= textTokens.length - windowSize; start++) {
    let usedFuzzyInWindow = false;
    let allWordsMatched = true;

    for (let i = 0; i < windowSize; i++) {
      const comparison = compareWords(termTokens[i], textTokens[start + i]);

      if (!comparison.matched) {
        allWordsMatched = false;
        break;
      }
      if (comparison.usedFuzzy) usedFuzzyInWindow = true;
    }

    if (allWordsMatched && usedFuzzyInWindow) return true;
  }

  return false;
}

type WordComparison = { matched: boolean; usedFuzzy: boolean };

/** Compares one term word against one text word: exact first, fuzzy fallback. */
function compareWords(termWord: string, textWord: string): WordComparison {
  if (termWord === textWord) {
    return { matched: true, usedFuzzy: false };
  }

  if (!isFuzzyEligible(termWord) || !isFuzzyEligible(textWord)) {
    return { matched: false, usedFuzzy: false };
  }

  // Cheap length-based bail-out before running the DP table: two words
  // whose lengths differ by more than the allowed distance can never be
  // within that distance of each other.
  if (Math.abs(termWord.length - textWord.length) > FUZZY_DISTANCE_THRESHOLD) {
    return { matched: false, usedFuzzy: false };
  }

  const distance = damerauLevenshteinDistance(termWord, textWord, FUZZY_DISTANCE_THRESHOLD);
  return { matched: distance <= FUZZY_DISTANCE_THRESHOLD, usedFuzzy: distance <= FUZZY_DISTANCE_THRESHOLD };
}

/**
 * A word is only ever eligible for fuzzy tolerance if it's long enough
 * (see `MIN_WORD_LENGTH_FOR_FUZZY`) AND contains no digits. Digits are
 * excluded deliberately: "brand24" vs "brand42" is a single adjacent
 * transposition (distance 1 under Damerau-Levenshtein) but the two are
 * different brand identifiers, not a spelling mistake - numbers almost
 * always denote a distinct identifier/version rather than a typo-prone
 * word, so we require an exact match whenever either word contains one.
 */
function isFuzzyEligible(word: string): boolean {
  return word.length >= MIN_WORD_LENGTH_FOR_FUZZY && !/[0-9]/.test(word);
}

/**
 * Damerau-Levenshtein distance (restricted edit distance / "OSA" variant)
 * between two strings: the minimum number of insertions, deletions,
 * substitutions, and ADJACENT TRANSPOSITIONS needed to turn `a` into `b`.
 *
 * Standard dynamic-programming table `d`, where `d[i][j]` is the edit
 * distance between `a[0..i)` and `b[0..j)`:
 *
 *   - Base cases: turning an empty string into a length-j string (or vice
 *     versa) costs exactly j (or i) insertions/deletions:
 *       d[i][0] = i,  d[0][j] = j
 *
 *   - If the current characters match, no new edit is needed - carry the
 *     diagonal value forward:
 *       d[i][j] = d[i-1][j-1]                       when a[i-1] === b[j-1]
 *
 *   - Otherwise, take the cheapest of the three classic Levenshtein moves:
 *       d[i][j] = 1 + min(
 *         d[i-1][j],    // delete a[i-1]
 *         d[i][j-1],    // insert b[j-1]
 *         d[i-1][j-1],  // substitute a[i-1] -> b[j-1]
 *       )
 *
 *   - Damerau's extension: if the last two characters are the same pair
 *     just swapped (a[i-2..i) === reverse of b[j-2..j)), a single
 *     transposition can also reach this cell for the cost of 1 on top of
 *     the distance two positions back:
 *       d[i][j] = min(d[i][j], d[i-2][j-2] + 1)
 *     This is what lets "qualificaiton" (a swapped "t"/"i") match
 *     "qualification" at distance 1 instead of 2.
 *
 * `maxDistance` is a cheap early-exit: if the two strings' lengths already
 * differ by more than the caller's threshold, the true distance is
 * guaranteed to exceed it too, so the full O(n*m) table is skipped.
 */
export function damerauLevenshteinDistance(a: string, b: string, maxDistance: number): number {
  const lenA = a.length;
  const lenB = b.length;

  if (Math.abs(lenA - lenB) > maxDistance) {
    return maxDistance + 1;
  }

  const d: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0));

  for (let i = 0; i <= lenA; i++) d[i][0] = i;
  for (let j = 0; j <= lenB; j++) d[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;

      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + substitutionCost, // substitution (or free match)
      );

      const isAdjacentTransposition =
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];

      if (isAdjacentTransposition) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[lenA][lenB];
}
