import "server-only";

const REACHABILITY_TIMEOUT_MS = 8_000;

/**
 * Lightweight reachability check used by website validation. Confirms the
 * site responds successfully - it does NOT download/parse page content or
 * call any AI model. This is intentionally kept separate from
 * `fetchWebsiteContent` (which scrapes text for the AI onboarding prompt) so
 * validation stays cheap enough to run automatically and frequently.
 */
export async function checkWebsiteReachable(url: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; RedditLeadFinderBot/1.0)",
  };

  let response: Response | undefined;
  let shouldRetryWithGet = false;
  try {
    try {
      response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });

      if (response.status === 405) {
        // Some servers reject HEAD requests specifically (Method Not
        // Allowed) without throwing - fall back to GET before deciding.
        shouldRetryWithGet = true;
      }
    } catch {
      // Some servers reject HEAD requests - fall back to GET without
      // reading the body.
      shouldRetryWithGet = true;
    }

    if (shouldRetryWithGet) {
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), REACHABILITY_TIMEOUT_MS);
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: getController.signal,
          headers,
        });
      } finally {
        clearTimeout(getTimeout);
      }
    }

    if (!response!.ok) {
      throw new Error(`Website responded with status ${response!.status}.`);
    }
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => {});
  }
}
