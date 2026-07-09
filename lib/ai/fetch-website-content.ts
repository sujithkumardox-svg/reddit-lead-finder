import "server-only";

import * as cheerio from "cheerio";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 8_000;

export type WebsiteContent = {
  title: string;
  metaDescription: string;
  headings: string[];
  bodyText: string;
};

/**
 * Fetches a website and extracts a lightweight text summary (title, meta
 * description, headings, visible body text) for the AI prompt. Kept
 * deliberately simple for the MVP - no JS rendering, no crawling of linked
 * pages.
 */
export async function fetchWebsiteContent(url: string): Promise<WebsiteContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RedditLeadFinderBot/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`Website responded with status ${response.status}.`);
    }

    html = await response.text();
  } finally {
    clearTimeout(timeout);
  }

  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const title = $("title").first().text().trim();
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ??
    $('meta[property="og:description"]').attr("content")?.trim() ??
    "";

  const headings = $("h1, h2")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean)
    .slice(0, 20);

  const bodyText = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);

  if (!title && !metaDescription && !bodyText) {
    throw new Error("Could not extract any content from that website.");
  }

  return { title, metaDescription, headings, bodyText };
}
