/**
 * The Gemini result is already stored, but saving the qualified lead failed.
 * The queue row is pending again so a later worker can retry the save
 * without calling Gemini. This scan must not be reported as successful.
 */
export class QualifiedLeadPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualifiedLeadPersistError";
  }
}

export function isQualifiedLeadPersistError(error: unknown): error is QualifiedLeadPersistError {
  return error instanceof QualifiedLeadPersistError;
}
