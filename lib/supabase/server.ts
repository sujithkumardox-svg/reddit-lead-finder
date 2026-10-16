import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseEnv } from "@/lib/supabase/env";
import { getOrCreateScanClient } from "@/lib/supabase/scan-client";

export async function createClient() {
  const scanClient = getOrCreateScanClient();
  if (scanClient) {
    return scanClient;
  }

  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll is called from Server Components; middleware will handle
          // session refresh during the authentication phase.
        }
      },
    },
  });
}
