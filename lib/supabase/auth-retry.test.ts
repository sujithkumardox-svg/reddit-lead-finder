import { describe, expect, it, vi } from "vitest";

import {
  AUTH_RATE_LIMIT_BASE_DELAY_MS,
  authRetryDelayMs,
  isTransientAuthRateLimit,
  withTransientAuthRetry,
} from "@/lib/supabase/auth-retry";

describe("isTransientAuthRateLimit", () => {
  it("matches an Auth HTTP 429", () => {
    expect(
      isTransientAuthRateLimit({
        status: 429,
        code: "over_request_rate_limit",
        message: "Request rate limit reached",
      }),
    ).toBe(true);
  });

  it("does not match RLS 42501 or a permanent auth failure", () => {
    expect(isTransientAuthRateLimit({ code: "42501", message: "new row violates row-level security policy" })).toBe(
      false,
    );
    expect(isTransientAuthRateLimit({ status: 401, code: "bad_jwt" })).toBe(false);
    expect(isTransientAuthRateLimit({ status: 403, code: "insufficient_privilege" })).toBe(false);
    expect(isTransientAuthRateLimit(null)).toBe(false);
  });
});

describe("authRetryDelayMs", () => {
  it("doubles the wait and adds jitter", () => {
    expect(authRetryDelayMs(1, () => 0)).toBe(AUTH_RATE_LIMIT_BASE_DELAY_MS);
    expect(authRetryDelayMs(1, () => 0.5)).toBe(AUTH_RATE_LIMIT_BASE_DELAY_MS + 125);
    expect(authRetryDelayMs(2, () => 0)).toBe(AUTH_RATE_LIMIT_BASE_DELAY_MS * 2);
  });
});

describe("withTransientAuthRetry", () => {
  it("retries an Auth 429 with backoff and then returns the successful result", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi
      .fn()
      .mockResolvedValueOnce({
        data: { user: null },
        error: { status: 429, code: "over_request_rate_limit" },
      })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { status: 429, code: "over_request_rate_limit" },
      })
      .mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const result = await withTransientAuthRetry(operation, { sleep, random: () => 0 });

    expect(result.data).toEqual({ user: { id: "user-1" } });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, AUTH_RATE_LIMIT_BASE_DELAY_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, AUTH_RATE_LIMIT_BASE_DELAY_MS * 2);
  });

  it("does not retry a 401 or an RLS 42501", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const unauthorized = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 401, code: "bad_jwt" },
    });
    const rls = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "new row violates row-level security policy" },
    });

    await withTransientAuthRetry(unauthorized, { sleep, random: () => 0 });
    await withTransientAuthRetry(rls, { sleep, random: () => 0 });

    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(rls).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the bounded number of 429 responses", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const operation = vi.fn().mockResolvedValue({
      data: { user: null },
      error: { status: 429, code: "over_request_rate_limit" },
    });

    const result = await withTransientAuthRetry(operation, { sleep, random: () => 0, maxAttempts: 3 });

    expect(result.error?.status).toBe(429);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
