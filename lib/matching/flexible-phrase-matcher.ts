import type { NormalizedSearchTerm } from "@/lib/matching/normalize-search-terms";

/**
 * Flexible phrase matching (Phase 7, Step 2).
 *
 * Compares already-normalized onboarding search terms against an
 * already-normalized piece of Reddit text (see `normalize-text.ts`,
 * `normalize-search-terms.ts`, `normalize-reddit-content.ts` from Step 1)
 * and reports which onboarding terms appear in the text as the same words,
 * in the same order, tolerant only of punctuation/spacing differences
 * between those words:
 *
 *   "pdf to video" matches "pdf-to-video", "pdf.to.video",
 *   "pdf / to / video", "pdf   to    video", "pdf: to video"
 *
 * This is intentionally NOT fuzzy matching, spelling-tolerant matching, or
 * stemming - "brand24" does not match "brand42", and different words never
 * match each other. Every word in the term must appear, unchanged and in
 * order; only the characters BETWEEN words are flexible. This function is
 * a pure reader - it never mutates its inputs and never scores anything.
 */

/**
 * Builds a regex that matches `normalizedTerm`'s words in order, treating
 * any run of non-alphanumeric characters between words (spaces, hyphens,
 * dots, slashes, colons, or any combination of them) as equivalent to a
 * single space. Boundary assertions stop the phrase from matching as part
 * of a larger word/number (e.g. "brand24" must not match inside
 * "brand247" or "superbrand24").
 *
 * Returns `null` for an empty term - there is nothing to search for.
 */
function buildPhraseRegex(normalizedTerm: string): RegExp | null {
  const words = normalizedTerm.split(" ").filter(Boolean);
  if (words.length === 0) return null;

  const wordPattern = words.map(escapeRegExp).join("[^a-z0-9]+");

  return new RegExp(`(?<![a-z0-9])${wordPattern}(?![a-z0-9])`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks `normalizedText` for every term in `terms` and returns the
 * ORIGINAL (un-normalized) text of each term that matched, so callers can
 * display/store the term exactly as the user/AI onboarding wrote it.
 *
 * - Never mutates `terms` or `normalizedText` - both are only read.
 * - Does not stop at the first match; every term is checked.
 * - Each matched term appears at most once in the result, no matter how
 *   many times or via how many punctuation variants it matched.
 * - Performs no scoring, fuzzy matching, or stemming.
 */
export function findMatchingPhrases(
  terms: NormalizedSearchTerm[],
  normalizedText: string,
): string[] {
  if (!normalizedText) return [];

  const matchedOriginals: string[] = [];
  const seenNormalized = new Set<string>();

  for (const term of terms) {
    if (!term.normalized || seenNormalized.has(term.normalized)) continue;

    const regex = buildPhraseRegex(term.normalized);
    if (regex && regex.test(normalizedText)) {
      seenNormalized.add(term.normalized);
      matchedOriginals.push(term.original);
    }
  }

  return matchedOriginals;
}
