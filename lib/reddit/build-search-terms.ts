/**
 * Pure helpers for turning a project's onboarding search data into Reddit
 * search terms. No network calls, no DB access - kept independent of
 * `services/projects.ts` so this stays reusable/testable on its own.
 *
 * Product philosophy: "Use every onboarding search signal to maximize lead
 * discovery." Every keyword, hidden keyword variation, intent phrase, pain
 * phrase, and competitor is searched - none are capped or dropped here.
 * Priority order only controls which terms are searched *first* (so
 * higher-value signals aren't starved if Reddit rate-limits a scan), it
 * never controls which terms get searched at all.
 */

/** Number of independent search terms grouped into one execution batch. */
const SEARCH_BATCH_SIZE = 5;

export type SearchTermSource = {
  keywords: string[];
  hiddenKeywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
};

/**
 * Combines every onboarding search signal into a single deduplicated
 * (case-insensitive) list of search terms, ordered by priority:
 *
 *   1. Keywords
 *   2. Intent phrases
 *   3. Pain phrases
 *   4. Competitors
 *   5. Hidden keyword variations
 *
 * There is no cap - every unique term from every category is included.
 * Priority order exists solely so that, if a scan gets rate-limited partway
 * through, the highest-value signals (keywords, intent/pain phrases,
 * competitors) have already been searched before the much larger hidden
 * keyword variation list is reached.
 */
export function buildSearchTerms(source: SearchTermSource): string[] {
  const allTerms = [
    ...source.keywords,
    ...source.intentPhrases,
    ...source.painPhrases,
    ...source.competitors,
    ...source.hiddenKeywords,
  ];

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of allTerms) {
    const trimmed = term.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    terms.push(trimmed);
  }

  return terms;
}

/**
 * Splits an ordered term list into batches of `SEARCH_BATCH_SIZE`
 * independent terms, preserving priority order. Batching here is purely
 * about pacing/sequencing Reddit API requests - it does NOT combine terms
 * into a single query. Each term is still searched with its own,
 * independent Reddit request (see `toRedditSearchQuery`).
 */
export function batchSearchTerms(terms: string[], batchSize: number = SEARCH_BATCH_SIZE): string[][] {
  const batches: string[][] = [];

  for (let i = 0; i < terms.length; i += batchSize) {
    batches.push(terms.slice(i, i + batchSize));
  }

  return batches;
}

/**
 * Converts a single onboarding term into the Reddit search query string
 * used for its own, independent request. Multi-word terms are quoted for
 * an exact-phrase match since they are no longer combined with other terms
 * via `OR`.
 */
export function toRedditSearchQuery(term: string): string {
  return term.includes(" ") ? `"${term}"` : term;
}
