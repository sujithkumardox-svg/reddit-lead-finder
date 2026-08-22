import { describe, expect, it } from "vitest";

import {
  getCompletedScanRedirect,
  getProjectDashboardPath,
  getScanProgressLabel,
} from "@/lib/scans/scan-progress";

describe("completion redirect behavior", () => {
  it("redirects to the project dashboard only when the scan completed", () => {
    expect(getCompletedScanRedirect("project-1", "completed")).toBe(
      "/projects/project-1/dashboard",
    );
    expect(getProjectDashboardPath("project-1")).toBe("/projects/project-1/dashboard");
  });

  it("does not redirect while scanning, scoring, failed, or not started", () => {
    expect(getCompletedScanRedirect("project-1", "scanning")).toBeNull();
    expect(getCompletedScanRedirect("project-1", "scoring")).toBeNull();
    expect(getCompletedScanRedirect("project-1", "failed")).toBeNull();
    expect(getCompletedScanRedirect("project-1", "not_started")).toBeNull();
  });
});

describe("getScanProgressLabel", () => {
  it("uses Scoring leads for Gemini qualification, not Phase 8", () => {
    expect(getScanProgressLabel("scoring")).toBe("Scoring leads");
    expect(getScanProgressLabel("scanning")).toBe("Finding your leads");
    expect(getScanProgressLabel("failed")).toBe("Scan failed");
  });
});
