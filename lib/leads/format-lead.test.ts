import { describe, expect, it } from "vitest";

import { formatAiScore, formatSubreddit } from "@/lib/leads/format-lead";

describe("formatAiScore", () => {
  it("renders integer scores with one decimal place", () => {
    expect(formatAiScore(8)).toBe("8.0");
    expect(formatAiScore(9)).toBe("9.0");
  });

  it("renders a perfect score as 🌟 10.0", () => {
    expect(formatAiScore(10)).toBe("🌟 10.0");
  });
});

describe("formatSubreddit", () => {
  it("prefixes r/ when missing", () => {
    expect(formatSubreddit("SaaS")).toBe("r/SaaS");
    expect(formatSubreddit("r/SaaS")).toBe("r/SaaS");
  });
});
