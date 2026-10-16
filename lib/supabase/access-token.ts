/**
 * Reads `sub` from a JWT payload. This does not verify the signature.
 * Callers must already have verified the user with the Auth server, and
 * database writes still send this same token so Postgres checks it.
 * Returns null when the token is malformed or already expired.
 */
export function readAccessTokenSubject(accessToken: string, nowMs: number = Date.now()): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}
