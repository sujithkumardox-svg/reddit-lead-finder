import { readAccessTokenSubject } from "@/lib/supabase/access-token";
import {
  isTransientAuthRateLimit,
  withTransientAuthRetry,
  type AuthAttempt,
} from "@/lib/supabase/auth-retry";

const SCAN_SIGNED_OUT = "You must be signed in to start a scan.";
const STATUS_SIGNED_OUT = "You must be signed in to view scan status.";
const RATE_LIMITED = "Authentication is temporarily rate limited. Please try again.";

type UserResult = AuthAttempt<{ user: { id: string } | null }>;
type SessionResult = AuthAttempt<{ session: { access_token?: string } | null }>;

export type ScanAuth = {
  getUser: () => Promise<UserResult>;
  getSession: () => Promise<SessionResult>;
};

export type ScanAccess =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; error: string };

/**
 * Verifies the user with the Auth server, then captures that same user's
 * access token for the scan. Retries only an Auth HTTP 429. A missing token,
 * a mismatched subject, or any permanent auth error does not start a scan.
 */
export async function resolveScanAccessToken(auth: ScanAuth): Promise<ScanAccess> {
  const userResult = await withTransientAuthRetry(() => auth.getUser());
  if (userResult.error && isTransientAuthRateLimit(userResult.error)) {
    return { ok: false, error: RATE_LIMITED };
  }
  const userId = userResult.data.user?.id;
  if (!userId) {
    return { ok: false, error: SCAN_SIGNED_OUT };
  }

  const sessionResult = await withTransientAuthRetry(() => auth.getSession());
  if (sessionResult.error && isTransientAuthRateLimit(sessionResult.error)) {
    return { ok: false, error: RATE_LIMITED };
  }
  const accessToken = sessionResult.data.session?.access_token;
  const subject = accessToken ? readAccessTokenSubject(accessToken) : null;
  if (!accessToken || !subject || subject !== userId) {
    return { ok: false, error: SCAN_SIGNED_OUT };
  }

  return { ok: true, userId, accessToken };
}

export type PollingAuth = {
  getSession: () => Promise<SessionResult>;
};

export type PollingAccess =
  | { ok: true; userId: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * Identifies the polling user from the session access token without calling
 * `getUser()`. Middleware already performs that Auth API check for protected
 * routes. Ownership is still enforced by the project query and row-level
 * security. A 429 is returned as retryable and is not retried here.
 */
export async function resolvePollingUserId(auth: PollingAuth): Promise<PollingAccess> {
  const sessionResult = await auth.getSession();
  if (sessionResult.error && isTransientAuthRateLimit(sessionResult.error)) {
    return { ok: false, error: RATE_LIMITED, retryable: true };
  }
  const accessToken = sessionResult.data.session?.access_token;
  const subject = accessToken ? readAccessTokenSubject(accessToken) : null;
  if (!subject) {
    return { ok: false, error: STATUS_SIGNED_OUT, retryable: false };
  }
  return { ok: true, userId: subject };
}
