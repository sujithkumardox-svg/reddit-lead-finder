/**
 * Shapes for `reddit_phase7_processing` - the Phase 7 processing-history
 * table. It answers exactly one question: "has this project already run
 * this Reddit post through Phase 7?", plus (since
 * `20260923090000_reddit_phase7_processing_claim.sql`) provides atomic
 * claim/in-flight tracking so two concurrent workers can never both call
 * the lightweight AI provider for the same `(project_id, reddit_item_id)`
 * pair. See that migration and
 * `supabase/migrations/20260920100000_reddit_phase7_processing.sql` for
 * the underlying table.
 *
 * Deliberately minimal, and kept separate from
 * `types/gemini-qualification-queue.ts` (Phase 9's crash-safe Gemini queue)
 * and `types/reddit-leads.ts` (the customer-facing lead list) - this table
 * stores only the binary Phase 7 verdict (plus claim/attempt/error
 * metadata), never candidate content, scores, or AI reasoning.
 */

/** The Phase 7 verdict for one (project, reddit item) pair. Both values count as "already processed" (terminal - see `Phase7ProcessingStatus`). */
export type Phase7Outcome = "lead" | "not_a_lead";

/**
 * Phase 7's in-flight lifecycle: `"processing"` means a worker holds (or
 * held) a claim on this row but no terminal `outcome` has been recorded
 * yet - a stale `"processing"` row is safely reclaimable (see
 * `claimPhase7Processing` in `services/reddit-phase7-processing.ts`).
 * `"completed"` means a terminal `outcome` was durably recorded and this
 * row will never be reclaimed again.
 */
export type Phase7ProcessingStatus = "processing" | "completed";

/** A row of `reddit_phase7_processing`, in camelCase. */
export type Phase7ProcessingRow = {
  id: string;
  projectId: string;
  userId: string;
  /** Reddit fullname: `t3_...` for posts, `t1_...` for comments. */
  redditItemId: string;
  status: Phase7ProcessingStatus;
  /** `null` while `status` is `"processing"` (no terminal outcome yet); always non-null once `status` is `"completed"`. */
  outcome: Phase7Outcome | null;
  /** How many times this row has been claimed - the initial claim is `1`; each safe reclaim of a stale `"processing"` row increments it. */
  attemptCount: number;
  /** Set when a worker claims (or reclaims a stale claim on) this row. `null` for historical rows that predate the claim mechanism and were never actually claimed under it. */
  processingStartedAt: string | null;
  /** Diagnostic message from the most recent attempt that did not reach a terminal outcome. Cleared on (re)claim and on completion. */
  lastError: string | null;
  /** When `lastError` was recorded. `null` whenever `lastError` is `null`. */
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Everything `recordPhase7Outcome` needs to persist one Phase 7 processing result. Legacy Prompt 1 helper - superseded for new code by `completePhase7Processing`, which finishes a row already claimed via `claimPhase7Processing` instead of inserting a fresh terminal row directly. Kept for backward compatibility; still fully functional. */
export type RecordPhase7OutcomeInput = {
  projectId: string;
  userId: string;
  redditItemId: string;
  outcome: Phase7Outcome;
};

/** Everything `claimPhase7Processing` needs to identify one `(project_id, reddit_item_id)` claim attempt. */
export type ClaimPhase7ProcessingInput = {
  projectId: string;
  userId: string;
  redditItemId: string;
};

/**
 * The three possible results of `claimPhase7Processing`:
 *
 *   - `"claimed"` - the caller now atomically owns this row (either a
 *     brand-new claim, or a safe reclaim of a stale `"processing"` row)
 *     and MUST proceed to call the AI provider. No other concurrent
 *     caller can also receive `"claimed"` for the same pair at the same
 *     time.
 *   - `"already_processed"` - a `"completed"` row already exists for this
 *     pair; the caller MUST skip Phase 7 entirely for it (never call the
 *     AI provider) and may read `outcome` for the already-decided verdict.
 *   - `"in_progress"` - another (non-stale) claim already owns this pair
 *     right now; the caller MUST skip Phase 7 for it (never call the AI
 *     provider) rather than wait or retry immediately.
 */
export type Phase7ClaimResult =
  | { kind: "claimed"; row: Phase7ProcessingRow }
  | { kind: "already_processed"; outcome: Phase7Outcome }
  | { kind: "in_progress" };
