import "server-only";

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE_URL = "https://oauth.reddit.com";
const REQUEST_TIMEOUT_MS = 15_000;
// Refresh the cached token slightly before it actually expires so an
// in-flight request never gets rejected mid-scan for an almost-expired token.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Raised for any failed Reddit API call (auth, search, comments). Callers
 * can check `isRateLimited` to distinguish "back off and try later" from
 * other failures.
 */
export class RedditApiError extends Error {
  readonly status?: number;
  readonly isRateLimited: boolean;
  /** Seconds Reddit asked us to wait before retrying, when known (429s). */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options?: {
      status?: number;
      isRateLimited?: boolean;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RedditApiError";
    this.status = options?.status;
    this.isRateLimited = options?.isRateLimited ?? false;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

function getRedditEnv() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;

  if (!clientId || !clientSecret || !userAgent) {
    throw new RedditApiError(
      "Missing Reddit API credentials. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT.",
    );
  }

  return { clientId, clientSecret, userAgent };
}

// Module-level in-memory token cache. Good enough for a single long-lived
// Node process; a cold start (e.g. a fresh worker invocation) simply
// re-authenticates. Deliberately has no dependency on any specific runtime
// or hosting platform.
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAccessToken(): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret, userAgent } = getRedditEnv();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetchWithTimeout(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
      },
      body: "grant_type=client_credentials",
    });
  } catch (error) {
    throw new RedditApiError("Failed to reach Reddit's authentication endpoint.", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new RedditApiError(`Reddit authentication failed with status ${response.status}.`, {
      status: response.status,
      isRateLimited: response.status === 429,
    });
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS,
  };
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  cachedToken = await requestAccessToken();
  return cachedToken.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs an authenticated GET against the Reddit OAuth API.
 *
 * - Refreshes the access token and retries once on a 401.
 * - Retries transient failures (5xx, network/timeout errors) with backoff.
 * - Surfaces 429s as a `RedditApiError` with `isRateLimited: true` after
 *   honoring `Retry-After` up to the attempt budget, so callers can decide
 *   whether to keep scanning or stop early instead of retrying blindly.
 */
export async function redditGet<T>(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<T> {
  const { userAgent } = getRedditEnv();
  const url = new URL(`${REDDIT_API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const accessToken = await getAccessToken(attempt > 1 && lastError instanceof RedditApiError && lastError.status === 401);

      const response = await fetchWithTimeout(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": userAgent,
        },
      });

      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after")) || RETRY_BASE_DELAY_MS / 1000;
        console.warn(
          `[reddit-api] Rate limited on ${path} (attempt ${attempt}/${MAX_ATTEMPTS}). Retry-After: ${retryAfterSeconds}s`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryAfterSeconds * 1000);
          continue;
        }
        throw new RedditApiError(`Reddit API rate limit exceeded for ${path}.`, {
          status: 429,
          isRateLimited: true,
          retryAfterSeconds,
        });
      }

      if (response.status === 401 && attempt < MAX_ATTEMPTS) {
        console.warn(`[reddit-api] Access token rejected on ${path}, refreshing and retrying.`);
        lastError = new RedditApiError("Reddit access token was rejected.", { status: 401 });
        continue;
      }

      if (!response.ok) {
        throw new RedditApiError(`Reddit API request to ${path} failed with status ${response.status}.`, {
          status: response.status,
        });
      }

      return (await response.json()) as T;
    } catch (error) {
      // Rate limit errors are only thrown once the retry budget is spent -
      // surface them immediately rather than retrying further.
      if (error instanceof RedditApiError && error.isRateLimited) {
        throw error;
      }

      lastError = error;

      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `[reddit-api] Request to ${path} failed (attempt ${attempt}/${MAX_ATTEMPTS}):`,
          error instanceof Error ? error.message : error,
        );
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
    }
  }

  if (lastError instanceof RedditApiError) {
    throw lastError;
  }

  throw new RedditApiError(`Reddit API request to ${path} failed after ${MAX_ATTEMPTS} attempts.`, {
    cause: lastError,
  });
}
