import "server-only";

import { HarshMaurRedditScraper } from "@/lib/reddit/providers/harsh-maur-reddit-scraper";
import type { RedditPostSearchProvider } from "@/lib/reddit/providers/reddit-post-search-provider";

export function createRedditPostSearchProvider(): RedditPostSearchProvider {
  return new HarshMaurRedditScraper();
}
