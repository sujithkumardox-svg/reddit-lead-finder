import { afterEach, describe, expect, it } from "vitest";

import { getOrCreateScanClient, runWithScanAccessToken } from "@/lib/supabase/scan-client";

const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIGINAL_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function useTestSupabaseEnv(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_key";
}

afterEach(() => {
  if (ORIGINAL_URL === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL;
  }
  if (ORIGINAL_KEY === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ORIGINAL_KEY;
  }
});

describe("runWithScanAccessToken", () => {
  it("reuses one client inside a scan and does not expose it outside that scan", async () => {
    useTestSupabaseEnv();

    let inside: unknown;
    let again: unknown;
    await runWithScanAccessToken("user-a-access-token", async () => {
      inside = getOrCreateScanClient();
      again = getOrCreateScanClient();
    });

    expect(inside).toBe(again);
    expect(getOrCreateScanClient()).toBeNull();
    const scoped = inside as unknown as { accessToken: () => Promise<string> };
    await expect(scoped.accessToken()).resolves.toBe("user-a-access-token");
  });

  it("keeps concurrent scans on separate clients and tokens", async () => {
    useTestSupabaseEnv();

    const [first, second] = await Promise.all([
      runWithScanAccessToken("token-user-a", async () => {
        await Promise.resolve();
        return getOrCreateScanClient();
      }),
      runWithScanAccessToken("token-user-b", async () => {
        await Promise.resolve();
        return getOrCreateScanClient();
      }),
    ]);

    expect(first).not.toBe(second);
    const clientA = first as unknown as { accessToken: () => Promise<string> };
    const clientB = second as unknown as { accessToken: () => Promise<string> };
    await expect(clientA.accessToken()).resolves.toBe("token-user-a");
    await expect(clientB.accessToken()).resolves.toBe("token-user-b");
  });

  it("rejects a missing token before creating a client", async () => {
    useTestSupabaseEnv();

    await expect(runWithScanAccessToken("   ", async () => getOrCreateScanClient())).rejects.toThrow(
      "Missing scan access token.",
    );
    expect(getOrCreateScanClient()).toBeNull();
  });
});
