import { describe, expect, it } from "vitest";

import { readAccessTokenSubject } from "@/lib/supabase/access-token";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("readAccessTokenSubject", () => {
  const nowMs = Date.parse("2026-10-14T12:00:00.000Z");

  it("returns the subject of an unexpired token", () => {
    const token = fakeJwt({ sub: "user-1", exp: Math.floor(nowMs / 1000) + 60 });
    expect(readAccessTokenSubject(token, nowMs)).toBe("user-1");
  });

  it("rejects an expired, malformed, or subject-less token", () => {
    const expired = fakeJwt({ sub: "user-1", exp: Math.floor(nowMs / 1000) - 1 });
    expect(readAccessTokenSubject(expired, nowMs)).toBeNull();
    expect(readAccessTokenSubject("not-a-jwt", nowMs)).toBeNull();
    expect(readAccessTokenSubject(fakeJwt({ exp: Math.floor(nowMs / 1000) + 60 }), nowMs)).toBeNull();
  });
});
