/**
 * Pure URL helpers for the AI onboarding flow. No AI calls here - the
 * project name is deterministically derived from the domain, per the
 * confirmed architecture decision (auto-derive from website domain).
 */

export function normalizeWebsiteUrl(rawInput: string): string {
  const trimmed = rawInput.trim();

  if (!trimmed) {
    throw new Error("Website URL is required.");
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("Invalid website URL.");
  }

  if (!url.hostname.includes(".")) {
    throw new Error("Invalid website URL.");
  }

  return url.toString();
}

export function deriveProjectNameFromUrl(websiteUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(websiteUrl).hostname;
  } catch {
    return websiteUrl;
  }

  const withoutWww = hostname.replace(/^www\./i, "");
  const secondLevelDomain = withoutWww.split(".")[0] ?? withoutWww;

  const words = secondLevelDomain
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.length > 0 ? words.join(" ") : withoutWww;
}
