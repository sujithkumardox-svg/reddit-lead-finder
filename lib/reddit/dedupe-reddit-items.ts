/**
 * Removes duplicate Reddit posts/comments by their Reddit id (fullname),
 * keeping the first occurrence. Used because the same post can surface
 * across multiple search queries/subreddits.
 */
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }

  return result;
}
