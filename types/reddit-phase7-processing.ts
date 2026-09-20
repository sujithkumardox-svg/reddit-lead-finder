/**
 * Shapes for `reddit_phase7_processing` - the Phase 7 processing-history
 * table. It answers exactly one question: "has this project already run
 * this Reddit post through Phase 7?" See
 * `supabase/migrations/20260920100000_reddit_phase7_processing.sql` for the
 * underlying table.
 *
 * Deliberately minimal, and kept separate from
 * `types/gemini-qualification-queue.ts` (Phase 9's crash-safe Gemini queue)
 * and `types/reddit-leads.ts` (the customer-facing lead list) - this table
 * stores only the binary Phase 7 verdict, never candidate content, scores,
 * or AI reasoning.
 */

/** The Phase 7 verdict for one (project, reddit item) pair. Both values count as "already processed". */
export type Phase7Outcome = "lead" | "not_a_lead";

/** A row of `reddit_phase7_processing`, in camelCase. */
export type Phase7ProcessingRow = {
  id: string;
  projectId: string;
  userId: string;
  /** Reddit fullname: `t3_...` for posts, `t1_...` for comments. */
  redditItemId: string;
  outcome: Phase7Outcome;
  createdAt: string;
  updatedAt: string;
};

/** Everything `recordPhase7Outcome` needs to persist one Phase 7 processing result. */
export type RecordPhase7OutcomeInput = {
  projectId: string;
  userId: string;
  redditItemId: string;
  outcome: Phase7Outcome;
};
