import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { RedditPostItem } from "@/types/reddit-scan";

/**
 * TEMPORARY diagnostic-only capture of scraped Reddit posts.
 *
 * Added solely to investigate the Leadverse zero-match incident: persists
 * the actual in-window post title/body text from one controlled test scan
 * into `public.diagnostic_scraped_posts_temp` so it can be manually compared
 * against the project's real stored search terms.
 *
 * NOT part of the MVP pipeline:
 *   - Never read by matching, Phase 8, the Gemini worker, lead persistence,
 *     or the dashboard - nothing in this codebase queries this table.
 *   - Does not alter, wrap, or replace any existing scanner behavior; it is
 *     called as a pure side-effect from `services/reddit-scanner.ts` and its
 *     result is never used by the caller.
 *
 * Gated behind `ENABLE_SCAN_POST_CAPTURE_DIAGNOSTIC` (default OFF, and
 * independent of `USE_FREE_PLAN_TEST_LIMITS`). When the flag is off, this
 * module never even constructs a Supabase client.
 *
 * Fail-open by design: any error (missing table, RLS rejection, network
 * failure) is caught and logged, never thrown - a diagnostic capture failure
 * can never affect scan success/failure or any data returned to the caller.
 *
 * Must be removed - this file, its call site in `reddit-scanner.ts`, and the
 * table itself - once the Leadverse investigation concludes.
 */

export function isScanPostCaptureDiagnosticEnabled(): boolean {
  return process.env.ENABLE_SCAN_POST_CAPTURE_DIAGNOSTIC === "true";
}

export type ScanPostCaptureContext = {
  userId: string;
  projectId: string;
  /** `ScanRunMetrics.syncLogId`, when a metrics accumulator is in use. */
  syncLogId?: string;
  subreddit: string;
};

/**
 * Best-effort insert of `posts` into the temporary diagnostic table.
 *
 * No-op (and no Supabase client is created at all) unless
 * `isScanPostCaptureDiagnosticEnabled()` is true, or `posts` is empty. Never
 * mutates `posts` or `context`. Never throws.
 */
export async function captureScrapedPostsForDiagnostics(
  posts: RedditPostItem[],
  context: ScanPostCaptureContext,
): Promise<void> {
  if (!isScanPostCaptureDiagnosticEnabled()) return;
  if (posts.length === 0) return;

  try {
    const supabase = await createClient();

    const rows = posts.map((post) => ({
      user_id: context.userId,
      project_id: context.projectId,
      sync_log_id: context.syncLogId ?? null,
      subreddit: context.subreddit,
      reddit_post_id: post.id,
      title: post.title,
      body: post.body,
      item_created_at: post.createdAt,
    }));

    const { error } = await supabase.from("diagnostic_scraped_posts_temp").insert(rows);

    if (error) {
      console.error("[diagnostic-post-capture] Failed to insert diagnostic rows:", {
        message: error.message,
        code: error.code,
      });
    }
  } catch (error) {
    console.error(
      "[diagnostic-post-capture] Unexpected error while capturing diagnostic posts:",
      error,
    );
  }
}
