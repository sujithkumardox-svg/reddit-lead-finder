import { normalizeText } from "@/lib/matching/normalize-text";

/**
 * An onboarding search term (keyword, intent phrase, pain phrase,
 * competitor, or hidden keyword variation) paired with a TEMPORARY,
 * in-memory normalized copy for matching. `original` is exactly what's
 * stored on the project - the UI must always display `original`, never
 * `normalized`.
 */
export type NormalizedSearchTerm = {
  original: string;
  normalized: string;
};

/**
 * Builds normalized copies of a list of onboarding search terms without
 * touching the source array/strings. Works the same regardless of which
 * onboarding category the terms come from (keywords, intent phrases, pain
 * phrases, competitors, hidden keyword variations) - callers pass whichever
 * list(s) they need normalized.
 */
export function normalizeSearchTerms(terms: string[]): NormalizedSearchTerm[] {
  return terms.map((term) => ({
    original: term,
    normalized: normalizeText(term),
  }));
}
