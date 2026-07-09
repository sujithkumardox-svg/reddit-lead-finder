/**
 * Public-safe project shape. Never includes `hiddenKeywords` or
 * `hiddenSubreddits` - those only ever live in services/projects.ts and the
 * database, for use by the (future) Reddit scanning engine.
 */
export type Project = {
  id: string;
  name: string;
  websiteUrl: string;
  description: string;
  keywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSummary = Pick<
  Project,
  "id" | "name" | "websiteUrl" | "description" | "isActive" | "createdAt"
>;

/**
 * Full AI analysis output for a website, including the fields that are
 * never rendered in the UI (hiddenKeywords, hiddenSubreddits).
 */
export type WebsiteAnalysis = {
  description: string;
  keywords: string[];
  hiddenKeywords: string[];
  intentPhrases: string[];
  painPhrases: string[];
  competitors: string[];
  hiddenSubreddits: string[];
};

/**
 * In-memory draft held by the Create Project wizard between the "Analyzing"
 * and "Review" steps. Carries the hidden fields through client state (they
 * are required to create the project) even though the review UI never
 * displays or lets the user edit them.
 */
export type ProjectDraft = WebsiteAnalysis & {
  name: string;
  websiteUrl: string;
};
