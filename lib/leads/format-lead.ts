/** Formats an integer 0-10 AI score for Phase 11 display. */
export function formatAiScore(score: number): string {
  const display = Number(score).toFixed(1);
  if (score === 10) {
    return `🌟 ${display}`;
  }
  return display;
}

export function formatSubreddit(subreddit: string): string {
  const trimmed = subreddit.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("r/") ? trimmed : `r/${trimmed}`;
}

export function formatLeadCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function localDayIsoBounds(day: Date): { from: string; to: string } {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(day);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}
