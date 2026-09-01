import "server-only";

import { ApifyClient } from "apify-client";

import type { RedditPostItem } from "@/types/reddit-scan";
import {
  RedditProviderError,
  type RedditPostSearchProvider,
  type RedditPostSearchRequest,
} from "@/lib/reddit/providers/reddit-post-search-provider";

const HARSH_MAUR_ACTOR_ID = "harshmaur/reddit-scraper";
const DATASET_PAGE_SIZE = 1000;
const MAX_APIFY_START_ATTEMPTS = 3;
const APIFY_START_RETRY_DELAY_MS = 1_000;

type HarshMaurActorInput = {
  searchTerms: string[];
  withinCommunity: string;
  searchPosts: true;
  searchComments: false;
  searchCommunities: false;
  crawlCommentsPerPost: false;
  searchTime: "week";
  searchSort: "new";
  includeNSFW: false;
  aiAnalysis: false;
  maxPostsCount: number;
};

export function buildHarshMaurActorInput(request: RedditPostSearchRequest): HarshMaurActorInput {
  const subreddit = request.subreddit.trim().replace(/^r\//i, "");

  return {
    searchTerms: request.searchTerms,
    withinCommunity: `r/${subreddit}`,
    searchPosts: true,
    searchComments: false,
    searchCommunities: false,
    crawlCommentsPerPost: false,
    searchTime: "week",
    searchSort: "new",
    includeNSFW: false,
    aiAnalysis: false,
    // maxPostsCount scope is still unresolved (README: per-term; schema: global).
    // Do not pass postsPerQuery alone. Compute from the live term list so a
    // multi-term run is not starved if the cap is global. Never hard-code a
    // test term count.
    maxPostsCount: request.postsPerQuery * Math.max(request.searchTerms.length, 1),
  };
}

export function mapHarshMaurDatasetItem(item: unknown): RedditPostItem | null {
  if (!isRecord(item) || item.dataType !== "post") {
    return null;
  }

  const id = typeof item.id === "string" ? item.id : "";
  if (!id) {
    return null;
  }

  return {
    id,
    type: "post",
    subreddit: readSubreddit(item),
    title: typeof item.title === "string" ? item.title : "",
    body: typeof item.body === "string" ? item.body : "",
    author: typeof item.authorName === "string" ? item.authorName : "",
    authorId: typeof item.authorId === "string" ? item.authorId : null,
    url: typeof item.contentUrl === "string" ? item.contentUrl : "",
    permalink: typeof item.postUrl === "string" ? item.postUrl : "",
    score: typeof item.score === "number" ? item.score : 0,
    numComments: typeof item.commentsCount === "number" ? item.commentsCount : 0,
    createdAt: toIsoCreatedAt(item.createdAt),
  };
}

export class HarshMaurRedditScraper implements RedditPostSearchProvider {
  async searchPosts(request: RedditPostSearchRequest): Promise<RedditPostItem[]> {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
      throw new RedditProviderError("The Reddit scan provider is not configured.", {
        code: "missing_credentials",
        fatal: true,
      });
    }

    const client = new ApifyClient({ token });
    const input = buildHarshMaurActorInput(request);
    const run = await callActorWithRetry(client, input);

    if (run.status !== "SUCCEEDED") {
      throw new RedditProviderError("The Reddit scan provider run did not succeed.", {
        code: "actor_failed",
        fatal: false,
      });
    }

    if (!run.defaultDatasetId) {
      throw new RedditProviderError("The Reddit scan provider run did not succeed.", {
        code: "actor_failed",
        fatal: false,
      });
    }

    const posts: RedditPostItem[] = [];
    for await (const item of client.dataset(run.defaultDatasetId).listItems({ chunkSize: DATASET_PAGE_SIZE })) {
      const mapped = mapHarshMaurDatasetItem(item);
      if (mapped) {
        posts.push(mapped);
      }
    }

    return posts;
  }
}

async function callActorWithRetry(
  client: ApifyClient,
  input: HarshMaurActorInput,
): Promise<{ status?: string; defaultDatasetId?: string }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_APIFY_START_ATTEMPTS; attempt++) {
    try {
      return await client.actor(HARSH_MAUR_ACTOR_ID).call(input, { log: null });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_APIFY_START_ATTEMPTS) {
        break;
      }
      await sleep(APIFY_START_RETRY_DELAY_MS * attempt);
    }
  }

  throw new RedditProviderError("The Reddit scan provider request failed.", {
    code: "apify_request",
    fatal: false,
    cause: lastError,
  });
}

function readSubreddit(item: Record<string, unknown>): string {
  if (typeof item.parsedCommunityName === "string" && item.parsedCommunityName) {
    return item.parsedCommunityName;
  }
  if (typeof item.communityName === "string" && item.communityName) {
    return item.communityName.replace(/^r\//i, "");
  }
  return "";
}

function toIsoCreatedAt(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
