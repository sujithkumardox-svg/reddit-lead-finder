import { NextResponse } from "next/server";

import { buildSearchTerms } from "@/lib/reddit/build-search-terms";
import {
  applyFreePlanTestLimits,
  isFreePlanTestLimitsEnabled,
} from "@/lib/reddit/free-plan-test-limits";
import { createClient } from "@/lib/supabase/server";
import { getProjectScanData } from "@/services/projects";

/**
 * TEMPORARY / DEV-ONLY diagnostic. Isolated from the production scanner.
 * Does not call scanProjectReddit, Apify, Gemini, or write to the database.
 * Delete this file after the Free Plan test payload has been verified.
 */

const PROJECT_ID = "dcc3daf8-2d21-4e57-a877-f9f0e5142b3b";
const POSTS_PER_QUERY = 25;

export const runtime = "nodejs";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      {
        authenticatedUserObtained: false,
        projectId: PROJECT_ID,
        projectDataLoaded: false,
        error: "Unauthorized.",
      },
      { status: 401 },
    );
  }

  const scanData = await getProjectScanData(user.id, PROJECT_ID);
  if (!scanData) {
    return NextResponse.json(
      {
        authenticatedUserObtained: true,
        projectId: PROJECT_ID,
        projectDataLoaded: false,
        freePlanTestLimitsEnabled: isFreePlanTestLimitsEnabled(),
        error: "Project not found for this authenticated user.",
      },
      { status: 404 },
    );
  }

  const sliced = applyFreePlanTestLimits(scanData);
  const searchTerms = buildSearchTerms(sliced);
  const hypotheticalProviderCalls = sliced.subreddits.map((subreddit) => ({
    subreddit,
    searchTerms,
    postsPerQuery: POSTS_PER_QUERY,
  }));

  return NextResponse.json({
    authenticatedUserObtained: true,
    projectId: PROJECT_ID,
    projectDataLoaded: true,
    freePlanTestLimitsEnabled: isFreePlanTestLimitsEnabled(),
    sliced: {
      keywords: { count: sliced.keywords.length, values: sliced.keywords },
      intentPhrases: { count: sliced.intentPhrases.length, values: sliced.intentPhrases },
      painPhrases: { count: sliced.painPhrases.length, values: sliced.painPhrases },
      competitors: { count: sliced.competitors.length, values: sliced.competitors },
      hiddenKeywords: { count: sliced.hiddenKeywords.length, values: sliced.hiddenKeywords },
      subreddits: { count: sliced.subreddits.length, values: sliced.subreddits },
    },
    searchTermCount: searchTerms.length,
    searchTerms,
    firstFourSubreddits: sliced.subreddits,
    postsPerQuery: POSTS_PER_QUERY,
    hypotheticalProviderCallCount: hypotheticalProviderCalls.length,
    hypotheticalProviderCalls,
    apifyCalls: 0,
    geminiCalls: 0,
    databaseWrites: 0,
  });
}
