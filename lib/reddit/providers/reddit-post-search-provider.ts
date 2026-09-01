import type { RedditPostItem } from "@/types/reddit-scan";

export type RedditPostSearchRequest = {
  subreddit: string;
  searchTerms: string[];
  postsPerQuery: number;
};

export interface RedditPostSearchProvider {
  searchPosts(request: RedditPostSearchRequest): Promise<RedditPostItem[]>;
}

export type RedditProviderErrorCode = "missing_credentials" | "actor_failed" | "apify_request";

/**
 * Provider-specific failure. Missing credentials fail the whole scan;
 * per-subreddit Actor/request failures are skipped by the scanner.
 * Messages must stay secret-free (no tokens, no raw payloads).
 */
export class RedditProviderError extends Error {
  readonly code: RedditProviderErrorCode;
  readonly fatal: boolean;

  constructor(
    message: string,
    options?: {
      code?: RedditProviderErrorCode;
      fatal?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RedditProviderError";
    this.code = options?.code ?? "apify_request";
    this.fatal = options?.fatal ?? this.code === "missing_credentials";
  }
}
