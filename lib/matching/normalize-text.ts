/**
 * Pure text normalization for the matching engine (Phase 7). Produces a
 * TEMPORARY, in-memory normalized copy of a string for comparison purposes
 * only - it never mutates or persists anything. Callers keep the original
 * string untouched alongside whatever normalized copy they generate from
 * it (see `normalize-reddit-content.ts` and `normalize-search-terms.ts`).
 *
 * Rules applied, in order:
 *   1. Unicode-normalize (NFKC) so visually/semantically equivalent
 *      characters compare equal (e.g. full-width vs. half-width forms,
 *      composed vs. decomposed accents).
 *   2. Lowercase.
 *   3. Collapse runs of whitespace (spaces, tabs, newlines) into one space.
 *   4. Trim leading/trailing whitespace.
 *
 * Punctuation and characters that carry meaning for matching (".", "-",
 * "_", "/", digits, etc.) are deliberately left untouched - e.g.
 * "Notifier.so" -> "notifier.so", "PDF to Video" -> "pdf to video".
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return "";

  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
