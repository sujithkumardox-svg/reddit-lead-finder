import { PorterStemmer } from "natural";
import * as lemmatizer from "wink-lemmatizer";

import { findMatchingPhrases } from "@/lib/matching/flexible-phrase-matcher";
import { findFuzzyMatches } from "@/lib/matching/fuzzy-matcher";
import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";

/**
 * Stemming and lemmatization matching (Phase 7, Step 4).
 *
 * Compares already-normalized onboarding search terms (see
 * `normalize-text.ts` / `normalize-search-terms.ts` from Step 1) against
 * an already-normalized piece of Reddit text and detects morphological
 * variants of a word - different grammatical forms of the SAME word -
 * using two proven, well-established English NLP techniques:
 *
 *   - Stemming (`natural`'s Porter Stemmer): a fast, rule-based suffix
 *     stripper. "notifications" -> "notif", "running" -> "run".
 *   - Lemmatization (`wink-lemmatizer`, WordNet-backed): returns real
 *     dictionary base forms and correctly handles irregular words a
 *     stemmer can't, e.g. "went" -> "go", "better" -> "good".
 *
 * Running both catches more genuine variants than either alone, while
 * still refusing to invent similarity between unrelated words - both
 * libraries are purely morphological (suffix/dictionary based), never
 * "fuzzy" or approximate, so "video" never becomes a variant of "audio".
 *
 * Scope, per Phase 7 Step 4:
 *   - Only ever reads normalized text/terms - never touches the original
 *     Reddit text or original onboarding term strings, and never mutates
 *     anything.
 *   - Works identically no matter which onboarding category (keywords,
 *     intent phrases, pain phrases, hidden keyword variations) the terms
 *     came from - like `flexible-phrase-matcher.ts` and `fuzzy-matcher.ts`,
 *     this module only ever sees plain strings, never category labels.
 *     Competitors must simply never be passed into `terms` by the caller -
 *     this module has no way to identify a "competitor" term and performs
 *     no filtering by category itself.
 *   - Multi-word phrases are supported by splitting both the term and the
 *     text into individual words and stemming/lemmatizing each one on its
 *     own - never the phrase as a whole.
 *   - Exact matches always win: if `findMatchingPhrases` (Step 2) or
 *     `findFuzzyMatches` (Step 3) already finds a term in the text, this
 *     module skips it entirely rather than re-reporting or overriding it.
 *   - Every term is checked at most once in the result, even when both
 *     stemming AND lemmatization independently detect it.
 *   - No scoring, scanner integration, Gemini, database, competitor
 *     matching, phrase-similarity, or matching-engine wiring happens
 *     here - this is a pure, standalone reader, same as Steps 2 and 3.
 */

/** How a term was found to be a morphological variant of the text. */
export type StemLemmaMatch = {
  originalTerm: string;
  technique: "Stemming" | "Lemmatization";
};

/**
 * Words shorter than this are never stemmed/lemmatized for comparison,
 * only exact-matched. This only excludes single-character tokens (stray
 * punctuation-adjacent fragments are not real words to lemmatize). Unlike
 * `fuzzy-matcher.ts`'s edit-distance tolerance, stemming/lemmatization
 * are deterministic, dictionary/rule-based transforms rather than
 * approximate ones, so short real words are kept eligible - this is what
 * lets common irregular verbs like "went" -> "go" or "is" -> "be" still
 * match correctly.
 */
const MIN_WORD_LENGTH_FOR_TRANSFORM = 2;

/**
 * Reduces a single word to its Porter stem (e.g. "notifications" ->
 * "notif", "running" -> "run"). Pure function - never mutates `word`.
 */
export function stemWord(word: string): string {
  return PorterStemmer.stem(word);
}

/**
 * Reduces a single word to its dictionary base form (lemma) using
 * WordNet-backed morphological rules. `wink-lemmatizer` has no built-in
 * part-of-speech detection, so this tries the noun, then verb, then
 * adjective conjugator in turn and returns the first result that actually
 * changes the word - e.g. "boxes" changes under the noun rules ("box") so
 * that wins; "went" doesn't change as a noun but does as a verb ("go");
 * "better" only changes under the adjective rules ("good"). If none of
 * the three change the word, the word is returned unchanged. Pure
 * function - never mutates `word`.
 */
export function lemmatizeWord(word: string): string {
  const nounForm = lemmatizer.noun(word);
  if (nounForm !== word) return nounForm;

  const verbForm = lemmatizer.verb(word);
  if (verbForm !== word) return verbForm;

  const adjectiveForm = lemmatizer.adjective(word);
  if (adjectiveForm !== word) return adjectiveForm;

  return word;
}

/** Splits normalized text into alphanumeric word tokens. */
function tokenize(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

function isEligibleForTransform(word: string): boolean {
  return word.length >= MIN_WORD_LENGTH_FOR_TRANSFORM;
}

/**
 * Slides a window the size of `termTokens` across `textTokens` looking
 * for a position where every term word lines up with the corresponding
 * text word - each pair either identical outright, or equal once both
 * are run through `transform` (stemming or lemmatization) - with AT LEAST
 * ONE pair actually needing `transform` to line up (otherwise every word
 * would already match exactly, which is `findMatchingPhrases`'s job to
 * report, not this one's).
 */
function phraseMatchesViaTransform(
  termTokens: string[],
  textTokens: string[],
  transform: (word: string) => string,
): boolean {
  const windowSize = termTokens.length;
  if (textTokens.length < windowSize) return false;

  for (let start = 0; start <= textTokens.length - windowSize; start++) {
    let usedTransformInWindow = false;
    let allWordsMatched = true;

    for (let i = 0; i < windowSize; i++) {
      const termWord = termTokens[i];
      const textWord = textTokens[start + i];

      if (termWord === textWord) continue;

      const bothEligible = isEligibleForTransform(termWord) && isEligibleForTransform(textWord);
      if (bothEligible && transform(termWord) === transform(textWord)) {
        usedTransformInWindow = true;
        continue;
      }

      allWordsMatched = false;
      break;
    }

    if (allWordsMatched && usedTransformInWindow) return true;
  }

  return false;
}

/**
 * Finds every onboarding term that appears in `normalizedText` as a
 * morphological variant (via stemming or lemmatization) rather than an
 * exact or fuzzy one, and hasn't already been found by
 * `findMatchingPhrases` (Step 2) or `findFuzzyMatches` (Step 3).
 *
 * - Every term is checked; this does not stop at the first match.
 * - Each term appears at most once in the result, no matter how many
 *   words matched via stemming vs. lemmatization, or how many positions
 *   in the text it matched at. Stemming is checked first; a term already
 *   caught by stemming is never re-checked against lemmatization, which
 *   is what guarantees a term is never reported twice even when both
 *   techniques independently detect it.
 * - Multi-word terms match if EVERY word lines up with a corresponding
 *   word in the text (in order) - each word either exactly, or (for at
 *   least one word) with the same stem/lemma.
 */
export function findStemLemmaMatches(
  terms: NormalizedSearchTerm[],
  normalizedText: string,
): StemLemmaMatch[] {
  if (!normalizedText) return [];

  const textTokens = tokenize(normalizedText);
  if (textTokens.length === 0) return [];

  // Exact/flexible-phrase and fuzzy matches always take priority - never
  // re-report (or override) a term either of those steps already found.
  const alreadyMatched = new Set<string>([
    ...findMatchingPhrases(terms, normalizedText),
    ...findFuzzyMatches(terms, normalizedText).map((match) => match.originalTerm),
  ]);

  const matches: StemLemmaMatch[] = [];
  const seenNormalized = new Set<string>();

  for (const term of terms) {
    if (!term.normalized || seenNormalized.has(term.normalized)) continue;
    if (alreadyMatched.has(term.original)) continue;

    const termTokens = tokenize(term.normalized);
    if (termTokens.length === 0) continue;

    if (phraseMatchesViaTransform(termTokens, textTokens, stemWord)) {
      seenNormalized.add(term.normalized);
      matches.push({ originalTerm: term.original, technique: "Stemming" });
      continue;
    }

    if (phraseMatchesViaTransform(termTokens, textTokens, lemmatizeWord)) {
      seenNormalized.add(term.normalized);
      matches.push({ originalTerm: term.original, technique: "Lemmatization" });
    }
  }

  return matches;
}
