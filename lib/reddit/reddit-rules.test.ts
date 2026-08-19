import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/reddit/reddit-api-client.ts` makes a real authenticated HTTP call to
// Reddit's OAuth API, which doesn't run in a plain unit test. Mocking
// `redditGet` here keeps this test focused on how `fetchSubredditRules`
// shapes its request/response, mirroring the existing convention in
// `lib/reddit/reddit-listings.ts` (which has no dedicated test file, but
// this module is new for Phase 10 so gets one).
vi.mock("@/lib/reddit/reddit-api-client", () => ({
  redditGet: vi.fn(),
}));

import { redditGet } from "@/lib/reddit/reddit-api-client";
import { fetchSubredditRules } from "@/lib/reddit/reddit-rules";

const mockedRedditGet = vi.mocked(redditGet);

beforeEach(() => {
  mockedRedditGet.mockReset();
});

describe("fetchSubredditRules", () => {
  it("1. requests the subreddit's rules endpoint and returns its rules", async () => {
    const rules = [{ short_name: "Be nice", description: "Be respectful to other users." }];
    mockedRedditGet.mockResolvedValueOnce({ rules });

    const result = await fetchSubredditRules("SaaS");

    expect(mockedRedditGet).toHaveBeenCalledWith("/r/SaaS/about/rules");
    expect(result).toEqual(rules);
  });

  it("2. URL-encodes the subreddit name", async () => {
    mockedRedditGet.mockResolvedValueOnce({ rules: [] });

    await fetchSubredditRules("some subreddit");

    expect(mockedRedditGet).toHaveBeenCalledWith("/r/some%20subreddit/about/rules");
  });

  it("3. returns an empty array when Reddit reports no rules", async () => {
    mockedRedditGet.mockResolvedValueOnce({ rules: [] });

    await expect(fetchSubredditRules("SaaS")).resolves.toEqual([]);
  });

  it("4. returns an empty array when the response omits the rules field entirely", async () => {
    mockedRedditGet.mockResolvedValueOnce({});

    await expect(fetchSubredditRules("SaaS")).resolves.toEqual([]);
  });

  it("5. propagates a Reddit API failure to the caller instead of swallowing it", async () => {
    const apiError = new Error("Reddit API request failed");
    mockedRedditGet.mockRejectedValueOnce(apiError);

    await expect(fetchSubredditRules("SaaS")).rejects.toThrow(apiError);
  });
});
