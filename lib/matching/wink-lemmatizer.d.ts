/**
 * Ambient type declaration for `wink-lemmatizer` (Phase 7, Step 4).
 *
 * The package ships as plain JavaScript with no bundled `.d.ts` and has no
 * `@types/wink-lemmatizer` package on npm, so TypeScript can't infer its
 * shape on its own. This declares only the three WordNet-backed
 * conjugation/singularization functions `stem-lemma-matcher.ts` actually
 * calls - each takes a single lowercase word and returns its base
 * (dictionary) form, or the original word unchanged if no base form
 * applies.
 */
declare module "wink-lemmatizer" {
  export function noun(word: string): string;
  export function verb(word: string): string;
  export function adjective(word: string): string;
}
