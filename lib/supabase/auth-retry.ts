/** Auth API results that are safe to retry. RLS `42501` is never an auth result here. */
export type AuthAttemptError = {
  status?: number;
  code?: string;
  message?: string;
};

export type AuthAttempt<T> = {
  data: T;
  error: AuthAttemptError | null;
};

/** Three attempts total: the first call plus two retries. */
export const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 3;

/** First wait is one base interval; each later wait doubles, then adds jitter. */
export const AUTH_RATE_LIMIT_BASE_DELAY_MS = 250;

/**
 * True only for a transient Auth HTTP 429. Permanent auth failures
 * (`401`, `403`, invalid credentials) and database RLS `42501` are not
 * retryable.
 */
export function isTransientAuthRateLimit(error: unknown): error is AuthAttemptError {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as AuthAttemptError;
  return candidate.status === 429;
}

/** Exponential delay plus up to one base interval of jitter. `failedAttempt` starts at 1. */
export function authRetryDelayMs(failedAttempt: number, random: () => number = Math.random): number {
  const exponential = AUTH_RATE_LIMIT_BASE_DELAY_MS * 2 ** (failedAttempt - 1);
  const jitter = Math.floor(random() * AUTH_RATE_LIMIT_BASE_DELAY_MS);
  return exponential + jitter;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retries an Auth API call only while it returns HTTP 429.
 * Stops immediately on success, on a non-429 error, or after
 * `AUTH_RATE_LIMIT_MAX_ATTEMPTS`.
 */
export async function withTransientAuthRetry<T>(
  operation: () => Promise<AuthAttempt<T>>,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    maxAttempts?: number;
  },
): Promise<AuthAttempt<T>> {
  const maxAttempts = options?.maxAttempts ?? AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  const sleep = options?.sleep ?? delay;
  const random = options?.random ?? Math.random;

  let result = await operation();
  for (let failedAttempt = 1; failedAttempt < maxAttempts; failedAttempt++) {
    if (!result.error || !isTransientAuthRateLimit(result.error)) {
      return result;
    }
    await sleep(authRetryDelayMs(failedAttempt, random));
    result = await operation();
  }
  return result;
}
