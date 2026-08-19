import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PersistQualifiedLeadInput } from "@/types/reddit-leads";

// `services/reddit-leads.ts` talks to Supabase via `@/lib/supabase/server`
// (`server-only` + Next's request-scoped `cookies()`), which doesn't exist
// in a plain unit test. Mocking the Supabase client itself (rather than
// this whole service) lets these tests verify the exact upsert payload/
// conflict target sent to Postgres, mirroring the convention already used
// in `services/gemini-qualification-queue.test.ts`.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { persistQualifiedLead } from "@/services/reddit-leads";

const mockedCreateClient = vi.mocked(createClient);

/** A minimal stand-in for Supabase's chainable PostgREST query builder, mirroring the one in gemini-qualification-queue.test.ts. */
function createChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    upsert: vi.fn(() => Promise.resolve(result)),
  };
  return chain;
}

function makePostLeadInput(overrides: Partial<PersistQualifiedLeadInput> = {}): PersistQualifiedLeadInput {
  return {
    projectId: "project-1",
    userId: "user-1",
    redditItemId: "t3_post1",
    itemType: "post",
    parentPostId: null,
    subreddit: "SaaS",
    title: "Looking for an alternative to Syften",
    content: "We are struggling to find leads.",
    author: "some_user",
    authorId: "t2_someuser",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    numComments: 5,
    itemCreatedAt: "2026-08-01T00:00:00.000Z",
    aiScore: 9,
    aiMatchType: "intent",
    aiLeadSummary: "Actively looking for a lead-gen tool.",
    aiMatchReason: "Explicitly asks for recommendations.",
    aiPossibleCompetitor: null,
    aiPossibleCompetitorReason: null,
    safetyBadge: "without_rules",
    safetyExplanation: "This subreddit has no posted rules.",
    ...overrides,
  };
}

function makeCommentLeadInput(overrides: Partial<PersistQualifiedLeadInput> = {}): PersistQualifiedLeadInput {
  return makePostLeadInput({
    redditItemId: "t1_comment1",
    itemType: "comment",
    parentPostId: "t3_post1",
    title: null,
    content: "I've been struggling to find qualified leads too.",
    numComments: null,
    ...overrides,
  });
}

beforeEach(() => {
  mockedCreateClient.mockReset();
});

describe("persistQualifiedLead", () => {
  it("1. upserts a qualified post lead keyed on (project_id, reddit_item_id)", async () => {
    const chain = createChain({ data: null, error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await persistQualifiedLead(makePostLeadInput());

    expect(from).toHaveBeenCalledWith("reddit_leads");
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        reddit_item_id: "t3_post1",
        item_type: "post",
        parent_post_id: null,
        title: "Looking for an alternative to Syften",
        content: "We are struggling to find leads.",
        author: "some_user",
        author_id: "t2_someuser",
        permalink: "https://reddit.com/r/SaaS/post1",
        score: 10,
        num_comments: 5,
      }),
      { onConflict: "project_id,reddit_item_id" },
    );
  });

  it("2. upserts a qualified comment lead with its parent post id and null num_comments", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(makeCommentLeadInput());

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        reddit_item_id: "t1_comment1",
        item_type: "comment",
        parent_post_id: "t3_post1",
        title: null,
        num_comments: null,
      }),
      { onConflict: "project_id,reddit_item_id" },
    );
  });

  it("3. persists the full AI result including ai_possible_competitor_reason and the safety badge/explanation", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(
      makePostLeadInput({
        aiPossibleCompetitor: "Syften",
        aiPossibleCompetitorReason: "The author says they currently use Syften.",
        safetyBadge: "promo_not_safe",
        safetyExplanation: "Rule \"No self-promotion\" explicitly bans promotion.",
      }),
    );

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_score: 9,
        ai_match_type: "intent",
        ai_lead_summary: "Actively looking for a lead-gen tool.",
        ai_match_reason: "Explicitly asks for recommendations.",
        ai_possible_competitor: "Syften",
        ai_possible_competitor_reason: "The author says they currently use Syften.",
        safety_badge: "promo_not_safe",
        safety_explanation: "Rule \"No self-promotion\" explicitly bans promotion.",
      }),
      { onConflict: "project_id,reddit_item_id" },
    );
  });

  it("4. never includes a status field in the upsert payload, so an existing lead's status is never reset", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(makePostLeadInput());

    const payload = (chain.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("status");
  });

  it("5. throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(persistQualifiedLead(makePostLeadInput())).rejects.toThrow(
      "Failed to persist qualified lead.",
    );
  });
});
