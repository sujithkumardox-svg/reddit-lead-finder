import { describe, expect, it } from "vitest";

import {
  representativeLeadRows,
  selectDisplayedLeadRows,
  type ComparableLeadRow,
} from "@/lib/leads/display-dedupe";

type TestLead = ComparableLeadRow & {
  permalink?: string;
  author?: string;
  ai_match_type?: string;
  ai_lead_summary?: string;
  ai_match_reason?: string;
};

function makeRow(overrides: Partial<TestLead> = {}): TestLead {
  return {
    id: "lead-1",
    project_id: "project-1",
    author_id: "t2_author",
    title: "Looking for a tool",
    content: "We need qualified leads.",
    ai_score: 8,
    created_at: "2026-08-01T00:00:00.000Z",
    item_created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function matchingRows(count: number): TestLead[] {
  return Array.from({ length: count }, (_, index) =>
    Object.freeze(
      makeRow({
        id: `lead-${String(index).padStart(2, "0")}`,
        ai_score: index,
        created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        item_created_at: new Date(Date.UTC(2026, 1, index + 1)).toISOString(),
        permalink: `https://reddit.com/${index}`,
        ai_match_type: `type-${index}`,
      }),
    ),
  );
}

describe("representativeLeadRows", () => {
  it.each([2, 3, 5, 10])("collapses %i matching records to the highest-score row", (count) => {
    const rows = matchingRows(count);
    const titles = rows.map((row) => row.title);

    const result = representativeLeadRows(rows);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(rows[count - 1]);
    expect(result[0].title).toBe("Looking for a tool");
    expect(result[0].content).toBe("We need qualified leads.");
    expect(rows).toHaveLength(count);
    expect(rows.map((row) => row.title)).toEqual(titles);
  });

  it("keeps the higher score when that row was created later", () => {
    const olderLower = makeRow({ id: "older", ai_score: 6, created_at: "2026-01-01T00:00:00.000Z" });
    const newerHigher = makeRow({ id: "newer", ai_score: 9, created_at: "2026-06-01T00:00:00.000Z" });

    expect(representativeLeadRows([olderLower, newerHigher])).toEqual([newerHigher]);
  });

  it("uses the oldest created_at when scores are equal", () => {
    const older = makeRow({ id: "z-later-id", ai_score: 8, created_at: "2026-01-01T00:00:00.000Z" });
    const newer = makeRow({ id: "a-earlier-id", ai_score: 8, created_at: "2026-06-01T00:00:00.000Z" });

    expect(representativeLeadRows([newer, older])).toEqual([older]);
  });

  it("uses the lesser id when scores and created_at match", () => {
    const laterId = makeRow({ id: "lead-b", ai_score: 8, created_at: "2026-01-01T00:00:00.000Z" });
    const earlierId = makeRow({ id: "lead-a", ai_score: 8, created_at: "2026-01-01T00:00:00.000Z" });

    expect(representativeLeadRows([laterId, earlierId])).toEqual([earlierId]);
  });

  it("prefers a real score over a null score without treating null as zero", () => {
    const missing = makeRow({ id: "missing", ai_score: null, created_at: "2026-01-01T00:00:00.000Z" });
    const zero = makeRow({ id: "zero", ai_score: 0, created_at: "2026-06-01T00:00:00.000Z" });

    expect(representativeLeadRows([missing, zero])).toEqual([zero]);
  });

  it("uses created_at when every score is null, and id when timestamps are unusable", () => {
    const older = makeRow({ id: "b", ai_score: null, created_at: "2026-01-01T00:00:00.000Z" });
    const newer = makeRow({ id: "a", ai_score: undefined, created_at: "2026-06-01T00:00:00.000Z" });
    expect(representativeLeadRows([newer, older])).toEqual([older]);

    const validTime = makeRow({ id: "later-id", ai_score: null, created_at: "2026-03-01T00:00:00.000Z" });
    const invalidTime = makeRow({ id: "earlier-id", ai_score: null, created_at: "not-a-timestamp" });
    expect(representativeLeadRows([invalidTime, validTime])).toEqual([validTime]);

    const noTimeA = makeRow({ id: "lead-a", ai_score: null, created_at: null });
    const noTimeB = makeRow({ id: "lead-b", ai_score: null, created_at: "" });
    expect(representativeLeadRows([noTimeB, noTimeA])).toEqual([noTimeA]);
  });

  it("does not group different authors, different text, or different projects", () => {
    const base = makeRow({ id: "base" });
    const otherAuthor = makeRow({ id: "author", author_id: "t2_other" });
    const otherBody = makeRow({ id: "body", content: "A different request." });
    const otherTitle = makeRow({ id: "title", title: "A different title" });
    const otherProject = makeRow({ id: "project", project_id: "project-2" });

    const result = representativeLeadRows([base, otherAuthor, otherBody, otherTitle, otherProject]);

    expect(result).toHaveLength(5);
  });

  it("does not group rows whose author id is missing or not a t2_ fullname", () => {
    const rows = [
      makeRow({ id: "null-id", author_id: null }),
      makeRow({ id: "also-null", author_id: null }),
      makeRow({ id: "blank", author_id: "" }),
      makeRow({ id: "username", author_id: "some_user" }),
      makeRow({ id: "upper", author_id: "T2_author" }),
      makeRow({ id: "padded", author_id: " t2_author" }),
    ];

    expect(representativeLeadRows(rows)).toHaveLength(rows.length);
  });

  it("does not group rows whose title or body is null", () => {
    const nullTitle = [
      makeRow({ id: "title-a", title: null }),
      makeRow({ id: "title-b", title: null }),
    ];
    const nullBody = [
      makeRow({ id: "body-a", content: null }),
      makeRow({ id: "body-b", content: null }),
    ];
    const nullAgainstEmpty = [
      makeRow({ id: "null-title", title: null, content: "" }),
      makeRow({ id: "empty-title", title: "", content: "" }),
    ];

    expect(representativeLeadRows(nullTitle)).toHaveLength(2);
    expect(representativeLeadRows(nullBody)).toHaveLength(2);
    expect(representativeLeadRows(nullAgainstEmpty)).toHaveLength(2);
  });

  it("does not group empty or whitespace-only titles or bodies", () => {
    const cases = [
      [
        makeRow({ id: "empty-title-a", title: "", content: "A complete body." }),
        makeRow({ id: "empty-title-b", title: "", content: "A complete body." }),
      ],
      [
        makeRow({ id: "empty-body-a", title: "A complete title", content: "" }),
        makeRow({ id: "empty-body-b", title: "A complete title", content: "" }),
      ],
      [
        makeRow({ id: "blank-title-a", title: " \n\t ", content: "A complete body." }),
        makeRow({ id: "blank-title-b", title: " \n\t ", content: "A complete body." }),
      ],
      [
        makeRow({ id: "blank-body-a", title: "A complete title", content: " \n\t " }),
        makeRow({ id: "blank-body-b", title: "A complete title", content: " \n\t " }),
      ],
      [
        makeRow({ id: "blank-both-a", title: "   ", content: "\n" }),
        makeRow({ id: "blank-both-b", title: "", content: " \t " }),
      ],
    ];

    for (const rows of cases) {
      expect(representativeLeadRows(rows)).toHaveLength(2);
    }
  });

  it("groups case and whitespace differences and returns the winner unchanged", () => {
    const winner = Object.freeze(
      makeRow({
        id: "winner",
        title: "Looking   For\nA Tool",
        content: "We need\tqualified\n\nleads.",
        ai_score: 10,
        created_at: "2026-05-01T00:00:00.000Z",
        permalink: "https://reddit.com/winner",
        author: "winner_name",
        ai_match_type: "intent",
        ai_lead_summary: "Winner summary",
        ai_match_reason: "Winner reason",
      }),
    );
    const other = Object.freeze(
      makeRow({
        id: "other",
        title: "looking for a tool",
        content: "we need qualified leads.",
        ai_score: 6,
        created_at: "2026-01-01T00:00:00.000Z",
        permalink: "https://reddit.com/other",
        author: "other_name",
        ai_match_type: "pain",
        ai_lead_summary: "Other summary",
        ai_match_reason: "Other reason",
      }),
    );

    const [selected] = representativeLeadRows([other, winner]);

    expect(selected).toBe(winner);
    expect(selected.title).toBe("Looking   For\nA Tool");
    expect(selected.content).toBe("We need\tqualified\n\nleads.");
    expect(selected).toMatchObject({
      permalink: "https://reddit.com/winner",
      author: "winner_name",
      ai_score: 10,
      ai_match_type: "intent",
      ai_lead_summary: "Winner summary",
      ai_match_reason: "Winner reason",
    });
    expect(selected).not.toMatchObject({ permalink: "https://reddit.com/other" });
  });

  it("still groups complete titles and bodies that differ only by case or whitespace", () => {
    const older = makeRow({
      id: "older",
      title: "  Need a CRM  ",
      content: "Any\nrecommendations?",
      ai_score: 6,
    });
    const newer = makeRow({
      id: "newer",
      title: "need a crm",
      content: "any recommendations?",
      ai_score: 9,
    });

    const [selected] = representativeLeadRows([older, newer]);

    expect(selected).toBe(newer);
    expect(selected.title).toBe("need a crm");
    expect(selected.content).toBe("any recommendations?");
  });

  it("does not group punctuation or wording differences", () => {
    const plain = makeRow({ id: "plain", title: "Hello", content: "Need a tool." });
    const punctuated = makeRow({ id: "punctuated", title: "Hello!", content: "Need a tool." });
    const reworded = makeRow({ id: "reworded", title: "Hello", content: "Need a different tool." });

    expect(representativeLeadRows([plain, punctuated, reworded])).toHaveLength(3);
  });

  it("keeps a lower-score row when its higher-score duplicate is not in the set", () => {
    const partial = makeRow({ id: "partial", ai_score: 7 });

    expect(representativeLeadRows([partial])).toEqual([partial]);
  });
});

describe("selectDisplayedLeadRows", () => {
  it("orders representatives by their own fields and then applies the preview limit", () => {
    const duplicates = [1, 2, 3, 4].map((day) =>
      makeRow({
        id: `dup-${day}`,
        title: "Same post",
        content: "Same body",
        ai_score: day === 4 ? 9 : 6,
        created_at: `2026-07-0${day}T00:00:00.000Z`,
        item_created_at: `2026-09-0${day}T00:00:00.000Z`,
      }),
    );
    const others = [1, 2, 3, 4].map((day) =>
      makeRow({
        id: `other-${day}`,
        title: `Other ${day}`,
        content: `Body ${day}`,
        ai_score: 8,
        item_created_at: `2026-08-0${day}T00:00:00.000Z`,
      }),
    );

    const result = selectDisplayedLeadRows([...duplicates, ...others], { sort: "newest", limit: 4 });

    expect(result.map((row) => row.id)).toEqual(["dup-4", "other-4", "other-3", "other-2"]);
    expect(duplicates).toHaveLength(4);
    expect(others).toHaveLength(4);
  });

  it("sorts lowest score by the representative score, not a hidden lower duplicate", () => {
    const hidden = makeRow({
      id: "hidden",
      ai_score: 1,
      title: "Same",
      content: "Body",
      item_created_at: "2026-08-03T00:00:00.000Z",
    });
    const winner = makeRow({
      id: "winner",
      ai_score: 9,
      title: "Same",
      content: "Body",
      item_created_at: "2026-08-01T00:00:00.000Z",
    });
    const other = makeRow({
      id: "other",
      ai_score: 2,
      title: "Different",
      content: "Other body",
      item_created_at: "2026-08-02T00:00:00.000Z",
    });

    expect(selectDisplayedLeadRows([hidden, winner, other], { sort: "lowest_score" }).map((row) => row.id)).toEqual([
      "other",
      "winner",
    ]);
  });

  it("supports the existing newest, oldest, and highest-score orders", () => {
    const older = makeRow({
      id: "older",
      title: "Older title",
      content: "Older body",
      ai_score: 6,
      item_created_at: "2026-08-01T00:00:00.000Z",
    });
    const newer = makeRow({
      id: "newer",
      title: "Newer title",
      content: "Newer body",
      ai_score: 9,
      item_created_at: "2026-08-02T00:00:00.000Z",
    });

    expect(selectDisplayedLeadRows([older, newer], { sort: "newest" }).map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(selectDisplayedLeadRows([newer, older], { sort: "oldest" }).map((row) => row.id)).toEqual([
      "older",
      "newer",
    ]);
    expect(selectDisplayedLeadRows([older, newer], { sort: "highest_score" }).map((row) => row.id)).toEqual([
      "newer",
      "older",
    ]);
  });
});
