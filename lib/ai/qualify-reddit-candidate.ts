import "server-only";

import { z } from "zod";

/** The five approved aiMatchType values (Phase 9B-1, locked). */
const AI_MATCH_TYPES = [
  "intent",
  "pain_point",
  "competitor_mention",
  "general_discussion",
  "not_relevant",
] as const;

/**
 * Structured output schema for Gemini qualification (Phase 9B).
 * Pure shape/range/enum validation only - the aiQualified/aiScore/aiMatchType
 * consistency rules (e.g. not_relevant -> aiQualified must be false) are
 * intentionally NOT enforced here. That normalization belongs to the future
 * qualifyRedditCandidate() service implementation, not this schema.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via `typeof` below; will also be passed to generateObject() once Phase 9B-4 implements the service.
const qualifyRedditCandidateSchema = z
  .object({
    aiQualified: z
      .boolean()
      .describe(
        "Whether this candidate is a genuine, actionable lead worth surfacing. Must be false for not_relevant and general_discussion, and false whenever aiScore is 0-5. For intent/pain_point/competitor_mention with aiScore 6-10, judge independently based on actual lead quality.",
      ),
    aiScore: z
      .number()
      .int()
      .min(0)
      .max(10)
      .describe(
        "Overall lead-quality score as an integer from 0 to 10 (no decimals). 8-10 = Strong Match, 6-7 = Partial Match, 0-5 = Not Qualified. Judge independently from the actual Reddit content and project fit - never from keyword/phrase match counts.",
      ),
    aiMatchType: z
      .enum(AI_MATCH_TYPES)
      .describe(
        "Single primary classification. When multiple signals are present, apply the fixed priority: intent > competitor_mention > pain_point > general_discussion > not_relevant.",
      ),
    aiLeadSummary: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise 1-2 sentence summary for the business owner explaining who this person is and why this candidate matters. Never reference the Reddit author's username.",
      ),
    aiMatchReason: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise explanation, grounded in the actual Reddit content and project context, of why this classification and score were chosen.",
      ),
    aiPossibleCompetitor: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "A real, identifiable competitor/company/product name only if the Reddit content provides credible evidence. Null when no real competitor is identified. Never invent, guess, or infer a name, and never return a name solely because it appears in the project's competitor list.",
      ),
  })
  .strict();

export type QualifyRedditCandidateOutput = z.infer<typeof qualifyRedditCandidateSchema>;
