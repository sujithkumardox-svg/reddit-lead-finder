import { describe, expect, it } from "vitest";

import { isCompletedScanReadyToNavigate } from "@/lib/scans/dashboard-navigation";

/**
 * Regression coverage for the post-scan dashboard-redirect guard used by
 * the "Finding Your Leads" polling effect in `NewProjectWizard`. See
 * `actions/scans.test.ts` / `lib/scans/scan-progress.test.ts` for coverage
 * confirming `dashboardPath` itself is already lead-count independent -
 * these tests cover the one-shot navigation guard added on top of that.
 */
describe("isCompletedScanReadyToNavigate", () => {
  it("navigates once a scan completes with 0 leads found", () => {
    // `leadsFound` is never a parameter of this function at all - a scan
    // with 0 leads produces the exact same (non-null) dashboardPath as
    // one with leads, so this call is indistinguishable from the 1+
    // leads case below by design.
    expect(
      isCompletedScanReadyToNavigate("completed", "/projects/project-1/dashboard", false),
    ).toBe(true);
  });

  it("navigates once a scan completes with 1+ leads found", () => {
    expect(
      isCompletedScanReadyToNavigate("completed", "/projects/project-1/dashboard", false),
    ).toBe(true);
  });

  it("does not navigate again for a repeated 'completed' poll of the same scan", () => {
    // Simulates a redundant poll (already in flight, or an interval tick
    // that fired before the effect could clean itself up) still
    // observing "completed" after navigation has already happened once.
    expect(
      isCompletedScanReadyToNavigate("completed", "/projects/project-1/dashboard", true),
    ).toBe(false);
  });

  it("does not navigate for a failed scan", () => {
    expect(isCompletedScanReadyToNavigate("failed", null, false)).toBe(false);
  });

  it("does not navigate while still scanning or scoring", () => {
    expect(isCompletedScanReadyToNavigate("scanning", null, false)).toBe(false);
    expect(isCompletedScanReadyToNavigate("scoring", null, false)).toBe(false);
  });

  it("does not navigate if completed but no dashboard path was provided", () => {
    expect(isCompletedScanReadyToNavigate("completed", null, false)).toBe(false);
  });
});
