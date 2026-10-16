import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseEnv } from "@/lib/supabase/env";

type ScanStore = {
  accessToken: string;
  client: SupabaseClient | null;
};

const scanStore = new AsyncLocalStorage<ScanStore>();

/**
 * One Supabase client for the current scan. The user JWT is sent on every
 * request via the `accessToken` option, which does not fall back to the
 * publishable key and does not refresh the session. The client is created
 * on first use and reused for every later call in this async context.
 * A different scan, user, or request has its own context.
 */
export function createScanSupabaseClient(accessToken: string): SupabaseClient {
  const token = accessToken.trim();
  if (!token) {
    throw new Error("Missing scan access token.");
  }

  const { url, anonKey } = getSupabaseEnv();
  return createClient(url, anonKey, {
    accessToken: async () => token,
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function getOrCreateScanClient(): SupabaseClient | null {
  const store = scanStore.getStore();
  if (!store) {
    return null;
  }
  if (!store.client) {
    store.client = createScanSupabaseClient(store.accessToken);
  }
  return store.client;
}

/**
 * Runs `fn` with a scan-scoped client bound to `accessToken`.
 * The token is a string captured for this invocation; it is not stored
 * globally and is not visible to other concurrent scans.
 */
export function runWithScanAccessToken<T>(accessToken: string, fn: () => Promise<T>): Promise<T> {
  const token = accessToken.trim();
  if (!token) {
    return Promise.reject(new Error("Missing scan access token."));
  }
  return scanStore.run({ accessToken: token, client: null }, fn);
}
