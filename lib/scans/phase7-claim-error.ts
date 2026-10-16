/**
 * The Phase 7 write was rejected because the request was not an authorized
 * owner write. This includes row-level security `42501` and a rejected user
 * JWT. Callers must not retry it and must not continue the scan as a success.
 */
export class Phase7ClaimAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Failed to claim the Phase 7 processing row.");
    this.name = "Phase7ClaimAuthError";
    this.code = code;
  }
}

export function isPhase7ClaimAuthError(error: unknown): error is Phase7ClaimAuthError {
  return error instanceof Phase7ClaimAuthError;
}

export function isPhase7AuthRejectionCode(code: string | undefined): boolean {
  return code === "42501" || code === "PGRST301" || code === "PGRST302";
}
