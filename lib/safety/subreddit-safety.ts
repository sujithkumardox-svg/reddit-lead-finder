import "server-only";

import { fetchSubredditRules } from "@/lib/reddit/reddit-rules";
import type { RawSubredditRule } from "@/lib/reddit/reddit-rules";
import type { SubredditSafetyResult } from "@/types/reddit-leads";

/**
 * Rule-based (no AI) subreddit safety classifier (Phase 10 - approved
 * plan). Looks only at whether a subreddit's actual posted rules mention
 * promotion/self-promotion/advertising, and if so, whether that mention is
 * an outright ban or a conditional allowance. This is a heuristic over
 * rule text, not a guarantee - it can be refined later without any schema
 * change, since `explanation` is always free text.
 *
 * Exactly three badges, per the locked Phase 10 decision:
 *   - "without_rules": no rules at all, or no rule mentions promotion.
 *   - "promo_conditional": a rule mentions promotion but allows it under
 *     conditions (mod approval, flair, specific days, a posting ratio,
 *     etc.).
 *   - "promo_not_safe": a rule explicitly bans promotion outright.
 */

const PROMOTION_KEYWORDS = [
  "self-promotion",
  "self promotion",
  "selfpromo",
  "self-promo",
  "promotion",
  "promote",
  "promoting",
  "advertising",
  "advertisement",
  "advertise",
  "spam",
  "marketing",
];

const CONDITIONAL_PATTERNS = [
  "allowed with",
  "allowed if",
  "allowed on",
  "with mod",
  "with moderator",
  "mod approval",
  "moderator approval",
  "with permission",
  "flair required",
  "requires flair",
  "certain days",
  "specific day",
  "9:1",
  "90/10",
  "90-10",
  "ratio",
  "limited to",
  "once a",
  "once per",
  "no more than",
];

const BAN_PATTERNS = [
  "no self-promotion",
  "no self promotion",
  "no selfpromo",
  "no promotion",
  "no promoting",
  "no advertising",
  "no advertisement",
  "not allowed",
  "is not permitted",
  "prohibited",
  "will be banned",
  "will result in a ban",
  "strictly forbidden",
  "not permitted",
];

function ruleText(rule: RawSubredditRule): string {
  return `${rule.short_name ?? ""} ${rule.description ?? ""}`.toLowerCase();
}

function mentionsPromotion(text: string): boolean {
  return PROMOTION_KEYWORDS.some((keyword) => text.includes(keyword));
}

function isOutrightBan(text: string): boolean {
  return BAN_PATTERNS.some((pattern) => text.includes(pattern));
}

function isConditional(text: string): boolean {
  return CONDITIONAL_PATTERNS.some((pattern) => text.includes(pattern));
}

/** Pure classifier: no network access, no caching. See `getSubredditSafety` for the fetch+cache wrapper. */
export function classifySubredditSafety(rules: RawSubredditRule[]): SubredditSafetyResult {
  if (rules.length === 0) {
    return {
      badge: "without_rules",
      explanation: "This subreddit has no posted rules.",
    };
  }

  const promotionRules = rules.filter((rule) => mentionsPromotion(ruleText(rule)));

  if (promotionRules.length === 0) {
    return {
      badge: "without_rules",
      explanation: "This subreddit's rules do not mention promotion, self-promotion, or advertising.",
    };
  }

  const bannedRule = promotionRules.find((rule) => isOutrightBan(ruleText(rule)));
  if (bannedRule) {
    return {
      badge: "promo_not_safe",
      explanation: `Rule "${bannedRule.short_name}" explicitly bans promotion: ${bannedRule.description}`,
    };
  }

  const conditionalRule = promotionRules.find((rule) => isConditional(ruleText(rule)));
  if (conditionalRule) {
    return {
      badge: "promo_conditional",
      explanation: `Rule "${conditionalRule.short_name}" allows promotion only under certain conditions: ${conditionalRule.description}`,
    };
  }

  // A rule mentions promotion but the text doesn't clearly signal an
  // outright ban or an explicit condition - default to the more cautious
  // "conditional" badge rather than assuming it's safe.
  const firstPromotionRule = promotionRules[0];
  return {
    badge: "promo_conditional",
    explanation: `Rule "${firstPromotionRule.short_name}" mentions promotion: ${firstPromotionRule.description}`,
  };
}

/**
 * Fetches and classifies a subreddit's safety, caching the result in the
 * given `cache` so repeat lookups for the same subreddit never trigger a
 * second Reddit API call. Callers that want "fetched once per worker run"
 * behavior (the approved Phase 10 decision) create one `Map` per run and
 * pass it into every call - e.g. `runGeminiQualificationWorker` in
 * `services/gemini-qualification-worker.ts`. This is a plain in-memory
 * `Map`, not a database cache - it only lives for as long as the caller
 * keeps a reference to it.
 */
export async function getSubredditSafety(
  subreddit: string,
  cache: Map<string, SubredditSafetyResult>,
): Promise<SubredditSafetyResult> {
  const cached = cache.get(subreddit);
  if (cached) {
    return cached;
  }

  const rules = await fetchSubredditRules(subreddit);
  const result = classifySubredditSafety(rules);
  cache.set(subreddit, result);
  return result;
}
