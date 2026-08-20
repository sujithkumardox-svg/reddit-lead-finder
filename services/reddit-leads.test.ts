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
import {
  deleteLead,
  getLeadStats,
  listLeadsByProject,
  persistQualifiedLead,
  updateLeadStatus,
} from "@/services/reddit-leads";

const mockedCreateClient = vi.mocked(createClient);

/**
 * A minimal stand-in for Supabase's chainable PostgREST query builder,
 * mirroring `gemini-qualification-queue.test.ts`. `upsert`/`then` resolve
 * with `result`; chain methods return the same object.
 */
function createChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const chain: Record<string, unknown> = {
    upsert: vi.fn(() => Promise.resolve(result)),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

function makeDbLeadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    project_id: "project-1",
    user_id: "user-1",
    reddit_item_id: "t3_post1",
    item_type: "post",
    parent_post_id: null,
    subreddit: "SaaS",
    title: "Looking for an alternative to Syften",
    content: "We are struggling to find leads.",
    author: "some_user",
    author_id: "t2_someuser",
    permalink: "https://reddit.com/r/SaaS/post1",
    score: 10,
    num_comments: 5,
    item_created_at: "2026-08-01T00:00:00.000Z",
    ai_score: 9,
    ai_match_type: "intent",
    ai_lead_summary: "Actively looking for a lead-gen tool.",
    ai_match_reason: "Explicitly asks for recommendations.",
    ai_possible_competitor: null,
    ai_possible_competitor_reason: null,
    safety_badge: "without_rules",
    safety_explanation: "This subreddit has no posted rules.",
    status: "new",
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
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

describe("listLeadsByProject", () => {
  it("1. scopes the select to the authenticated user and project and defaults to newest item_created_at", async () => {
    const chain = createChain({ data: [makeDbLeadRow()], error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    const leads = await listLeadsByProject("user-1", "project-1");

    expect(from).toHaveBeenCalledWith("reddit_leads");
    expect(chain.select).toHaveBeenCalledWith(expect.stringContaining("reddit_item_id"));
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.order).toHaveBeenCalledWith("item_created_at", { ascending: false });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      id: "lead-1",
      projectId: "project-1",
      redditItemId: "t3_post1",
      itemType: "post",
      subreddit: "SaaS",
      aiScore: 9,
      status: "new",
    });
  });

  it("2. maps a comment row without inventing a title or comment count", async () => {
    const chain = createChain({
      data: [
        makeDbLeadRow({
          id: "lead-2",
          reddit_item_id: "t1_comment1",
          item_type: "comment",
          parent_post_id: "t3_post1",
          title: null,
          num_comments: null,
          content: "I've been struggling too.",
        }),
      ],
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const [lead] = await listLeadsByProject("user-1", "project-1");

    expect(lead.itemType).toBe("comment");
    expect(lead.title).toBeNull();
    expect(lead.numComments).toBeNull();
    expect(lead.content).toBe("I've been struggling too.");
  });

  it("3. applies Strong (ai_score >= 8) and Partial (6-7) filters independently", async () => {
    const strongChain = createChain({ data: [], error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => strongChain) } as never);
    await listLeadsByProject("user-1", "project-1", { matchFilters: ["strong"] });
    expect(strongChain.gte).toHaveBeenCalledWith("ai_score", 8);

    const partialChain = createChain({ data: [], error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => partialChain) } as never);
    await listLeadsByProject("user-1", "project-1", { matchFilters: ["partial"] });
    expect(partialChain.gte).toHaveBeenCalledWith("ai_score", 6);
    expect(partialChain.lte).toHaveBeenCalledWith("ai_score", 7);
  });

  it("4. filters by item_created_at range and supports score sorts", async () => {
    const chain = createChain({ data: [], error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await listLeadsByProject("user-1", "project-1", {
      sort: "highest_score",
      dateFrom: "2026-08-01T00:00:00.000Z",
      dateTo: "2026-08-02T00:00:00.000Z",
      limit: 5,
    });

    expect(chain.gte).toHaveBeenCalledWith("item_created_at", "2026-08-01T00:00:00.000Z");
    expect(chain.lte).toHaveBeenCalledWith("item_created_at", "2026-08-02T00:00:00.000Z");
    expect(chain.order).toHaveBeenCalledWith("ai_score", { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it("5. null-safe maps missing author/content/safety fields", async () => {
    const chain = createChain({
      data: [
        makeDbLeadRow({
          author: null,
          content: null,
          safety_badge: null,
          safety_explanation: null,
        }),
      ],
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const [lead] = await listLeadsByProject("user-1", "project-1");
    expect(lead.author).toBe("[deleted]");
    expect(lead.content).toBe("");
    expect(lead.safetyBadge).toBe("without_rules");
    expect(lead.safetyExplanation).toBe("");
  });

  it("6. throws on a genuine database error", async () => {
    const chain = createChain({
      data: null,
      error: { code: "500", message: "boom", details: "", hint: "" },
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(listLeadsByProject("user-1", "project-1")).rejects.toThrow("Failed to load leads.");
  });
});

describe("getLeadStats", () => {
  it("counts total, new, contacted, strong (8-10), and partial (6-7)", async () => {
    const chain = createChain({
      data: [
        { status: "new", ai_score: 9 },
        { status: "new", ai_score: 10 },
        { status: "contacted", ai_score: 6 },
        { status: "contacted", ai_score: 7 },
      ],
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const stats = await getLeadStats("user-1", "project-1");

    expect(chain.select).toHaveBeenCalledWith("status, ai_score");
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(stats).toEqual({
      total: 4,
      newCount: 2,
      contactedCount: 2,
      strongCount: 2,
      partialCount: 2,
    });
  });
});

describe("updateLeadStatus", () => {
  it("updates status scoped to user, project, and lead id", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await updateLeadStatus("user-1", "project-1", "lead-1", "contacted");

    expect(chain.update).toHaveBeenCalledWith({ status: "contacted" });
    expect(chain.eq).toHaveBeenCalledWith("id", "lead-1");
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
  });
});

describe("deleteLead", () => {
  it("deletes the lead scoped to user, project, and lead id", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await deleteLead("user-1", "project-1", "lead-1");

    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith("id", "lead-1");
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
  });
});
