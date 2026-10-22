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
  LEAD_READ_PAGE_SIZE,
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
    upsert: vi.fn(() => chain),
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    range: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return chain;
}

function createRangedChain(rows: unknown[], cap?: number) {
  let start = 0;
  let end = -1;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    range: vi.fn((from: number, to: number) => {
      start = from;
      end = to;
      return chain;
    }),
    then: (onFulfilled: (value: { data: unknown[]; error: null; count: number }) => unknown) => {
      const page = rows.slice(start, end + 1);
      return Promise.resolve({
        data: cap === undefined ? page : page.slice(0, cap),
        error: null,
        count: rows.length,
      }).then(onFulfilled);
    },
  });
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
    ...overrides,
  };
}

function confirmedLeadRow(input: PersistQualifiedLeadInput) {
  return {
    id: "lead-1",
    project_id: input.projectId,
    user_id: input.userId,
    reddit_item_id: input.redditItemId,
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
    const input = makePostLeadInput();
    const chain = createChain({ data: confirmedLeadRow(input), error: null });
    const from = vi.fn(() => chain);
    mockedCreateClient.mockResolvedValue({ from } as never);

    await persistQualifiedLead(input);

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
    expect(chain.select).toHaveBeenCalledWith("id, project_id, user_id, reddit_item_id");
  });

  it("2. upserts a qualified comment lead with its parent post id and null num_comments", async () => {
    const input = makeCommentLeadInput();
    const chain = createChain({ data: confirmedLeadRow(input), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(input);

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

  it("3. persists the full AI result including ai_possible_competitor_reason and writes null safety when omitted", async () => {
    const input = makePostLeadInput({
      aiPossibleCompetitor: "Syften",
      aiPossibleCompetitorReason: "The author says they currently use Syften.",
    });
    const chain = createChain({ data: confirmedLeadRow(input), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(input);

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_score: 9,
        ai_match_type: "intent",
        ai_lead_summary: "Actively looking for a lead-gen tool.",
        ai_match_reason: "Explicitly asks for recommendations.",
        ai_possible_competitor: "Syften",
        ai_possible_competitor_reason: "The author says they currently use Syften.",
        safety_badge: null,
        safety_explanation: null,
      }),
      { onConflict: "project_id,reddit_item_id" },
    );
  });

  it("3b. still writes an explicit safety badge when one is provided", async () => {
    const input = makePostLeadInput({
      safetyBadge: "promo_not_safe",
      safetyExplanation: "Rule \"No self-promotion\" explicitly bans promotion.",
    });
    const chain = createChain({ data: confirmedLeadRow(input), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(input);

    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        safety_badge: "promo_not_safe",
        safety_explanation: "Rule \"No self-promotion\" explicitly bans promotion.",
      }),
      { onConflict: "project_id,reddit_item_id" },
    );
  });

  it("4. never includes a status field in the upsert payload, so an existing lead's status is never reset", async () => {
    const input = makePostLeadInput();
    const chain = createChain({ data: confirmedLeadRow(input), error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await persistQualifiedLead(input);

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

  it("does not treat a response with no returned lead row as a successful save", async () => {
    const chain = createChain({ data: null, error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(persistQualifiedLead(makePostLeadInput())).rejects.toThrow(
      "Failed to persist qualified lead.",
    );
    expect(chain.upsert).toHaveBeenCalledTimes(1);
    expect(chain.select).toHaveBeenCalledWith("id, project_id, user_id, reddit_item_id");
  });

  it("does not accept a returned row for a different project", async () => {
    const input = makePostLeadInput();
    const chain = createChain({
      data: { ...confirmedLeadRow(input), project_id: "project-b" },
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    await expect(persistQualifiedLead(input)).rejects.toThrow("Failed to persist qualified lead.");
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: "project-1", reddit_item_id: "t3_post1" }),
      { onConflict: "project_id,reddit_item_id" },
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
    expect(chain.select).toHaveBeenCalledWith(expect.stringContaining("reddit_item_id"), {
      count: "exact",
    });
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(chain.eq).toHaveBeenCalledWith("project_id", "project-1");
    expect(chain.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(chain.limit).not.toHaveBeenCalled();
    expect(chain.update).not.toHaveBeenCalled();
    expect(chain.delete).not.toHaveBeenCalled();
    expect(chain.upsert).not.toHaveBeenCalled();
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

  it("4. keeps date filters on the query and does not apply the preview limit in SQL", async () => {
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
    expect(chain.order).toHaveBeenCalledWith("id", { ascending: true });
    expect(chain.limit).not.toHaveBeenCalled();
  });

  it("5b. collapses duplicates after the read and keeps the four-lead preview on representatives", async () => {
    const duplicates = [1, 2, 3, 4].map((day) =>
      makeDbLeadRow({
        id: `dup-${day}`,
        reddit_item_id: `t3_dup${day}`,
        title: "Same post",
        content: "Same body",
        ai_score: day === 4 ? 9 : 6,
        created_at: `2026-07-0${day}T00:00:00.000Z`,
        item_created_at: `2026-09-0${day}T00:00:00.000Z`,
        permalink: `https://reddit.com/dup-${day}`,
        ai_match_type: `type-${day}`,
        ai_lead_summary: `Summary ${day}`,
      }),
    );
    const others = [1, 2, 3, 4].map((day) =>
      makeDbLeadRow({
        id: `other-${day}`,
        reddit_item_id: `t3_other${day}`,
        title: `Other ${day}`,
        content: `Body ${day}`,
        ai_score: 8,
        item_created_at: `2026-08-0${day}T00:00:00.000Z`,
      }),
    );
    const chain = createChain({ data: [...duplicates, ...others], error: null });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const leads = await listLeadsByProject("user-1", "project-1", { sort: "newest", limit: 4 });

    expect(leads.map((lead) => lead.id)).toEqual(["dup-4", "other-4", "other-3", "other-2"]);
    expect(leads[0]).toMatchObject({
      title: "Same post",
      content: "Same body",
      permalink: "https://reddit.com/dup-4",
      aiScore: 9,
      aiMatchType: "type-4",
      aiLeadSummary: "Summary 4",
    });
    expect(chain.limit).not.toHaveBeenCalled();
  });

  it("5c. reads a later page when the exact count is larger than one response", async () => {
    const rows = Array.from({ length: LEAD_READ_PAGE_SIZE + 1 }, (_, index) =>
      makeDbLeadRow({
        id: `lead-${index}`,
        reddit_item_id: `t3_${index}`,
        title: `Title ${index}`,
        content: `Body ${index}`,
      }),
    );
    const chain = createRangedChain(rows);
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const leads = await listLeadsByProject("user-1", "project-1");

    expect(chain.range).toHaveBeenNthCalledWith(1, 0, LEAD_READ_PAGE_SIZE - 1);
    expect(chain.range).toHaveBeenNthCalledWith(2, LEAD_READ_PAGE_SIZE, LEAD_READ_PAGE_SIZE * 2 - 1);
    expect(leads).toHaveLength(LEAD_READ_PAGE_SIZE + 1);
  });

  it("5d. continues past a short response cap until the exact count is read", async () => {
    const rows = [1, 2, 3, 4, 5].map((index) =>
      makeDbLeadRow({
        id: `capped-${index}`,
        reddit_item_id: `t3_capped${index}`,
        title: `Capped ${index}`,
        content: `Body ${index}`,
      }),
    );
    const chain = createRangedChain(rows, 2);
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const leads = await listLeadsByProject("user-1", "project-1", { sort: "oldest" });

    expect(leads.map((lead) => lead.id)).toEqual([
      "capped-1",
      "capped-2",
      "capped-3",
      "capped-4",
      "capped-5",
    ]);
    expect(chain.range).toHaveBeenNthCalledWith(1, 0, LEAD_READ_PAGE_SIZE - 1);
    expect(chain.range).toHaveBeenNthCalledWith(2, 2, 3);
  });

  it("5e. collapses a duplicate group split across read pages", async () => {
    const rows = Array.from({ length: LEAD_READ_PAGE_SIZE + 1 }, (_, index) =>
      makeDbLeadRow({
        id: `page-${index}`,
        reddit_item_id: `t3_page${index}`,
        title: index === 0 || index === LEAD_READ_PAGE_SIZE ? "Shared title" : `Title ${index}`,
        content: index === 0 || index === LEAD_READ_PAGE_SIZE ? "Shared body" : `Body ${index}`,
        ai_score: index === LEAD_READ_PAGE_SIZE ? 10 : 7,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const chain = createRangedChain(rows);
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const leads = await listLeadsByProject("user-1", "project-1");
    const shared = leads.filter((lead) => lead.title === "Shared title");

    expect(leads).toHaveLength(LEAD_READ_PAGE_SIZE);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      id: `page-${LEAD_READ_PAGE_SIZE}`,
      title: "Shared title",
      content: "Shared body",
      aiScore: 10,
    });
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
    expect(lead.safetyBadge).toBeNull();
    expect(lead.safetyExplanation).toBeNull();
    expect(lead.safetyBadge).not.toBe("without_rules");
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
        statRow({ id: "a", status: "new", ai_score: 9, title: "Alpha", content: "Body alpha" }),
        statRow({ id: "b", status: "new", ai_score: 10, title: "Beta", content: "Body beta" }),
        statRow({ id: "c", status: "contacted", ai_score: 6, title: "Gamma", content: "Body gamma" }),
        statRow({ id: "d", status: "contacted", ai_score: 7, title: "Delta", content: "Body delta" }),
      ],
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const stats = await getLeadStats("user-1", "project-1");

    expect(chain.select).toHaveBeenCalledWith(
      "id, project_id, author_id, title, content, ai_score, created_at, status",
      { count: "exact" },
    );
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

  it("counts one representative for a duplicate group", async () => {
    const duplicates = [9, 8, 7, 6, 5].map((score, index) =>
      statRow({
        id: `dup-${index}`,
        status: index === 3 ? "contacted" : "new",
        ai_score: score,
        title: "Same post",
        content: "Same body",
        created_at: `2026-08-0${index + 1}T00:00:00.000Z`,
      }),
    );
    const chain = createChain({
      data: [
        ...duplicates,
        statRow({
          id: "partial",
          status: "contacted",
          ai_score: 6,
          title: "Another post",
          content: "Another body",
        }),
      ],
      error: null,
    });
    mockedCreateClient.mockResolvedValue({ from: vi.fn(() => chain) } as never);

    const stats = await getLeadStats("user-1", "project-1");

    expect(stats).toEqual({
      total: 2,
      newCount: 1,
      contactedCount: 1,
      strongCount: 1,
      partialCount: 1,
    });
  });
});

function statRow(overrides: Record<string, unknown>) {
  return {
    id: "stat-1",
    project_id: "project-1",
    author_id: "t2_author",
    title: "A lead",
    content: "A body",
    ai_score: 8,
    created_at: "2026-08-01T00:00:00.000Z",
    status: "new",
    ...overrides,
  };
}

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
